import { NextResponse } from "next/server";
import { getSignIn, nextPageFor } from "@/lib/auth";
import { sendVerificationLinkTo, verifyEmailPage } from "@/lib/email-verification";

export const dynamic = "force-dynamic";

/**
 * Mail a new verification link to the address of a sign-in that has not
 * verified it (ADR-0129). An earlier link keeps working (ADR-0128 Decision 3).
 * Any other sign-in goes where it belongs; no sign-in goes to the sign-in page.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const signIn = await getSignIn();
  if (!signIn) return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  if (signIn.step !== "EMAIL_VERIFICATION_REQUIRED") {
    return NextResponse.redirect(new URL(nextPageFor(signIn.step), request.url), { status: 303 });
  }
  const sent = await sendVerificationLinkTo(signIn.user.id);
  if (sent === "ALREADY_VERIFIED") return NextResponse.redirect(new URL("/", request.url), { status: 303 });
  return NextResponse.redirect(verifyEmailPage(request.url, sent === "SENT" ? "sent" : "not-sent"), { status: 303 });
}
