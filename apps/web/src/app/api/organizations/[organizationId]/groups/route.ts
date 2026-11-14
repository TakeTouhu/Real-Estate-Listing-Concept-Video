import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { createGroup, groupsPage } from "@/lib/groups";
import { appErrorToResponse, formOf, formString } from "@/lib/http";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Create a group, from the groups page (ADR-0141). Field: `name`. The group
 * service decides (`group.manage`, the name) and audits it (ADR-0060). The
 * answer is the groups page with a fixed notice or error: never the name.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A group must be created from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  const { organizationId } = await context.params;
  const form = await formOf(request);
  const outcome = await createGroup(current.user.id, organizationId, { name: formString(form, "name") });
  return NextResponse.redirect(groupsPage(request.url, organizationId, outcome), { status: 303 });
}
