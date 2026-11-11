import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { appErrorToResponse } from "@/lib/http";
import { INVITATION_COOKIE } from "@/lib/invitations";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * "Not now" on the invitation page (ADR-0138): the invitation stops waiting
 * in this browser and the organizations page opens. The invitation itself
 * stays pending, and its emailed link still opens it.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "An invitation must be put aside from this site"));
  }
  const response = NextResponse.redirect(new URL("/", request.url), { status: 303 });
  response.cookies.delete(INVITATION_COOKIE);
  return response;
}
