import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { logRequestFailure } from "@/lib/failure-log";
import { getIdentityServices } from "@/lib/identity";
import { appErrorToResponse, formString, redirectWithError } from "@/lib/http";
import { seeOther } from "@/lib/redirect";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginPost(request, "POST /api/organizations")) {
    return appErrorToResponse(new AppError("FORBIDDEN", "An organization must be created from this site"));
  }
  const current = await getCurrentUser();
  if (!current) {
    return seeOther("/login");
  }
  const form = await request.formData();
  const name = formString(form, "name");
  try {
    await getIdentityServices().organizations.createOrganization(current.user.id, { name });
  } catch (error) {
    logRequestFailure(error, "POST /api/organizations");
    const message = error instanceof AppError ? error.message : "Could not create organization";
    return redirectWithError("/", message);
  }
  return seeOther("/");
}
