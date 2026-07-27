import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import { formString, redirectWithError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
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
