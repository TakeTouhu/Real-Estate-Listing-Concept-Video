import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { grantGroupPermission, groupsPage } from "@/lib/groups";
import { appErrorToResponse, formOf, formString } from "@/lib/http";
import { seeOther } from "@/lib/redirect";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Give a group a permission, which each of its members then holds, from the
 * groups page (ADR-0148). Field: `permission`. The group service decides
 * (`permission.manage`, the grant ceiling for the viewer and for every
 * member's role) and audits it (ADR-0061). The answer is the groups page with
 * a fixed notice or error.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string; groupId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A group's permissions must be changed from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return seeOther("/login");
  const { organizationId, groupId } = await context.params;
  const form = await formOf(request);
  const outcome = await grantGroupPermission(current.user.id, organizationId, groupId, formString(form, "permission"));
  return seeOther(groupsPage(organizationId, outcome));
}
