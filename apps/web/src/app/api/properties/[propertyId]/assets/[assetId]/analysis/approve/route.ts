import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { requireAssetInProperty } from "@/lib/asset-route";
import { getCurrentUser } from "@/lib/auth";
import { getAnalysisService, toAnalysisDto } from "@/lib/analysis";
import { appErrorToResponse } from "@/lib/http";
import { optionalString, readJsonBody } from "@/lib/request";

export const dynamic = "force-dynamic";

/**
 * Approve one analysis revision.
 *
 * Thin adapter. Whether a blocking finding bars approval, whether the revision
 * was already reviewed, whether `primaryAssetId` is required for this asset's
 * duplicate group, and whether another member already holds the approval are
 * all decided by AnalysisService and the database constraint behind it.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ propertyId: string; assetId: string }> },
): Promise<NextResponse> {
  const current = await getCurrentUser();
  if (!current) return appErrorToResponse(new AppError("UNAUTHENTICATED", "Sign in required"));
  const { propertyId, assetId } = await context.params;

  try {
    const { organizationId, body } = await readJsonBody(request);
    await requireAssetInProperty(current.user.id, organizationId, propertyId, assetId);
    const analysis = await getAnalysisService().approve(
      current.user.id,
      organizationId,
      assetId,
      {
        primaryAssetId: optionalString(body, "primaryAssetId"),
        reason: optionalString(body, "reason"),
      },
    );
    return NextResponse.json(toAnalysisDto(analysis));
  } catch (error) {
    return appErrorToResponse(error);
  }
}
