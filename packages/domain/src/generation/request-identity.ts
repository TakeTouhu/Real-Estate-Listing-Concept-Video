import { sha256Hex } from "@app/shared";
import type { GenerationRequestFacts } from "./types";

/** Prefix documenting the digest algorithm in the stored value itself. */
const REQUEST_HASH_PREFIX = "sha256";

/**
 * Digest identifying **one generation request**, forming the local idempotency
 * identity `(videoProjectId, requestHash)`.
 *
 * The payload is a fixed-order tuple serialized with `JSON.stringify`, the same
 * discipline as `computeCompositionFingerprint`: structure rather than a chosen
 * separator is what keeps the encoding unambiguous, so no prompt or id
 * containing a delimiter can make two different requests collide. Because the
 * tuple is built positionally, the order properties happen to arrive on the
 * input object cannot affect the result.
 *
 * **What is deliberately absent, and why:**
 *
 * - **Scene position** — reordering the storyboard does not change the media
 *   generated from this photo, so it must not manufacture a new paid request.
 * - **`sourceAnalysisRevision`** — refreshing an analysis that yields the same
 *   room and the same prompt is the same request. The revision is kept as
 *   provenance on the attempt, not as identity.
 * - **`storyboardSceneId`** — recomposition deletes and recreates every scene
 *   with a new id, so including it would make every recompose look like a new
 *   request even when nothing about the request moved.
 * - **Timestamps, tenant and user ids** — the identity is scoped by
 *   `videoProjectId` at the persistence layer; repeating tenancy here would
 *   only make two identical requests by two colleagues look different.
 * - **Provider prediction id and temporary output URL** — outputs of a request,
 *   not inputs to it, and internal-only besides.
 *
 * `providerName` and `providerModelId` *are* included: the same photo and
 * prompt sent to a different model is a different request with a different
 * price and a different result.
 *
 * This identifies a request; it does not promise the provider will only be
 * charged once for it. See ADR-0016.
 */
export function computeGenerationRequestHash(facts: GenerationRequestFacts): string {
  const canonical: readonly [
    string,
    string,
    number,
    string | null,
    string,
    string,
    string,
    string,
  ] = [
    facts.assetId,
    facts.compiledPrompt,
    facts.durationSeconds,
    facts.cameraMotion,
    facts.aspectRatio,
    facts.resolution,
    facts.providerName,
    facts.providerModelId,
  ];
  return `${REQUEST_HASH_PREFIX}:${sha256Hex(JSON.stringify(canonical))}`;
}
