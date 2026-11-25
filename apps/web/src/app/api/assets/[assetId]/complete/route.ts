import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import { getPropertyServices } from "@/lib/property";
import { appErrorToResponse } from "@/lib/http";
import { isSameOriginPost } from "@/lib/same-origin";
import { getRateLimiter, limitJsonRequest } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Step 2 of the upload flow: validate and process the uploaded bytes
 * (content MIME, limits, malware scan, EXIF strip, thumbnail, perceptual hash).
 *
 * Look-alike photos are internal data only (ADR-0052 Decision 14), so the
 * response never says which existing photos this one resembles.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ assetId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request, "POST /api/assets/[assetId]/complete")) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A photo's upload must be completed from this site"));
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
    const { asset } = await getPropertyServices().assets.completeUpload(
      current.user.id,
      organizationId,
      assetId,
    );
    return NextResponse.json({
      assetId: asset.id,
      status: asset.status,
      failureReason: asset.failureReason,
      width: asset.width,
      height: asset.height,
    });
  } catch (error) {
    return appErrorToResponse(error);
  }
}
