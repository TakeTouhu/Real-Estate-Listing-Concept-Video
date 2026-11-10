import { NextResponse } from "next/server";
import { formOf, formString } from "@/lib/http";
import { askForResetLink, resetPasswordPage } from "@/lib/password-reset";

export const dynamic = "force-dynamic";

/**
 * Ask for a password reset link (ADR-0131, ADR-0133). The answer is the same
 * whether or not an account uses the address, and whatever went wrong, so the
 * page cannot be used to find accounts.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const form = await formOf(request);
  await askForResetLink(formString(form, "email"));
  return NextResponse.redirect(resetPasswordPage(request.url, "sent"), { status: 303 });
}
