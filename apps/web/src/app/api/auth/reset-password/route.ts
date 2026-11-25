import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { appErrorToResponse, formOf, formString } from "@/lib/http";
import { resetPasswordPage, resetPasswordWith } from "@/lib/password-reset";
import { seeOther } from "@/lib/redirect";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Choose a new password with a reset link (ADR-0132, ADR-0133): the token,
 * posted from the reset page's form, is the proof, so no sign-in is needed.
 * Every link that resets nothing gets the same answer, and the redirect never
 * carries the token.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginPost(request, "POST /api/auth/reset-password")) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A new password must be chosen from this site"));
  }
  const form = await formOf(request);
  const notice = await resetPasswordWith(formString(form, "token"), formString(form, "password"));
  return seeOther(resetPasswordPage(notice));
}
