import { AppError } from "@app/shared";
import { effectiveRoomType } from "../analysis/effective";
import type { AssetAnalysis, RoomType } from "../analysis/types";

/**
 * One analysis admitted to composition.
 *
 * A deliberately narrow projection: composition may depend on these four facts
 * and nothing else, so a later change to `AssetAnalysis` cannot quietly widen
 * what a storyboard is built from.
 */
export interface EligibleInput {
  readonly assetId: string;
  readonly analysisRevision: number;
  /**
   * The **effective** room classification — the reviewer's correction where one
   * exists, otherwise the analyzer's (ADR-0015). Since Phase 3D-3 this is not
   * necessarily `AssetAnalysis.roomType`, and composition must not reach past
   * this projection to find the analyzer's original.
   */
  readonly roomType: RoomType | null;
  /**
   * The reviewer's sort priority, lower first, or null when they set none.
   *
   * A **global** priority rather than an absolute position: it competes with
   * the automatic room rank rather than pinning a photo to an index, and
   * duplicate values across photos are legitimate. How it competes is
   * `orderScenes`'s contract (ADR-0015).
   */
  readonly orderOverride: number | null;
  /** The analyzer's suggested rank; a tiebreaker for ordering in Phase 3C-2b. */
  readonly suggestedOrder: number | null;
}

/**
 * Select the analyses a storyboard may be composed from: succeeded **and**
 * approved, sorted by `assetId` so the result is stable regardless of input
 * order.
 *
 * Approval is the whole filter. An `UNREVIEWED` or `REJECTED` analysis is never
 * admitted — not even to reach a scene count — because a storyboard that
 * included one would put an unreviewed AI decision into a generated video.
 *
 * Duplicate suppression needs no logic here: the partial unique index
 * `(organizationId, duplicateGroup) WHERE reviewStatus = 'APPROVED'` already
 * guarantees at most one approved member per group. This function therefore
 * *checks* that invariant rather than re-implementing it — if two approved
 * members of one group ever reach this layer, the database guarantee has been
 * violated somewhere, and picking a winner in application code would paper over
 * a real defect. Several approved analyses with no duplicate group are ordinary
 * and always valid.
 *
 * No minimum is enforced: 0, 1, and 2 eligible analyses are all representable
 * results. The minimum-scene rule belongs to composition (Phase 3C-2b).
 *
 * @throws AppError VALIDATION_FAILED when one duplicate group holds two
 *   approved analyses.
 */
export function selectEligibleAnalyses(
  analyses: readonly AssetAnalysis[],
): readonly EligibleInput[] {
  const eligible = analyses.filter(
    (a) => a.status === "SUCCEEDED" && a.reviewStatus === "APPROVED",
  );

  const seenGroups = new Set<string>();
  for (const analysis of eligible) {
    const group = analysis.duplicateGroup;
    if (!group) continue;
    if (seenGroups.has(group)) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Two approved analyses share one duplicate group; the storyboard input set is inconsistent",
      );
    }
    seenGroups.add(group);
  }

  // The one place a human correction enters composition. Everything downstream
  // — ordering, the fingerprint, the service — reads `EligibleInput` and never
  // learns that overrides exist (ADR-0015). Provenance stays out deliberately:
  // composition has no use for who corrected a photo or when.
  return eligible
    .map((a) => ({
      assetId: a.assetId,
      analysisRevision: a.analysisRevision,
      roomType: effectiveRoomType(a),
      orderOverride: a.orderOverride,
      suggestedOrder: a.suggestedOrder,
    }))
    .sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
}
