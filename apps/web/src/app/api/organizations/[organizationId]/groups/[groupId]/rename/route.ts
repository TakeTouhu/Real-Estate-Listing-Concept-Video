import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { groupsPage, renameGroup } from "@/lib/groups";
import { appErrorToResponse, formOf, formString } from "@/lib/http";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Rename a group, from the groups page (ADR-0142). Fields: `name`, and
 * `from`, the name the page showed. The group service decides
 * (`group.manage`, the name, the group still named as shown) and audits it
 * (ADR-0060). The answer is the groups page with a fixed notice or error:
 * never a name.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string; groupId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A group must be renamed from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  const { organizationId, groupId } = await context.params;
  const form = await formOf(request);
  const outcome = await renameGroup(current.user.id, organizationId, groupId, {
    name: formString(form, "name"),
    from: formString(form, "from"),
  });
  return NextResponse.redirect(groupsPage(request.url, organizationId, outcome), { status: 303 });
}
