import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { SESSION_COOKIE, getSignIn, nextPageFor } from "@/lib/auth";
import { appErrorToResponse, formString, redirectWithError } from "@/lib/http";
import { getIdentityServices } from "@/lib/identity";
import { getMfaService } from "@/lib/mfa";
import { getRateLimiter, withoutLimiterText } from "@/lib/rate-limit";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * The second sign-in step: an authenticator code or a recovery code
 * (ADR-0065 Decision 12). A sign-in that has ended, by five wrong codes or
 * otherwise, goes back to the password. Wrong codes are also limited per
 * user across sign-ins (ADR-0171).
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginPost(request, "POST /api/auth/mfa")) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A sign-in code must be entered from this site"));
  }
  const signIn = await getSignIn();
  if (!signIn) return backToPassword(request, "Sign in again");
  if (signIn.step !== "CODE_REQUIRED") {
    return NextResponse.redirect(new URL(nextPageFor(signIn.step), request.url), { status: 303 });
  }
  const form = await request.formData();
  try {
    const mfa = getMfaService();
    // Counted per user before the code is checked; a refusal keeps the sign-in and its own five (ADR-0171 Decision 2).
    // A limiter that cannot answer refuses in this route's own words (ADR-0173 Decision 9).
    const now = getIdentityServices().deps.clock.now();
    const attempt = await withoutLimiterText(getRateLimiter().mfaCode(signIn.user.id, now));
    if (!attempt.allowed) return redirectWithError(request.url, "/login/mfa", attempt.message);
    await mfa.verify(signIn.session, formString(form, "code"));
    await withoutLimiterText(attempt.succeeded());
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
