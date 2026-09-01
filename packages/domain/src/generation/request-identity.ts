import { AppError, sha256Hex } from "@app/shared";
import type { GenerationRequestFacts, SceneGeneration } from "./types";
import type { ResolutionNormalization, TargetOutputResolution } from "./model-catalog";

/**
 * One fixed message for every unreconstructable row.
 *
 * Deliberately says nothing about *which* way the row is unusable, and names no
 * id, hash, provider, model key or prompt: the caller is a worker log, and the
 * distinction between "legacy" and "corrupt" is not the caller's decision to
 * act on differently.
 */
const UNRECONSTRUCTABLE_MESSAGE =
  "This generation cannot be reconstructed under the current request identity";

/**
 * Prefix documenting the digest algorithm **and the identity version** in the
 * stored value itself.
 *
 * V1 was `sha256:<hex>` over a tuple containing one ambiguous `resolution`.
 * V2 splits that into a product target plus a frozen delivery plan, so the same
 * inputs would hash differently and the two vocabularies must stay
 * distinguishable in stored data. Bumping the prefix is what makes a V1 row
 * visibly V1 forever, rather than a V2 row that happens to disagree
 * (ADR-0034).
 *
 * Old hashes are never rewritten and never recomputed.
 */
const REQUEST_HASH_PREFIX = "sha256:v2";

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
 * `providerName`, `providerModelId` and `modelKey` *are* included: the same
 * photo and prompt sent to a different model is a different request with a
 * different price and a different result.
 *
 * So are `resolutionNormalization` and `nativeMeetsTarget`, even though both are
 * derivable from today's catalog — **that is precisely why**. They are frozen
 * *product delivery semantics*. If a future catalog correction changed how a
 * model satisfies a 1080p request, an already-admitted attempt must not compare
 * equal to a new one merely because the provider id and the target string
 * happen to match; the delivery plan the customer was admitted under is part of
 * what was agreed (ADR-0034).
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
    TargetOutputResolution,
    string,
    ResolutionNormalization,
    boolean,
    string,
    string,
    string,
  ] = [
    facts.assetId,
    facts.compiledPrompt,
    facts.durationSeconds,
    facts.cameraMotion,
    facts.aspectRatio,
    facts.targetOutputResolution,
    facts.nativeGenerationResolution,
    facts.resolutionNormalization,
    facts.nativeMeetsTarget,
    facts.modelKey,
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
  const {
    requestCompiledPrompt,
    requestDurationSeconds,
    requestAspectRatio,
    requestResolution,
    requestModelKey,
    requestTargetOutputResolution,
    requestNativeGenerationResolution,
    requestResolutionNormalization,
    requestNativeMeetsTarget,
  } = generation;

  // A V2 row is all-or-none. A partially populated one is corruption, not a
  // legacy record, and both are equally unexecutable — so both refuse here
  // rather than being told apart and one of them repaired.
  const v2Complete =
    requestModelKey !== null &&
    requestTargetOutputResolution !== null &&
    requestNativeGenerationResolution !== null &&
    requestResolutionNormalization !== null &&
    requestNativeMeetsTarget !== null;

  if (
    requestCompiledPrompt === null ||
    requestDurationSeconds === null ||
    requestAspectRatio === null ||
    !v2Complete ||
    // A V1 row carries the ambiguous column; a V2 row must not.
    requestResolution !== null ||
    !generation.requestHash.startsWith(`${REQUEST_HASH_PREFIX}:`)
  ) {
    throw new AppError("INTERNAL_ERROR", UNRECONSTRUCTABLE_MESSAGE);
  }

  return {
    assetId: generation.assetId,
    compiledPrompt: requestCompiledPrompt,
    durationSeconds: requestDurationSeconds,
    // Null is a real value here, not a missing one — see above.
    cameraMotion: generation.requestCameraMotion,
    aspectRatio: requestAspectRatio,
    targetOutputResolution: requestTargetOutputResolution,
    nativeGenerationResolution: requestNativeGenerationResolution,
    resolutionNormalization: requestResolutionNormalization,
    nativeMeetsTarget: requestNativeMeetsTarget,
    modelKey: requestModelKey,
    providerName: generation.providerName,
    providerModelId: generation.providerModelId,
  };
}
