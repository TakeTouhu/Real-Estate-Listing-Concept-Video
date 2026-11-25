import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { appErrorToResponse, formOf, formString } from "@/lib/http";
import { grantMemberPermission, memberPermissionsPage } from "@/lib/member-permissions";
import { seeOther } from "@/lib/redirect";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Give a member a permission individually, from their permissions page
 * (ADR-0147). Field: `permission`. The grant service decides
 * (`permission.manage`, the grant ceiling, what is withheld here) and audits
 * it (ADR-0058). The answer is that page with a fixed notice or error, or the
 * members page when there is no such member.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string; userId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A member's permissions must be changed from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return seeOther("/login");
  const { organizationId, userId } = await context.params;
  const form = await formOf(request);
  const outcome = await grantMemberPermission(current.user.id, organizationId, userId, formString(form, "permission"));
  return seeOther(memberPermissionsPage(organizationId, userId, outcome));
}
