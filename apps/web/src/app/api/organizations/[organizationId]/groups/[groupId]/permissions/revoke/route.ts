import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { groupsPage, revokeGroupPermission } from "@/lib/groups";
import { appErrorToResponse, formOf, formString } from "@/lib/http";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Take a permission back from a group, from the groups page (ADR-0148).
 * Field: `permission`. The group service decides, as for giving, and audits
 * it (ADR-0061); a member keeps the permission only if their role, an
 * individual grant or another group gives it. The answer is the groups page
 * with a fixed notice or error.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string; groupId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A group's permissions must be changed from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  const { organizationId, groupId } = await context.params;
  const form = await formOf(request);
  const outcome = await revokeGroupPermission(current.user.id, organizationId, groupId, formString(form, "permission"));
  return NextResponse.redirect(groupsPage(request.url, organizationId, outcome), { status: 303 });
}
