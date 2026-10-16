import { NextResponse } from "next/server";
import { mfaRoute, readCode } from "@/lib/mfa";

export const dynamic = "force-dynamic";

/** Finish set-up with a first code. The recovery codes are shown only in this response. */
export async function POST(request: Request): Promise<NextResponse> {
  return mfaRoute(async ({ session }, mfa) => {
    const { recoveryCodes } = await mfa.confirmSetup(session, await readCode(request));
    return NextResponse.json({ recoveryCodes });
  });
}
