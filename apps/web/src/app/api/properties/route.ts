import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { PROPERTY_TYPES, type PropertyType } from "@app/domain";
import { getCurrentUser } from "@/lib/auth";
import { getPropertyServices } from "@/lib/property";
import { appErrorToResponse, formString, redirectWithError } from "@/lib/http";

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

export async function POST(request: Request): Promise<NextResponse> {
  const current = await getCurrentUser();
  if (!current) return NextResponse.redirect(new URL("/login", request.url), { status: 303 });

  const form = await request.formData();
  const organizationId = formString(form, "organizationId");
  const rawType = formString(form, "propertyType");
  const propertyType = (PROPERTY_TYPES as readonly string[]).includes(rawType)
    ? (rawType as PropertyType)
    : "OTHER";

  try {
    const property = await getPropertyServices().properties.create(current.user.id, {
      organizationId,
      name: formString(form, "name"),
      propertyType,
      addressMasked: formString(form, "addressMasked") || null,
      description: formString(form, "description") || null,
      rightsConfirmed: form.get("rightsConfirmed") !== null,
    });
    return NextResponse.redirect(new URL(`/properties/${property.id}`, request.url), { status: 303 });
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Could not create property";
    return redirectWithError(request.url, "/", message);
  }
}
