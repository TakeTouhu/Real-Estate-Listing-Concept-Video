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
 * It captures **identity of the input set only**. Scene order and durations are
 * deliberately excluded: reordering a storyboard or changing its length does not
 * make it stale, whereas an approved photo appearing, disappearing, or being
 * re-analyzed does.
 *
 * Comparing a stored fingerprint with a freshly computed one is how staleness is
 * detected, so no module has to notify another when an analysis is refreshed.
 * The digest therefore changes when an eligible approved asset is added, when
 * one disappears, and when an eligible asset's `analysisRevision` changes — and
 * is unaffected by the order the inputs arrive in.
 */
export function computeCompositionFingerprint(inputs: readonly EligibleInput[]): string {
  const canonical = inputs
    .map((input): readonly [string, number] => [input.assetId, input.analysisRevision])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `${FINGERPRINT_PREFIX}:${sha256Hex(JSON.stringify(canonical))}`;
}
