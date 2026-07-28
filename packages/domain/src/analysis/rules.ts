import { DUPLICATE_HAMMING_THRESHOLD, hammingDistanceHex } from "../property/media";
import type { RoomType } from "./types";

/**
 * Suggested presentation order by room type (docs/AIVideoPipeline.md):
 * exterior → entrance → hallway → living → dining → kitchen → bedroom →
 * wet areas → storage → balcony.
 */
const ROOM_ORDER: readonly RoomType[] = [
  "EXTERIOR",
  "ENTRANCE",
  "HALLWAY",
  "LIVING_ROOM",
  "DINING_ROOM",
  "KITCHEN",
  "BEDROOM",
  "CHILD_ROOM",
  "STUDY",
  "BATHROOM",
  "WASHROOM",
  "TOILET",
  "STORAGE",
  "BALCONY",
  "OTHER",
];

/** Rank of a room type in the suggested sequence; unknown/null sorts last. */
export function roomOrderRank(roomType: RoomType | null): number {
  if (roomType === null) return ROOM_ORDER.length;
  const index = ROOM_ORDER.indexOf(roomType);
  return index === -1 ? ROOM_ORDER.length : index;
}

/** An already-analyzed sibling asset considered for duplicate grouping. */
export interface DuplicateCandidate {
  readonly assetId: string;
  readonly perceptualHash: string | null;
  readonly duplicateGroup: string | null;
}

/**
 * Assign a stable duplicate-group id by comparing the subject's perceptual hash
 * against already-analyzed siblings in the same organization. Reuses an existing
 * group when a near-duplicate is found, otherwise starts a new group keyed by
 * the subject asset id. Returns null when no hash is available to compare.
 */
export function resolveDuplicateGroup(
  perceptualHash: string | null,
  assetId: string,
  candidates: readonly DuplicateCandidate[],
): string | null {
  if (!perceptualHash) return null;
  for (const candidate of candidates) {
    if (candidate.assetId === assetId) continue;
    if (!candidate.duplicateGroup || !candidate.perceptualHash) continue;
    if (candidate.perceptualHash.length !== perceptualHash.length) continue;
    if (hammingDistanceHex(candidate.perceptualHash, perceptualHash) <= DUPLICATE_HAMMING_THRESHOLD) {
      return candidate.duplicateGroup;
    }
  }
  return `dup_${assetId}`;
}
