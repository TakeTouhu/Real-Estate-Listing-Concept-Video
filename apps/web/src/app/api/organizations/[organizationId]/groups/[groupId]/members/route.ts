import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { addGroupMember, groupsPage } from "@/lib/groups";
import { appErrorToResponse, formOf, formString } from "@/lib/http";
import { seeOther } from "@/lib/redirect";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Add a member of the organization to a group, from the groups page
 * (ADR-0143). Field: `userId`. The group service decides (`group.manage`, the
 * role-assignment ceiling on the member's role, the grant ceiling of what the
 * group gives) and audits it (ADR-0060, ADR-0061). The answer is the groups
 * page with a fixed notice or error: never a name.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string; groupId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A group's member must be added from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return seeOther("/login");
  const { organizationId, groupId } = await context.params;
  const form = await formOf(request);
  const userId = formString(form, "userId");
  const outcome = await addGroupMember(current.user.id, organizationId, groupId, { userId });
  return seeOther(groupsPage(organizationId, outcome));
}
