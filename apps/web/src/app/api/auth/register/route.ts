import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { sendVerificationLinkTo, verifyEmailPage } from "@/lib/email-verification";
import { getIdentityServices } from "@/lib/identity";
import { formString, redirectWithError } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Sign-up: the account, a sign-in, and a verification link mailed to the
 * address (ADR-0129). The new sign-in waits on the verify page until the
 * address is verified. A link that could not be sent does not undo the
 * account: the verify page says so and sends another on request.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const form = await request.formData();
  const email = formString(form, "email");
  const name = formString(form, "name");
  const password = formString(form, "password");
  const services = getIdentityServices();
  let signedIn: { userId: string; token: string };
  try {
    await services.auth.register({ email, name, password });
    const { user, token } = await services.auth.login(email, password);
    signedIn = { userId: user.id, token };
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Registration failed";
    return redirectWithError(request.url, "/login", message);
  }
  const sent = await sendVerificationLinkTo(signedIn.userId);
  const next = verifyEmailPage(request.url, sent === "NOT_SENT" ? "not-sent" : undefined);
  const response = NextResponse.redirect(next, { status: 303 });
  response.cookies.set(SESSION_COOKIE, signedIn.token, sessionCookieOptions());
  return response;
}
