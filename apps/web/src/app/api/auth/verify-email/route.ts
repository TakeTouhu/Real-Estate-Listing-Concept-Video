import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getEmailVerificationService, verifyEmailPage } from "@/lib/email-verification";
import { appErrorToResponse, formString } from "@/lib/http";
import { seeOther } from "@/lib/redirect";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Open a verification link (ADR-0128 Decision 4, ADR-0129): the token, posted
 * from the verify page's button, is the proof, so no sign-in is needed. Every
 * link that verifies nothing gets the same answer.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginPost(request, "POST /api/auth/verify-email")) {
    return appErrorToResponse(new AppError("FORBIDDEN", "An email address must be verified from this site"));
  }
  const form = await request.formData();
  const outcome = await getEmailVerificationService().verifyEmail(formString(form, "token"));
  const notice = outcome === "INVALID" ? "invalid" : "verified";
  return seeOther(verifyEmailPage(notice));
}
