import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getAnalysisService, toAnalysisDto } from "@/lib/analysis";
import { appErrorToResponse } from "@/lib/http";
import { optionalString, readJsonBody } from "@/lib/request";

export const dynamic = "force-dynamic";

/**
 * Reject one analysis revision, which also marks the asset REJECTED.
 *
 * Thin adapter. The reason is passed through as received: that it is *required*
 * and must be non-blank is a domain rule, enforced by AnalysisService, and
 * re-checking it here would duplicate the rule in two places.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ propertyId: string; assetId: string }> },
): Promise<NextResponse> {
  const current = await getCurrentUser();
  if (!current) return appErrorToResponse(new AppError("UNAUTHENTICATED", "Sign in required"));
  const { assetId } = await context.params;

  try {
    const { organizationId, body } = await readJsonBody(request);
    const analysis = await getAnalysisService().reject(
      current.user.id,
      organizationId,
      assetId,
      { reason: optionalString(body, "reason") ?? "" },
    );
    return NextResponse.json(toAnalysisDto(analysis));
  } catch (error) {
    return appErrorToResponse(error);
  }
}
