import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getSignIn, nextPageFor } from "@/lib/auth";
import { sendLimitedVerificationLinkTo, verifyEmailPage } from "@/lib/email-verification";
import { appErrorToResponse } from "@/lib/http";
import { seeOther } from "@/lib/redirect";
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
  if (!signIn) return seeOther("/login");
  if (signIn.step !== "EMAIL_VERIFICATION_REQUIRED") {
    return seeOther(nextPageFor(signIn.step));
  }
  const sent = await sendLimitedVerificationLinkTo(signIn.user);
  if (sent === "ALREADY_VERIFIED") return seeOther("/");
  if (typeof sent === "object") {
    return seeOther(verifyEmailPage("limited", sent.waitMinutes));
  }
  return seeOther(verifyEmailPage(sent === "SENT" ? "sent" : "not-sent"));
}
