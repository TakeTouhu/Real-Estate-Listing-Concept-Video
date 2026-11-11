import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { appErrorToResponse, formOf, formString } from "@/lib/http";
import { inviteMember, membersPage } from "@/lib/members";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Invite an email address to the organization with a role, from the members
 * page (ADR-0136). Fields: `email` and `role`. The membership service decides
 * (`member.manage`, the role ceiling, the seats, one pending invitation per
 * address) and mails the link (ADR-0135). The answer is the members page with
 * a fixed notice or error: never the address, never the token.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "An invitation must be sent from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  const { organizationId } = await context.params;
  const form = await formOf(request);
  const outcome = await inviteMember(current.user.id, organizationId, {
    email: formString(form, "email"),
    role: formString(form, "role"),
  });
  return NextResponse.redirect(membersPage(request.url, organizationId, outcome), { status: 303 });
}
