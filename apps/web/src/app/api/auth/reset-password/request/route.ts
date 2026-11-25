import { NextResponse } from "next/server";
import { formOf, formString } from "@/lib/http";
import { askForLimitedResetLink, resetPasswordPage } from "@/lib/password-reset";

export const dynamic = "force-dynamic";

/**
 * Ask for a password reset link (ADR-0131, ADR-0133). The answer is the same
 * whether or not an account uses the address, and whatever went wrong, so the
 * page cannot be used to find accounts. A request a limit refuses, counted
 * before any lookup, is answered `limited` with its wait, the same for every
 * address (ADR-0172).
 */
export async function POST(request: Request): Promise<NextResponse> {
  const form = await formOf(request);
  const wait = await askForLimitedResetLink(request.headers, formString(form, "email"));
  const page = wait === null ? resetPasswordPage(request.url, "sent") : resetPasswordPage(request.url, "limited", wait);
  return NextResponse.redirect(page, { status: 303 });
}
