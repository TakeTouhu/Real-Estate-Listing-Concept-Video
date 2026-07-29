import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getAnalysisService, toAnalysisDto } from "@/lib/analysis";
import { appErrorToResponse } from "@/lib/http";
import { requireOrganizationIdFromQuery } from "@/lib/request";

export const dynamic = "force-dynamic";

/** List the analyses for a property's assets. Any organization member may read. */
export async function GET(
  request: Request,
  context: { params: Promise<{ propertyId: string }> },
): Promise<NextResponse> {
  const current = await getCurrentUser();
  if (!current) return appErrorToResponse(new AppError("UNAUTHENTICATED", "Sign in required"));
  const { propertyId } = await context.params;

  try {
    const organizationId = requireOrganizationIdFromQuery(request);
    const analyses = await getAnalysisService().listForProperty(
      current.user.id,
      organizationId,
      propertyId,
    );
    return NextResponse.json({ analyses: analyses.map(toAnalysisDto) });
  } catch (error) {
    return appErrorToResponse(error);
  }
}
