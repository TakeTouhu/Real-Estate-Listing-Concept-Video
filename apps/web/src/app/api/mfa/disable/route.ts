import { NextResponse } from "next/server";
import { mfaRoute, readCode } from "@/lib/mfa";

export const dynamic = "force-dynamic";

/** Turn MFA off with a current authenticator code; refused to anyone who must use it. */
export async function POST(request: Request): Promise<NextResponse> {
  return mfaRoute(async ({ session }, mfa) => {
    await mfa.disable(session, await readCode(request));
    return new NextResponse(null, { status: 204 });
  });
}
