import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { sendLimitedVerificationLinkTo, verifyEmailPage } from "@/lib/email-verification";
import { logRequestFailure } from "@/lib/failure-log";
import { getIdentityServices } from "@/lib/identity";
import { appErrorToResponse, formString, redirectWithError } from "@/lib/http";
import { getRateLimiter } from "@/lib/rate-limit";
import { seeOther } from "@/lib/redirect";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

const REGISTRATION_FAILED = "Registration failed";

/**
 * Sign-up: the account, a sign-in, and a verification link mailed to the
 * address (ADR-0129). The new sign-in waits on the verify page until the
 * address is verified. A link that could not be sent does not undo the
 * account: the verify page says so and sends another on request. The link
 * counts as the address's first verification email (ADR-0172); one a limit
 * refuses is not sent, and the verify page says when to ask again. Sign-up
 * itself is counted first, per client address (ADR-0173).
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginPost(request, "POST /api/auth/register")) {
    return appErrorToResponse(new AppError("FORBIDDEN", "An account must be created from this site"));
  }
  const services = getIdentityServices();
  // Counted before the form is read or any account looked up, and never given back; a limiter that cannot answer
  // refuses through this route's own answer, never its own text (ADR-0173 Decisions 2 and 9).
  try {
    const attempt = await getRateLimiter().signUp(request.headers, services.deps.clock.now());
    if (!attempt.allowed) return redirectWithError("/login", attempt.message);
  } catch (error) {
    logRequestFailure(error, "POST /api/auth/register");
    return redirectWithError("/login", REGISTRATION_FAILED);
  }
  const form = await request.formData();
  const email = formString(form, "email");
  const name = formString(form, "name");
  const password = formString(form, "password");
  let signedIn: { user: { id: string; email: string }; token: string };
  try {
    await services.auth.register({ email, name, password });
    const { user, token } = await services.auth.login(email, password);
    signedIn = { user, token };
  } catch (error) {
    logRequestFailure(error, "POST /api/auth/register");
    const message = error instanceof AppError ? error.message : REGISTRATION_FAILED;
    return redirectWithError("/login", message);
  }
  const sent = await sendLimitedVerificationLinkTo(signedIn.user);
  const next =
    typeof sent === "object"
      ? verifyEmailPage("limited", sent.waitMinutes)
      : verifyEmailPage(sent === "NOT_SENT" ? "not-sent" : undefined);
  const response = seeOther(next);
  response.cookies.set(SESSION_COOKIE, signedIn.token, sessionCookieOptions());
  return response;
}
