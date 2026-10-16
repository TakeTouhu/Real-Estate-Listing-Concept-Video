import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import { formString, redirectWithError } from "@/lib/http";

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
  const current = await getCurrentUser();
  if (!current) return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  const { organizationId } = await context.params;
  const required = formString(await request.formData(), "required");
  if (required !== "true" && required !== "false") {
    return redirectWithError(request.url, "/", "Choose whether to require MFA");
  }
  try {
    await getIdentityServices().organizations.setMfaRequirement(current.user.id, organizationId, required === "true");
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Could not change the MFA requirement";
    return redirectWithError(request.url, "/", message);
  }
  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}
