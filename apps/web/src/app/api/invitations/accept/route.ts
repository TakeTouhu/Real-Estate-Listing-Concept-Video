import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { appErrorToResponse, formOf, formString } from "@/lib/http";
import {
  INVITATION_COOKIE,
  acceptInvitationAs,
  acceptInvitationPage,
  invitationCookieOptions,
  isInvitationToken,
  joinedPage,
  keepsInvitationWaiting,
} from "@/lib/invitations";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Accept an invitation (ADR-0138): its token comes from the page its link
 * opens, else from the invitation waiting in this browser. With no complete
 * sign-in, the invitation waits and the sign-in page opens, which sends a
 * sign-in that owes a step on to it; the organizations page brings the
 * invitation back once signed in. Signed in, the membership service decides
 * (ADR-0137): the answer is the organizations page naming the organization
 * joined, or the invitation page with a fixed code, never the invited
 * address. The invitation stops waiting unless this browser can still accept
 * it.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "An invitation must be accepted from this site"));
  }
  const form = await formOf(request);
  const token = formString(form, "token") || ((await cookies()).get(INVITATION_COOKIE)?.value ?? "");
  if (!isInvitationToken(token)) return answer(acceptInvitationPage(request.url, "invalid"), null);
  const current = await getCurrentUser();
  if (!current) return answer(new URL("/login", request.url), token);
  const outcome = await acceptInvitationAs(current.user.id, token);
  if ("joined" in outcome) return answer(joinedPage(request.url, outcome.joined), null);
  const waiting = keepsInvitationWaiting(outcome.error) ? token : null;
  return answer(acceptInvitationPage(request.url, outcome.error), waiting);
}

/** A 303 to `location`, leaving `waiting` in the browser, or no invitation. */
function answer(location: URL, waiting: string | null): NextResponse {
  const response = NextResponse.redirect(location, { status: 303 });
  if (waiting === null) response.cookies.delete(INVITATION_COOKIE);
  else response.cookies.set(INVITATION_COOKIE, waiting, invitationCookieOptions());
  return response;
}
