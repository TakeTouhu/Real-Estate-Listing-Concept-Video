import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { sendLimitedVerificationLinkTo, verifyEmailPage } from "@/lib/email-verification";
import { getIdentityServices } from "@/lib/identity";
import { formString, redirectWithError } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Sign-up: the account, a sign-in, and a verification link mailed to the
 * address (ADR-0129). The new sign-in waits on the verify page until the
 * address is verified. A link that could not be sent does not undo the
 * account: the verify page says so and sends another on request. The link
 * counts as the address's first verification email (ADR-0172); one a limit
 * refuses is not sent, and the verify page says when to ask again.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const form = await request.formData();
  const email = formString(form, "email");
  const name = formString(form, "name");
  const password = formString(form, "password");
  const services = getIdentityServices();
  let signedIn: { user: { id: string; email: string }; token: string };
  try {
    await services.auth.register({ email, name, password });
    const { user, token } = await services.auth.login(email, password);
    signedIn = { user, token };
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Registration failed";
    return redirectWithError(request.url, "/login", message);
  }
  const sent = await sendLimitedVerificationLinkTo(signedIn.user);
  const next =
    typeof sent === "object"
      ? verifyEmailPage(request.url, "limited", sent.waitMinutes)
      : verifyEmailPage(request.url, sent === "NOT_SENT" ? "not-sent" : undefined);
  const response = NextResponse.redirect(next, { status: 303 });
  response.cookies.set(SESSION_COOKIE, signedIn.token, sessionCookieOptions());
  return response;
}
