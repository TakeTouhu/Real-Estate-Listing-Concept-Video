import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { appErrorToResponse, formOf, formString } from "@/lib/http";
import { countInvitation, invitationFormRefusal, inviteMember, membersPage } from "@/lib/members";
import { seeOther } from "@/lib/redirect";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Invite an email address to the organization with a role, from the members
 * page (ADR-0136). Fields: `email` and `role`. The membership service decides
 * (`member.manage`, the role ceiling, the seats, one pending invitation per
 * address) and mails the link (ADR-0135). The answer is the members page with
 * a fixed notice or error: never the address, never the token. Each
 * invitation is counted per inviting account (ADR-0173); a refused one
 * answers `limited` with its wait, and a limiter that cannot answer,
 * `unavailable`.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "An invitation must be sent from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return seeOther("/login");
  const { organizationId } = await context.params;
  const form = await formOf(request);
  const invitation = { email: formString(form, "email"), role: formString(form, "role") };
  // Counted by the account once the session and the form's role are checked, before the membership service, and
  // never given back: a refusal keeps no invitation and sends no email (ADR-0173 Decisions 3, 4 and 9).
  const outcome =
    invitationFormRefusal(invitation) ??
    (await countInvitation(current.user.id)) ??
    (await inviteMember(current.user.id, organizationId, invitation));
  return seeOther(membersPage(organizationId, outcome));
}
