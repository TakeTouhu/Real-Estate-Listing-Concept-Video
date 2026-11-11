import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { appErrorToResponse, formOf, formString } from "@/lib/http";
import { changeMemberRole, membersPage } from "@/lib/members";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Give a member another role, from the members page (ADR-0139). Fields:
 * `role`, and `from`, the role the page showed. The membership service decides
 * (`permission.manage`, the ceiling of the role held and of the new one, the
 * role still the one shown, the last `OWNER`) and audits it (ADR-0057,
 * ADR-0059). The answer is the members page with a fixed notice or error.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string; userId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A member's role must be changed from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  const { organizationId, userId } = await context.params;
  const form = await formOf(request);
  const outcome = await changeMemberRole(current.user.id, organizationId, userId, {
    role: formString(form, "role"),
    from: formString(form, "from"),
  });
  return NextResponse.redirect(membersPage(request.url, organizationId, outcome), { status: 303 });
}
