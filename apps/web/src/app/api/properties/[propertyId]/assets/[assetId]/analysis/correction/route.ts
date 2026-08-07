import { NextResponse } from "next/server";
import type { CorrectionField, RoomType } from "@app/domain";
import { AppError } from "@app/shared";
import { getAnalysisService, toAnalysisDto } from "@/lib/analysis";
import { requireAssetInProperty } from "@/lib/asset-route";
import { getCurrentUser } from "@/lib/auth";
import { appErrorToResponse } from "@/lib/http";
import { readJsonBody } from "@/lib/request";

export const dynamic = "force-dynamic";

/**
 * Translate one JSON field into the domain's correction representation.
 *
 * The three states are decided by **property presence**, never by truthiness:
 * `null` means "clear this override" and is a perfectly good value, so
 * `if (body.roomType)` would silently turn a deliberate clear into a
 * no-change. `key in body` is the whole distinction, and it is the only reason
 * this function exists.
 *
 * The value itself is passed through unvalidated: whether a string is a real
 * room type, and whether a number is an acceptable priority, are
 * `AnalysisService.correct`'s rules and are not repeated here.
 */
function correctionField<T>(
  body: Record<string, unknown>,
  key: string,
): CorrectionField<T> | undefined {
  return key in body ? { set: body[key] as T | null } : undefined;
}

/**
 * Correct the analyzer's room classification or set a scene order priority.
 *
 * Thin adapter. It authenticates, checks that the asset really belongs to the
 * property in the URL, maps JSON's omitted/null/value states onto
 * `CorrectionField`, and translates errors. Everything else — the room
 * vocabulary, the positive-integer priority rule, the empty-correction refusal,
 * the `SUCCEEDED` + `UNREVIEWED` lifecycle, `video:review`, tenant scoping,
 * provenance, no-op semantics and the audit event — is decided by
 * `AnalysisService.correct` and is deliberately not restated here.
 *
 * Responds with the same `AnalysisDto` the analysis reads and review decisions
 * return; there is no correction-specific response shape.
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

    // Spread only the fields the caller actually sent: an `undefined` property
    // would be *present* on the object, and the domain distinguishes present
    // from absent.
    const roomType = correctionField<RoomType>(body, "roomType");
    const order = correctionField<number>(body, "order");

    const analysis = await getAnalysisService().correct(
      current.user.id,
      organizationId,
      assetId,
      {
        ...(roomType ? { roomType } : {}),
        ...(order ? { order } : {}),
      },
    );
    return NextResponse.json(toAnalysisDto(analysis));
  } catch (error) {
    return appErrorToResponse(error);
  }
}
