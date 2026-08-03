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
 * Order eligible inputs into the walkthrough sequence.
 *
 * Deterministic and total: equal room ranks break by `suggestedOrder` ascending
 * with nulls last, then by `assetId` ascending, so the result never depends on
 * the order the inputs arrived in.
 *
 * The output is a **permutation of the input** — nothing is added, nothing is
 * dropped, and no room is fabricated for a type that has no photo. A repeated
 * `assetId` is refused rather than deduplicated: two inputs claiming one asset
 * means the caller built the set wrongly, and silently keeping one would hide
 * that while quietly changing the scene count.
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
