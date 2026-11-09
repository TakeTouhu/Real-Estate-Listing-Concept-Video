import { NextResponse } from "next/server";
import { getEmailVerificationService, verifyEmailPage } from "@/lib/email-verification";
import { formString } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Open a verification link (ADR-0128 Decision 4, ADR-0129): the token, posted
 * from the verify page's button, is the proof, so no sign-in is needed. Every
 * link that verifies nothing gets the same answer.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const form = await request.formData();
  const outcome = await getEmailVerificationService().verifyEmail(formString(form, "token"));
  const notice = outcome === "INVALID" ? "invalid" : "verified";
  return NextResponse.redirect(verifyEmailPage(request.url, notice), { status: 303 });
}
