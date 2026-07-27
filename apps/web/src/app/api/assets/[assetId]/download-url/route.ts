import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getPropertyServices } from "@/lib/property";
import { appErrorToResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Issue a short-lived signed download/preview URL for a READY asset. */
export async function GET(
  request: Request,
  context: { params: Promise<{ assetId: string }> },
): Promise<NextResponse> {
  const current = await getCurrentUser();
  if (!current) return appErrorToResponse(new AppError("UNAUTHENTICATED", "Sign in required"));
  const { assetId } = await context.params;
  const params = new URL(request.url).searchParams;
  const organizationId = params.get("organizationId");
  const variant = params.get("variant") === "thumbnail" ? "thumbnail" : "normalized";
  if (!organizationId) {
    return appErrorToResponse(new AppError("VALIDATION_FAILED", "organizationId is required"));
  }

  try {
    const url = await getPropertyServices().assets.createDownloadUrl(
      current.user.id,
      organizationId,
      assetId,
      variant,
    );
    return NextResponse.json({ url: url.url, expiresAt: url.expiresAt.toISOString() });
  } catch (error) {
    return appErrorToResponse(error);
  }
}
