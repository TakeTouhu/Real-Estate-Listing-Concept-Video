import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { SESSION_COOKIE, getSignIn } from "@/lib/auth";
import { formString, redirectWithError } from "@/lib/http";
import { getMfaService } from "@/lib/mfa";

export const dynamic = "force-dynamic";

/**
 * The second sign-in step: an authenticator code or a recovery code
 * (ADR-0065 Decision 12). A sign-in that has ended, by five wrong codes or
 * otherwise, goes back to the password.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const signIn = await getSignIn();
  if (!signIn) return backToPassword(request, "Sign in again");
  if (signIn.step === "SIGNED_IN") return NextResponse.redirect(new URL("/", request.url), { status: 303 });
  const form = await request.formData();
  try {
    await getMfaService().verify(signIn.session, formString(form, "code"));
    return NextResponse.redirect(new URL("/", request.url), { status: 303 });
  } catch (error) {
    if (!(error instanceof AppError)) return redirectWithError(request.url, "/login/mfa", "Sign in failed");
    if (error.code === "UNAUTHENTICATED") return backToPassword(request, error.message);
    const left = error.details?.attemptsLeft;
    const message = typeof left === "number" ? `${error.message}. Attempts left: ${left}` : error.message;
    return redirectWithError(request.url, "/login/mfa", message);
  }
}

function backToPassword(request: Request, message: string): NextResponse {
  const response = redirectWithError(request.url, "/login", message);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
