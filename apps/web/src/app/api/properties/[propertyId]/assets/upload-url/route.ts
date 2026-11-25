import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import { getPropertyServices } from "@/lib/property";
import { appErrorToResponse } from "@/lib/http";
import { getRateLimiter, limitJsonRequest } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

interface Body {
  readonly organizationId?: unknown;
  readonly filename?: unknown;
  readonly sizeBytes?: unknown;
}

/** Step 1 of the upload flow: reserve the asset and return a signed upload URL. */
export async function POST(
  request: Request,
  context: { params: Promise<{ propertyId: string }> },
): Promise<NextResponse> {
  const current = await getCurrentUser();
  if (!current) return appErrorToResponse(new AppError("UNAUTHENTICATED", "Sign in required"));
  const { propertyId } = await context.params;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return appErrorToResponse(new AppError("VALIDATION_FAILED", "Invalid JSON body"));
  }
  if (
    typeof body.organizationId !== "string" ||
    typeof body.filename !== "string" ||
    typeof body.sizeBytes !== "number" ||
    !Number.isFinite(body.sizeBytes) ||
    body.sizeBytes <= 0
  ) {
    return appErrorToResponse(
      new AppError("VALIDATION_FAILED", "organizationId, filename, and sizeBytes are required"),
    );
  }

  try {
    // Counted by the account after the body is checked, before the service, and never given back; upload links,
    // retries and checks share one limit (ADR-0173 Decisions 3 and 4).
    await limitJsonRequest(getRateLimiter, "UPLOAD", current.user.id, getIdentityServices().deps.clock.now());
    const { asset, upload } = await getPropertyServices().assets.requestUpload(current.user.id, {
      organizationId: body.organizationId,
      propertyId,
      originalFilename: body.filename,
      declaredSizeBytes: body.sizeBytes,
    });
    // Only the signed URL is returned — never the raw storage key.
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
