import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getSignIn, nextPageFor } from "@/lib/auth";
import { sendLimitedVerificationLinkTo, verifyEmailPage } from "@/lib/email-verification";
import { appErrorToResponse } from "@/lib/http";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Mail a new verification link to the address of a sign-in that has not
 * verified it (ADR-0129). An earlier link keeps working (ADR-0128 Decision 3).
 * Any other sign-in goes where it belongs; no sign-in goes to the sign-in page.
 * Each send is counted by the address first (ADR-0172).
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginPost(request, "POST /api/auth/verify-email/resend")) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A verification link must be asked for from this site"));
  }
  const signIn = await getSignIn();
  if (!signIn) return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  if (signIn.step !== "EMAIL_VERIFICATION_REQUIRED") {
    return NextResponse.redirect(new URL(nextPageFor(signIn.step), request.url), { status: 303 });
  }
  const sent = await sendLimitedVerificationLinkTo(signIn.user);
  if (sent === "ALREADY_VERIFIED") return NextResponse.redirect(new URL("/", request.url), { status: 303 });
  if (typeof sent === "object") {
    return NextResponse.redirect(verifyEmailPage(request.url, "limited", sent.waitMinutes), { status: 303 });
  }
  return NextResponse.redirect(verifyEmailPage(request.url, sent === "SENT" ? "sent" : "not-sent"), { status: 303 });
}
