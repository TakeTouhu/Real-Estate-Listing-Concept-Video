import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import { appErrorToResponse, formString, redirectWithError } from "@/lib/http";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginPost(request, "POST /api/organizations")) {
    return appErrorToResponse(new AppError("FORBIDDEN", "An organization must be created from this site"));
  }
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  }
  const form = await request.formData();
  const name = formString(form, "name");
  try {
    await getIdentityServices().organizations.createOrganization(current.user.id, { name });
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Could not create organization";
    return redirectWithError(request.url, "/", message);
  }
  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}
