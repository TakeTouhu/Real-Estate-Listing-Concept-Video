import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { requireAssetInProperty } from "@/lib/asset-route";
import { getCurrentUser } from "@/lib/auth";
import { getAnalysisService, toAnalysisDto } from "@/lib/analysis";
import { appErrorToResponse } from "@/lib/http";
import { requireOrganizationId } from "@/lib/request";

export const dynamic = "force-dynamic";

/**
 * Recompute a completed analysis.
 *
 * A separate route rather than a flag on POST /analysis: re-running spends
 * provider work, so it should not be reachable by editing one parameter of an
 * ordinary retry.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ propertyId: string; assetId: string }> },
): Promise<NextResponse> {
  const current = await getCurrentUser();
  if (!current) return appErrorToResponse(new AppError("UNAUTHENTICATED", "Sign in required"));
  const { propertyId, assetId } = await context.params;

  try {
    const organizationId = await requireOrganizationId(request);
    await requireAssetInProperty(current.user.id, organizationId, propertyId, assetId);
    const analysis = await getAnalysisService().analyzeAsset(
      current.user.id,
      organizationId,
      assetId,
      { refresh: true },
    );
    return NextResponse.json(toAnalysisDto(analysis));
  } catch (error) {
    return appErrorToResponse(error);
  }
}
