import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { appErrorToResponse } from "@/lib/http";
import { cancelMemberInvitation, membersPage } from "@/lib/members";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Cancel a pending invitation, from the members page (ADR-0136). The
 * membership service decides (`member.manage`, the ceiling of the invited
 * role, an invitation of this organization still pending) and audits it
 * (ADR-0135). The answer is the members page with a fixed notice or error.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string; invitationId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "An invitation must be cancelled from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  const { organizationId, invitationId } = await context.params;
  const outcome = await cancelMemberInvitation(current.user.id, organizationId, invitationId);
  return NextResponse.redirect(membersPage(request.url, organizationId, outcome), { status: 303 });
}
