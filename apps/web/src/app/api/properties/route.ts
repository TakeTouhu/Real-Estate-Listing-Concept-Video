import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { PROPERTY_TYPES, type PropertyType } from "@app/domain";
import { getCurrentUser } from "@/lib/auth";
import { getPropertyServices } from "@/lib/property";
import { appErrorToResponse, formOf, formString, redirectWithError } from "@/lib/http";
import { ASSIGNMENT_ID_MAX_LENGTH } from "@/lib/property-assignment";
import { seeOther } from "@/lib/redirect";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const current = await getCurrentUser();
  if (!current) return appErrorToResponse(new AppError("UNAUTHENTICATED", "Sign in required"));
  const organizationId = new URL(request.url).searchParams.get("organizationId");
  if (!organizationId) {
    return appErrorToResponse(new AppError("VALIDATION_FAILED", "organizationId is required"));
  }
  try {
    const properties = await getPropertyServices().properties.list(current.user.id, organizationId);
    return NextResponse.json({ properties });
  } catch (error) {
    return appErrorToResponse(error);
  }
}

/**
 * Create a Property from the home page's "Add a property" form. Fields:
 * `organizationId`, `name`, `propertyType`, `addressMasked`, `description`,
 * `rightsConfirmed`, and the assignment chosen (ADR-0145): `responsibleUserId`
 * and `groupId`, each empty for none chosen. The Property service decides what
 * the creator's role may choose, and audits a refusal. An id longer than any
 * this product makes is refused before the service is asked, so it never
 * reaches the audit log. An error is shown on the home page.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A Property must be created from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return seeOther("/login");

  const form = await formOf(request);
  const organizationId = formString(form, "organizationId");
  const rawType = formString(form, "propertyType");
  const propertyType = (PROPERTY_TYPES as readonly string[]).includes(rawType)
    ? (rawType as PropertyType)
    : "OTHER";
  const responsibleUserId = formString(form, "responsibleUserId");
  const groupId = formString(form, "groupId");
  if (responsibleUserId.length > ASSIGNMENT_ID_MAX_LENGTH) {
    const message = "The responsible user must be a member of this organization who is not BILLING";
    return redirectWithError("/", message);
  }
  if (groupId.length > ASSIGNMENT_ID_MAX_LENGTH) {
    return redirectWithError("/", "The group must be a group of this organization");
  }

  try {
    const property = await getPropertyServices().properties.create(current.user.id, {
      organizationId,
      name: formString(form, "name"),
      propertyType,
      addressMasked: formString(form, "addressMasked") || null,
      description: formString(form, "description") || null,
      rightsConfirmed: form.get("rightsConfirmed") !== null,
      ...(responsibleUserId === "" ? {} : { responsibleUserId }),
      ...(groupId === "" ? {} : { groupId }),
    });
    return seeOther(`/properties/${property.id}`);
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Could not create property";
    return redirectWithError("/", message);
  }
}
