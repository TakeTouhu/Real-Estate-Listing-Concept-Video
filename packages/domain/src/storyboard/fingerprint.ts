import { sha256Hex } from "@app/shared";
import type { EligibleInput } from "./eligibility";

/** Prefix documenting the digest algorithm in the stored value itself. */
const FINGERPRINT_PREFIX = "sha256";

/**
 * Digest identifying the **complete eligible input set** a storyboard was
 * composed from.
 *
 * The payload is a canonical structure, not concatenated text: each input
 * becomes the tuple `[assetId, analysisRevision]`, the tuples are sorted by
 * `assetId`, and the resulting array is serialized with `JSON.stringify` before
 * hashing. Structure — rather than a chosen separator — is what keeps the
 * encoding unambiguous, so no id containing a delimiter can make two different
 * sets collide.
 *
 * It captures the identity of the input set **and the human decisions that
 * change what would be generated from it**. Scene durations and the resulting
 * scene sequence are still excluded — those are outputs. The digest changes
 * when an eligible approved asset is added, when one disappears, when an
 * eligible asset's `analysisRevision` changes, when a reviewer's effective room
 * classification changes, and when their order priority changes — and is
 * unaffected by the order the inputs arrive in.
 *
 * `roomType` is the effective room already resolved by
 * `selectEligibleAnalyses`; this module never reads an `AssetAnalysis` and never
 * resolves an override itself. `analysisRevision` is **not** advanced by a
 * correction, which is exactly why the correction values have to appear here.
 *
 * **The payload changed in Phase 3D-3 (ADR-0015).** Two extra members are
 * serialized even when both are null, so a digest computed under the Phase 3C
 * format will not match one computed now. Every storyboard composed before this
 * change therefore reads **stale once** and must be recomposed. That is
 * deliberate and fail-safe: there is no compatibility fallback, no dual-format
 * support, and no backfill, because treating an old digest as fresh would be
 * asserting something this function can no longer verify.
 */
export function computeCompositionFingerprint(inputs: readonly EligibleInput[]): string {
  const canonical = inputs
    .map(
      (input): readonly [string, number, string | null, number | null] => [
        input.assetId,
        input.analysisRevision,
        input.roomType,
        input.orderOverride,
      ],
    )
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `${FINGERPRINT_PREFIX}:${sha256Hex(JSON.stringify(canonical))}`;
}
