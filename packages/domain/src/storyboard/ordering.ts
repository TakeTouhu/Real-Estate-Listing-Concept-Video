import { AppError } from "@app/shared";
import type { RoomType } from "../analysis/types";
import type { EligibleInput } from "./eligibility";

/**
 * Walkthrough order from `docs/AIVideoPipeline.md`, completed over the existing
 * `RoomType` enum.
 *
 * The documented sequence is exterior → entrance → hallway → living → dining →
 * kitchen → bedroom → wet areas → storage → balcony. Three enum members and the
 * null case sit outside it, and their placement is a deterministic *completion*
 * of that contract rather than a new taxonomy: `CHILD_ROOM` follows `BEDROOM`,
 * `STUDY` follows `CHILD_ROOM`, and `OTHER`/null/unknown come last. "Wet areas"
 * resolves to the three members the enum already has, in the order they appear
 * in it. See ADR-0013.
 */
const ROOM_RANK: Record<RoomType, number> = {
  EXTERIOR: 1,
  ENTRANCE: 2,
  HALLWAY: 3,
  LIVING_ROOM: 4,
  DINING_ROOM: 5,
  KITCHEN: 6,
  BEDROOM: 7,
  CHILD_ROOM: 8,
  STUDY: 9,
  BATHROOM: 10,
  WASHROOM: 11,
  TOILET: 12,
  STORAGE: 13,
  BALCONY: 14,
  OTHER: 15,
};

/**
 * Rank for anything unranked: a null room type, and any value added to
 * `RoomType` later that this table has not been taught. Sorting it last keeps
 * the function total — a future room type is placed conservatively rather than
 * throwing or being invented into the sequence.
 */
const FALLBACK_RANK = 99;

function rankOf(roomType: RoomType | null): number {
  if (roomType === null) return FALLBACK_RANK;
  return ROOM_RANK[roomType] ?? FALLBACK_RANK;
}

/**
 * The number each input sorts by: the reviewer's priority when they set one,
 * otherwise the automatic rank of its effective room.
 *
 * The two share **one** numeric space, which is what makes the priority global.
 * A priority of `2` therefore lands between `ENTRANCE` (2) and `LIVING_ROOM`
 * (4) rather than jumping the whole automatic sequence, and a priority of `8`
 * genuinely sits later than an exterior shot.
 *
 * Priorities are **not clamped**. Room ranks stop at 15 and an unclassified
 * photo falls back to {@link FALLBACK_RANK}, so a priority of `150` sorts after
 * an unclassified photo. That is the reviewer's stated intent, and normalizing
 * it would silently overrule them (ADR-0015).
 */
function primaryKey(input: EligibleInput): number {
  return input.orderOverride ?? rankOf(input.roomType);
}

/**
 * Order eligible inputs into the walkthrough sequence.
 *
 * Deterministic and total. The primary key is {@link primaryKey}; ties then
 * break by, in order: an explicit human priority beating an automatic room rank,
 * the effective room rank, `suggestedOrder` ascending with nulls last, and
 * `assetId` ascending. So the result never depends on the order the inputs
 * arrived in.
 *
 * The explicit-beats-automatic step matters only on an exact numeric tie — a
 * reviewer who typed `1` meant this photo to lead, and an exterior shot that
 * merely ranks 1 by default should yield to that. It is a tie-break, **not** a
 * rule that lifts every corrected photo above every uncorrected one.
 *
 * `roomType` here is already the *effective* room: `selectEligibleAnalyses`
 * resolved any correction before this function ever sees it, so ordering never
 * reads an override itself.
 *
 * The output is a **permutation of the input** — nothing is added, nothing is
 * dropped, and no room is fabricated for a type that has no photo. A repeated
 * `assetId` is refused rather than deduplicated: two inputs claiming one asset
 * means the caller built the set wrongly, and silently keeping one would hide
 * that while quietly changing the scene count. A repeated *priority* is
 * ordinary and resolves through the tie-breaks below.
 *
 * @throws AppError VALIDATION_FAILED when two inputs share an `assetId`.
 */
export function orderScenes(inputs: readonly EligibleInput[]): readonly EligibleInput[] {
  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.assetId)) {
      throw new AppError(
        "VALIDATION_FAILED",
        "The same asset appears twice in the storyboard input set",
        { details: { assetId: input.assetId } },
      );
    }
    seen.add(input.assetId);
  }

  return [...inputs].sort((a, b) => {
    const byPriority = primaryKey(a) - primaryKey(b);
    if (byPriority !== 0) return byPriority;

    // Only reachable on an exact numeric tie: a stated priority outranks a
    // room rank that happens to be the same number.
    const aExplicit = a.orderOverride !== null;
    const bExplicit = b.orderOverride !== null;
    if (aExplicit !== bExplicit) return aExplicit ? -1 : 1;

    const byRoom = rankOf(a.roomType) - rankOf(b.roomType);
    if (byRoom !== 0) return byRoom;
    const bySuggested = compareSuggestedOrder(a.suggestedOrder, b.suggestedOrder);
    if (bySuggested !== 0) return bySuggested;
    return a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0;
  });
}

/**
 * A missing `suggestedOrder` sorts after every stated one, and two missing ones
 * tie so the `assetId` comparison decides.
 *
 * Deliberately not `(a ?? Infinity) - (b ?? Infinity)`: that yields `NaN` for two
 * nulls, the comparator reports "equal-ish" without ordering them, and the pair
 * silently keeps its input order — which would make the sort non-deterministic
 * for exactly the photos most likely to lack a suggestion.
 */
function compareSuggestedOrder(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}
