import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { appErrorToResponse, formOf, formString } from "@/lib/http";
import { askForLimitedResetLink, resetPasswordPage } from "@/lib/password-reset";
import { seeOther } from "@/lib/redirect";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Ask for a password reset link (ADR-0131, ADR-0133). The answer is the same
 * whether or not an account uses the address, and whatever went wrong, so the
 * page cannot be used to find accounts. A request a limit refuses, counted
 * before any lookup, is answered `limited` with its wait, the same for every
 * address (ADR-0172).
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginPost(request, "POST /api/auth/reset-password/request")) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A password reset link must be asked for from this site"));
  }
  const form = await formOf(request);
  const wait = await askForLimitedResetLink(request.headers, formString(form, "email"));
  const page = wait === null ? resetPasswordPage("sent") : resetPasswordPage("limited", wait);
  return seeOther(page);
}
