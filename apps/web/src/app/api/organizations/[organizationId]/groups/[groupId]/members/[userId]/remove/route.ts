import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { groupsPage, removeGroupMember } from "@/lib/groups";
import { appErrorToResponse } from "@/lib/http";
import { seeOther } from "@/lib/redirect";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Remove a member from a group, from the groups page (ADR-0143). No field.
 * The group service decides (`group.manage`, the role-assignment ceiling on
 * the member's role, the grant ceiling of what the group gave) and audits it
 * (ADR-0060, ADR-0061); the member stays in the organization. The answer is
 * the groups page with a fixed notice or error: never a name.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string; groupId: string; userId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A group's member must be removed from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return seeOther("/login");
  const { organizationId, groupId, userId } = await context.params;
  const outcome = await removeGroupMember(current.user.id, organizationId, groupId, userId);
  return seeOther(groupsPage(organizationId, outcome));
}
