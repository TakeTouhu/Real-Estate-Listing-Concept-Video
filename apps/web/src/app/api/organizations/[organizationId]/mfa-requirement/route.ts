import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { logRequestFailure } from "@/lib/failure-log";
import { getIdentityServices } from "@/lib/identity";
import { appErrorToResponse, formString, redirectWithError } from "@/lib/http";
import { seeOther } from "@/lib/redirect";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Require MFA of every member of the organization, or stop requiring it
 * (ADR-0065 Decision 18). Field `required`: `true` or `false`. Only an `OWNER`
 * or `ADMIN` may; the domain decides.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request, "POST /api/organizations/[organizationId]/mfa-requirement")) {
    return appErrorToResponse(new AppError("FORBIDDEN", "The MFA requirement must be changed from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return seeOther("/login");
  const { organizationId } = await context.params;
  const required = formString(await request.formData(), "required");
  if (required !== "true" && required !== "false") {
    return redirectWithError("/", "Choose whether to require MFA");
  }
  try {
    await getIdentityServices().organizations.setMfaRequirement(current.user.id, organizationId, required === "true");
  } catch (error) {
    logRequestFailure(error, "POST /api/organizations/[organizationId]/mfa-requirement");
    const message = error instanceof AppError ? error.message : "Could not change the MFA requirement";
    return redirectWithError("/", message);
  }
  return seeOther("/");
}
