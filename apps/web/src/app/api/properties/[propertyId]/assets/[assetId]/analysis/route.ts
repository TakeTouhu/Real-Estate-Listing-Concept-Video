import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { requireAssetInProperty } from "@/lib/asset-route";
import { getCurrentUser } from "@/lib/auth";
import { getAnalysisService, toAnalysisDto } from "@/lib/analysis";
import { appErrorToResponse } from "@/lib/http";
import { isSameOriginPost } from "@/lib/same-origin";
import { getIdentityServices } from "@/lib/identity";
import { getRateLimiter, limitJsonRequest } from "@/lib/rate-limit";
import { requireOrganizationId, requireOrganizationIdFromQuery } from "@/lib/request";

export const dynamic = "force-dynamic";

/**
 * Start (or return) the analysis for one asset.
 *
 * Thin adapter: validate, authenticate, delegate, map. Idempotency, READY-only
 * eligibility, authorization and audit all live in AnalysisService.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ propertyId: string; assetId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request, "POST /api/properties/[propertyId]/assets/[assetId]/analysis")) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A photo must be analyzed from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return appErrorToResponse(new AppError("UNAUTHENTICATED", "Sign in required"));
  const { propertyId, assetId } = await context.params;

  try {
    const organizationId = await requireOrganizationId(request);
    // Counted by the account after the body is checked, before the photo is looked up or analyzed, and never given
    // back; analyses and refreshes share one limit (ADR-0173 Decisions 3 and 4).
    await limitJsonRequest(getRateLimiter, "ANALYSIS", current.user.id, getIdentityServices().deps.clock.now());
    await requireAssetInProperty(current.user.id, organizationId, propertyId, assetId);
    const analysis = await getAnalysisService().analyzeAsset(
      current.user.id,
      organizationId,
      assetId,
    );
    return NextResponse.json(toAnalysisDto(analysis));
  } catch (error) {
    return appErrorToResponse(error, "POST /api/properties/[propertyId]/assets/[assetId]/analysis");
  }
}

/** Read one asset's analysis. A member holding `property.view` may read. */
export async function GET(
  request: Request,
  context: { params: Promise<{ propertyId: string; assetId: string }> },
): Promise<NextResponse> {
  const current = await getCurrentUser();
  if (!current) return appErrorToResponse(new AppError("UNAUTHENTICATED", "Sign in required"));
  const { propertyId, assetId } = await context.params;

  try {
    const organizationId = requireOrganizationIdFromQuery(request);
    await requireAssetInProperty(current.user.id, organizationId, propertyId, assetId);
    const analysis = await getAnalysisService().getForAsset(
      current.user.id,
      organizationId,
      assetId,
    );
    return NextResponse.json(toAnalysisDto(analysis));
  } catch (error) {
    return appErrorToResponse(error, "GET /api/properties/[propertyId]/assets/[assetId]/analysis");
  }
}
