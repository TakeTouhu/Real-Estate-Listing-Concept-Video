import { NextResponse } from "next/server";
import { mfaRoute, qrCodeDataUrl } from "@/lib/mfa";

export const dynamic = "force-dynamic";

/**
 * Start setting up an authenticator app, or moving MFA to a new one (ADR-0065).
 * Also open to a sign-in that must set MFA up before anything else.
 */
export async function POST(): Promise<NextResponse> {
  return mfaRoute(async ({ session }, mfa) => {
    const { secret, otpauthUri } = await mfa.beginSetup(session);
    return NextResponse.json({ secret, qrCode: await qrCodeDataUrl(otpauthUri) });
  }, { duringSetup: true });
}
