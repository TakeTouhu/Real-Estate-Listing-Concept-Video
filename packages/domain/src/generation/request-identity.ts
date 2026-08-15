import { AppError, sha256Hex } from "@app/shared";
import type { GenerationRequestFacts, SceneGeneration } from "./types";

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

/**
 * Rebuild the request facts of an **already admitted** generation from its own
 * persisted row.
 *
 * This is the reconstruction half of the identity contract. `requestHash` proves
 * two requests are the same; it cannot say what either one *was*, because it is
 * one-way. So a worker that holds only a generation id rebuilds the request from
 * the row's immutable snapshot — never by dereferencing `sourceStoryboardSceneId`
 * (recomposition deletes that scene) and never by reading the project's current
 * `aspectRatio` or `resolution` (those are mutable, and reading them could
 * submit a request the customer never approved under this identity).
 *
 * Because the snapshot covers exactly the hash facts the row did not already
 * carry, this function closes a loop that can be asserted rather than trusted:
 *
 * ```
 * computeGenerationRequestHash(generationRequestFactsFrom(g)) === g.requestHash
 * ```
 *
 * **Fails closed.** A generation admitted before the snapshot existed has `null`
 * in those columns and simply cannot be reconstructed — its inputs are gone. The
 * honest answer is to refuse, so this throws rather than substituting today's
 * storyboard or project values, which would silently fabricate a request that
 * was never admitted and whose hash would not match. What a worker does with
 * that refusal — the normalized failure state for an unexecutable legacy row —
 * is Phase 4C's decision, recorded in `docs/decisions/TODO.md`.
 *
 * `requestCameraMotion` is deliberately **not** part of the completeness check:
 * `null` there is a legitimate request that carries no camera motion, and the
 * hash was computed over exactly that null.
 *
 * @throws AppError INTERNAL_ERROR when the row predates the snapshot contract.
 *   The message names no id, hash, prompt, tenant, or provider detail.
 */
export function generationRequestFactsFrom(
  generation: SceneGeneration,
): GenerationRequestFacts {
  const { requestCompiledPrompt, requestDurationSeconds, requestAspectRatio, requestResolution } =
    generation;

  if (
    requestCompiledPrompt === null ||
    requestDurationSeconds === null ||
    requestAspectRatio === null ||
    requestResolution === null
  ) {
    throw new AppError(
      "INTERNAL_ERROR",
      "This generation predates the request snapshot and cannot be reconstructed",
    );
  }

  return {
    assetId: generation.assetId,
    compiledPrompt: requestCompiledPrompt,
    durationSeconds: requestDurationSeconds,
    // Null is a real value here, not a missing one — see above.
    cameraMotion: generation.requestCameraMotion,
    aspectRatio: requestAspectRatio,
    resolution: requestResolution,
    providerName: generation.providerName,
    providerModelId: generation.providerModelId,
  };
}
