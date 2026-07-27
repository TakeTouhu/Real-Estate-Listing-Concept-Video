import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getPropertyServices } from "@/lib/property";
import { appErrorToResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Failed-upload recovery: re-issue a signed upload URL for the same asset. */
export async function POST(
  request: Request,
  context: { params: Promise<{ assetId: string }> },
): Promise<NextResponse> {
  const current = await getCurrentUser();
  if (!current) return appErrorToResponse(new AppError("UNAUTHENTICATED", "Sign in required"));
  const { assetId } = await context.params;

  let organizationId: unknown;
  try {
    ({ organizationId } = (await request.json()) as { organizationId?: unknown });
  } catch {
    return appErrorToResponse(new AppError("VALIDATION_FAILED", "Invalid JSON body"));
  }
  if (typeof organizationId !== "string") {
    return appErrorToResponse(new AppError("VALIDATION_FAILED", "organizationId is required"));
  }

  try {
    const { asset, upload } = await getPropertyServices().assets.retryUpload(
      current.user.id,
      organizationId,
      assetId,
    );
    return NextResponse.json({
      assetId: asset.id,
      status: asset.status,
      uploadUrl: upload.url,
      expiresAt: upload.expiresAt.toISOString(),
    });
  } catch (error) {
    return appErrorToResponse(error);
  }
}
