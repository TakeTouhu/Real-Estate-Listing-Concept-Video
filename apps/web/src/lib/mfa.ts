import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { MfaService, createMfaSecretCipher, systemMfaRandom } from "@app/domain";
import { AppError } from "@app/shared";
import { getSignIn, type CurrentUser } from "./auth";
import { getServerEnv } from "./env";
import { appErrorToResponse } from "./http";
import { getIdentityServices } from "./identity";
import { requiredString } from "./request";

/**
 * The MFA service (ADR-0065). Without `MFA_SECRET_KEY` it fails closed: no
 * set-up starts and no code is checked, so someone with MFA on cannot finish
 * signing in until the key is configured.
 */
export function getMfaService(): MfaService {
  const key = getServerEnv().MFA_SECRET_KEY;
  if (!key) throw new AppError("CONFIGURATION_ERROR", "MFA is not available right now");
  const { deps } = getIdentityServices();
  return new MfaService({
    repos: deps.repos,
    clock: deps.clock,
    cipher: createMfaSecretCipher(key),
    random: systemMfaRandom,
  });
}

/** The set-up QR code as an SVG data URL, drawn on the server so the browser loads no QR library. */
export async function qrCodeDataUrl(text: string): Promise<string> {
  const svg = await QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** The `code` field of a JSON body. */
export async function readCode(request: Request): Promise<string> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AppError("VALIDATION_FAILED", "Invalid JSON body");
  }
  return requiredString((body ?? {}) as Record<string, unknown>, "code");
}

export interface MfaRouteOptions {
  /** Also serve a sign-in that must set MFA up before anything else (ADR-0065 Decision 15). */
  readonly duringSetup?: boolean;
}

/**
 * Run an MFA JSON route for the signed-in user. Its responses carry secrets or
 * recovery codes, so none may be cached.
 */
export async function mfaRoute(
  handler: (current: CurrentUser, mfa: MfaService) => Promise<NextResponse>,
  options: MfaRouteOptions = {},
): Promise<NextResponse> {
  let response: NextResponse;
  try {
    const signIn = await getSignIn();
    const allowed =
      signIn?.step === "SIGNED_IN" || (options.duringSetup === true && signIn?.step === "SETUP_REQUIRED");
    if (!signIn || !allowed) throw new AppError("UNAUTHENTICATED", "Sign in again");
    response = await handler({ user: signIn.user, session: signIn.session }, getMfaService());
  } catch (error) {
    response = appErrorToResponse(error);
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
