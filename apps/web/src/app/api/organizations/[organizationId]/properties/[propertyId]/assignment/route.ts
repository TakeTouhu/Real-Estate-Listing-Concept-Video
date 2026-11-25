import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { appErrorToResponse, formOf, formString } from "@/lib/http";
import { assignProperty, propertyPage } from "@/lib/property-assignment";
import { seeOther } from "@/lib/redirect";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Change a Property's responsible user and group, from the Property page
 * (ADR-0144). Fields: `responsibleUserId` and `groupId`, each empty for none,
 * and `shownResponsibleUserId` and `shownGroupId`, the assignment the page
 * showed. The Property service decides (the `OWNER` or `ADMIN` role, the
 * assignment still the one shown, each new choice) and audits it (ADR-0062).
 * The answer is the Property page with a fixed notice or error: never a name.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string; propertyId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A Property's assignment must be changed from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return seeOther("/login");
  const { organizationId, propertyId } = await context.params;
  const form = await formOf(request);
  const outcome = await assignProperty(current.user.id, organizationId, propertyId, {
    responsibleUserId: formString(form, "responsibleUserId"),
    groupId: formString(form, "groupId"),
    shownResponsibleUserId: formString(form, "shownResponsibleUserId"),
    shownGroupId: formString(form, "shownGroupId"),
  });
  return seeOther(propertyPage(propertyId, outcome));
}
