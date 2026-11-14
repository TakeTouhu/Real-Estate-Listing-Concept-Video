import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { deleteGroup, groupsPage } from "@/lib/groups";
import { appErrorToResponse } from "@/lib/http";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Delete a group, from the groups page (ADR-0142). The group service decides
 * (`group.manage` and the `OWNER` or `ADMIN` role, then the ceiling of what
 * the group gave its members), ungroups its Properties and audits it
 * (ADR-0052 Decision 11, ADR-0060, ADR-0062). The answer is the groups page
 * with a fixed notice or error.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string; groupId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A group must be deleted from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  const { organizationId, groupId } = await context.params;
  const outcome = await deleteGroup(current.user.id, organizationId, groupId);
  return NextResponse.redirect(groupsPage(request.url, organizationId, outcome), { status: 303 });
}
