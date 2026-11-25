import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import { getPropertyServices } from "@/lib/property";
import { appErrorToResponse } from "@/lib/http";
import { isSameOriginPost } from "@/lib/same-origin";
import { getRateLimiter, limitJsonRequest } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Failed-upload recovery: re-issue a signed upload URL for the same asset. */
export async function POST(
  request: Request,
  context: { params: Promise<{ assetId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request, "POST /api/assets/[assetId]/retry")) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A photo's upload must be retried from this site"));
  }
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
    // Counted by the account after the body is checked, before the service, and never given back; upload links,
    // retries and checks share one limit (ADR-0173 Decisions 3 and 4).
    await limitJsonRequest(getRateLimiter, "UPLOAD", current.user.id, getIdentityServices().deps.clock.now());
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
    return appErrorToResponse(error, "POST /api/assets/[assetId]/retry");
  }
}
