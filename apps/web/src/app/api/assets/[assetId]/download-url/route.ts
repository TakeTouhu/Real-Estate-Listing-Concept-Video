import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import { getPropertyServices } from "@/lib/property";
import { appErrorToResponse } from "@/lib/http";
import { getRateLimiter, limitJsonRequest } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Issue a short-lived signed download/preview URL for a READY asset. Each
 * request is counted per account with the video downloads, here and never in
 * the asset service, which page renders also call (ADR-0173 Decision 4).
 */
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
    // Counted after the session and the organization are checked, before any link is signed or audited, and never
    // given back; a refusal answers 429, a limiter that cannot answer the route's own 500 (ADR-0173).
    await limitJsonRequest(getRateLimiter, "DOWNLOAD", current.user.id, getIdentityServices().deps.clock.now());
    const url = await getPropertyServices().assets.createDownloadUrl(
      current.user.id,
      organizationId,
      assetId,
      variant,
    );
    return NextResponse.json({ url: url.url, expiresAt: url.expiresAt.toISOString() });
  } catch (error) {
    return appErrorToResponse(error, "GET /api/assets/[assetId]/download-url");
  }
}
