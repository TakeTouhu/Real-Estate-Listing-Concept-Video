import { cookies } from "next/headers";
import { timingSafeEqualString } from "@app/shared";
import { mfaSignInStep, type MfaSignInStep, type Session, type User } from "@app/domain";
import { getServerEnv } from "./env";
import { getIdentityServices } from "./identity";

/** Cookie holding the raw user session token (only its hash is persisted). */
export const SESSION_COOKIE = "rev_session";

/**
 * Extract a bearer token from an Authorization header value.
 * Pure helper so it can be unit-tested without the Next runtime.
 */
export function bearerFrom(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Constant-time comparison of a presented token against the configured
 * operator token, used only by the infrastructure readiness probe.
 */
export function verifyOperatorToken(provided: string | undefined): boolean {
  if (!provided) return false;
  return timingSafeEqualString(provided, getServerEnv().HEALTHCHECK_API_TOKEN);
}

export interface SessionCookieOptions {
  readonly httpOnly: true;
  readonly sameSite: "lax";
  readonly secure: boolean;
  readonly path: string;
  readonly maxAge: number;
}

export function sessionCookieOptions(): SessionCookieOptions {
  const env = getServerEnv();
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: env.USER_SESSION_TTL_SECONDS,
  };
}

export interface CurrentUser {
  readonly user: User;
  readonly session: Session;
}

export interface SignIn extends CurrentUser {
  readonly step: MfaSignInStep;
}

/** The session cookie's sign-in, whether or not it has passed MFA, or null. */
export async function getSignIn(): Promise<SignIn | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const { auth, deps } = getIdentityServices();
  const current = await auth.resolveSession(token);
  if (!current) return null;
  return { ...current, step: await mfaSignInStep(deps, current.session) };
}

/** Where a sign-in goes next: its MFA code, MFA set-up, or in (ADR-0065 Decisions 12 and 15). */
export function nextPageFor(step: MfaSignInStep): string {
  switch (step) {
    case "CODE_REQUIRED":
      return "/login/mfa";
    case "SETUP_REQUIRED":
      return "/security";
    case "SIGNED_IN":
      return "/";
  }
}

/**
 * The signed-in user from the session cookie, or null. A sign-in that still
 * owes an MFA code, or must set MFA up first, is not signed in: every route and
 * page that needs a user comes through here, so none is reachable before that
 * step (ADR-0065 Decisions 12 and 15).
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const signIn = await getSignIn();
  return signIn?.step === "SIGNED_IN" ? { user: signIn.user, session: signIn.session } : null;
}
