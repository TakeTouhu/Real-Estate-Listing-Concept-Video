import type { AssetAnalysis, RoomType } from "./types";

/**
 * The room classification that should actually be used: the reviewer's
 * correction when one exists, otherwise the analyzer's.
 *
 * This is the **only** place the two are resolved. Reading
 * `analysis.roomType` where the corrected value is meant is the mistake this
 * function exists to prevent — the analyzer's field is preserved output
 * (ADR-0015), not the current answer.
 *
 * Null is a real value on both sides: an analysis that produced no
 * classification and has no correction is genuinely unclassified, and callers
 * already handle that (it ranks last in the walkthrough sequence).
 */
export function effectiveRoomType(analysis: AssetAnalysis): RoomType | null {
  return analysis.roomTypeOverride ?? analysis.roomType;
}

/**
 * Whether a human has corrected anything on this analysis revision.
 *
 * Reads both override fields rather than `correctedBy`, so a row whose
 * corrections were cleared back to null is correctly reported as uncorrected
 * even if it was corrected earlier in the same revision.
 */
export function isCorrected(analysis: AssetAnalysis): boolean {
  return analysis.roomTypeOverride !== null || analysis.orderOverride !== null;
}

/**
 * There is deliberately **no** `effectiveOrder` helper.
 *
 * `orderOverride` is the reviewer's priority as stored; there is nothing to
 * resolve. A pass-through wrapper would imply a derivation that does not
 * exist, and a wrapper that fell back to `suggestedOrder` would move an
 * ordering decision into this module, where it does not belong — how the
 * priority competes with the automatic room rank is the storyboard ordering
 * primitive's contract (ADR-0015). Callers read `analysis.orderOverride`.
 */
