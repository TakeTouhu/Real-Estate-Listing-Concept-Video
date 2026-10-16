import { NextResponse } from "next/server";
import { mfaRoute } from "@/lib/mfa";

export const dynamic = "force-dynamic";

/** Replace the recovery codes. The new ones are shown only in this response. */
export async function POST(): Promise<NextResponse> {
  return mfaRoute(async ({ session }, mfa) =>
    NextResponse.json({ recoveryCodes: await mfa.regenerateRecoveryCodes(session) }),
  );
}
