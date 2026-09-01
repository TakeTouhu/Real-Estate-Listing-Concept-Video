import { describe, expect, it } from "vitest";
import type { NewSceneGeneration, SceneGeneration } from "./index";

/**
 * The current-write contract, proven at compile time.
 *
 * `NewSceneGeneration` and `SceneGeneration` answer two different questions,
 * and conflating them is what this file exists to prevent:
 *
 * - **read** — every row the system can load, *including history*. Attempts
 *   admitted before ADR-0018's snapshot, ADR-0023's prompt freeze and
 *   ADR-0034's V2 identity carry nulls, and they stay readable because they are
 *   the record of work that may have been paid for.
 * - **write** — what this application can admit *today*. Nothing here can
 *   legitimately produce a V1 attempt, a partial delivery snapshot, or a row
 *   carrying both request-identity vocabularies at once.
 *
 * Deriving the write type from the read type with a plain `Omit` inherited all
 * the nullability and made every one of those expressible. These assertions are
 * the guard: each is a type-level equation that fails to compile if the write
 * contract widens back toward the read shape.
 *
 * They are compile-time only. The runtime `expect` at the end exists so the
 * file is a real test rather than a silent one — but the assertions above it
 * have already done their work by the time it runs, because a failure here is a
 * `tsc` error, not a red test.
 *
 * No `any`, no `@ts-ignore`, and no cast is used to satisfy anything: a cast
 * would make the evidence agree with itself rather than with the type.
 */

/** Compiles only when `T` is exactly `true`. */
type Assert<T extends true> = T;
/** Mutual assignability — `extends` alone would accept a narrower type. */
type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Present and not optional: `K` must be in the required key set. */
type IsRequired<T, K extends keyof T> = object extends Pick<T, K> ? false : true;

/**
 * A valid V2 admission, written out in full.
 *
 * Its role is to make the negative assertions below meaningful: each one is
 * this object with exactly one thing wrong, so a failure points at that one
 * change rather than at a shape that was never valid to begin with.
 */
const VALID: NewSceneGeneration = {
  id: "gen_contract",
  videoProjectId: "vpr_contract",
  sourceStoryboardSceneId: "scn_contract",
  assetId: "ast_contract",
  sourceAnalysisRevision: 1,
  requestHash: "sha256:v2:contract",
  providerName: "fixture-provider",
  providerModelId: "fixture/model-v1",
  requestCompiledPrompt: '{"preservation":[]}',
  requestDurationSeconds: 5,
  requestCameraMotion: "SLOW_PAN_LEFT",
  requestAspectRatio: "16:9",
  requestResolution: null,
  requestModelKey: "fixture-model",
  requestTargetOutputResolution: "1080p",
  requestNativeGenerationResolution: "768P",
  requestResolutionNormalization: "UPSCALE",
  requestNativeMeetsTarget: false,
  requestRenderedPrompt: "Preservation rules:\n- frozen at admission",
  state: "QUEUED",
  providerPredictionId: null,
  submittedAt: null,
  lastPolledAt: null,
  normalizedErrorCode: null,
  normalizedErrorMessage: null,
  outputStorageKey: null,
};

describe("the current create contract is V2-only", () => {
  it("pins every write-side guarantee at compile time", () => {
    // Every assertion below is a `tsc` error when broken; the runtime
    // `expect(...)` only keeps the constant used, since the compiler is the
    // thing actually doing the checking.

  // --- 1. `requestResolution` is pinned to exactly `null` -----------------------
  //
  // The sharpest assertion in the file. `string | null` would let a caller pass
  // `"1080p"` and produce precisely the ambiguous row ADR-0034 removed; `null`
  // makes the legacy vocabulary *unwritable* rather than merely discouraged.
  const resolutionIsExactlyNull: Assert<IsExactly<NewSceneGeneration["requestResolution"], null>> = true;
  expect(resolutionIsExactlyNull).toBe(true);
  const resolutionIsRequired: Assert<IsRequired<NewSceneGeneration, "requestResolution">> = true;
  expect(resolutionIsRequired).toBe(true);

  // --- 2–6. The five V2 delivery facts are required and non-nullable ------------
  const modelKey: Assert<IsExactly<NewSceneGeneration["requestModelKey"], string>> = true;
  expect(modelKey).toBe(true);
  const modelKeyRequired: Assert<IsRequired<NewSceneGeneration, "requestModelKey">> = true;
  expect(modelKeyRequired).toBe(true);

  const target: Assert<IsExactly<NewSceneGeneration["requestTargetOutputResolution"], "720p" | "1080p">> = true;
  expect(target).toBe(true);
  const targetRequired: Assert<IsRequired<NewSceneGeneration, "requestTargetOutputResolution">> = true;
  expect(targetRequired).toBe(true);

  const native: Assert<IsExactly<NewSceneGeneration["requestNativeGenerationResolution"], string>> = true;
  expect(native).toBe(true);
  const nativeRequired: Assert<IsRequired<NewSceneGeneration, "requestNativeGenerationResolution">> = true;
  expect(nativeRequired).toBe(true);

  const normalization: Assert<IsExactly<NewSceneGeneration["requestResolutionNormalization"], "NONE" | "DOWNSCALE" | "UPSCALE">> = true;
  expect(normalization).toBe(true);
  const normalizationRequired: Assert<IsRequired<NewSceneGeneration, "requestResolutionNormalization">> = true;
  expect(normalizationRequired).toBe(true);

  const meetsTarget: Assert<IsExactly<NewSceneGeneration["requestNativeMeetsTarget"], boolean>> = true;
  expect(meetsTarget).toBe(true);
  const meetsTargetRequired: Assert<IsRequired<NewSceneGeneration, "requestNativeMeetsTarget">> = true;
  expect(meetsTargetRequired).toBe(true);

  // --- 7–9. The reconstruction facts are required and non-nullable --------------
  //
  // Without these a caller could write a complete V2 delivery snapshot onto a row
  // that `generationRequestFactsFrom` still cannot reconstruct — a row born
  // unexecutable, and one whose hash nothing could ever reproduce.
  const compiledPrompt: Assert<IsExactly<NewSceneGeneration["requestCompiledPrompt"], string>> = true;
  expect(compiledPrompt).toBe(true);
  const compiledPromptRequired: Assert<IsRequired<NewSceneGeneration, "requestCompiledPrompt">> = true;
  expect(compiledPromptRequired).toBe(true);

  const duration: Assert<IsExactly<NewSceneGeneration["requestDurationSeconds"], number>> = true;
  expect(duration).toBe(true);
  const durationRequired: Assert<IsRequired<NewSceneGeneration, "requestDurationSeconds">> = true;
  expect(durationRequired).toBe(true);

  const aspectRatio: Assert<IsExactly<NewSceneGeneration["requestAspectRatio"], string>> = true;
  expect(aspectRatio).toBe(true);
  const aspectRatioRequired: Assert<IsRequired<NewSceneGeneration, "requestAspectRatio">> = true;
  expect(aspectRatioRequired).toBe(true);

  // --- 10. The frozen prompt stays required ------------------------------------
  const renderedPrompt: Assert<IsExactly<NewSceneGeneration["requestRenderedPrompt"], string>> = true;
  expect(renderedPrompt).toBe(true);
  const renderedPromptRequired: Assert<IsRequired<NewSceneGeneration, "requestRenderedPrompt">> = true;
  expect(renderedPromptRequired).toBe(true);

  // --- The read shape is deliberately NOT narrowed ------------------------------
  //
  // The other half of the contract. If a later edit tightened `SceneGeneration`
  // to match the write type, every historical row would become unrepresentable
  // and this fails — which is the outcome that matters most, because those rows
  // record work that may have been charged for.
  const readKeepsLegacyResolution: Assert<IsExactly<SceneGeneration["requestResolution"], string | null>> = true;
  expect(readKeepsLegacyResolution).toBe(true);
  const readKeepsNullableModelKey: Assert<IsExactly<SceneGeneration["requestModelKey"], string | null>> = true;
  expect(readKeepsNullableModelKey).toBe(true);
  const readKeepsNullableMeetsTarget: Assert<IsExactly<SceneGeneration["requestNativeMeetsTarget"], boolean | null>> = true;
  expect(readKeepsNullableMeetsTarget).toBe(true);
  const readKeepsNullablePrompt: Assert<IsExactly<SceneGeneration["requestRenderedPrompt"], string | null>> = true;
  expect(readKeepsNullablePrompt).toBe(true);

  // --- Camera motion is the one nullable value, on purpose ----------------------
  //
  // `null` there is a legitimate request carrying no camera motion, and the hash
  // was computed over exactly that null. It is a value, not an absence.
  const cameraMotionStaysNullable: Assert<IsExactly<NewSceneGeneration["requestCameraMotion"], string | null>> = true;
  expect(cameraMotionStaysNullable).toBe(true);

/**
 * What must NOT be assignable.
 *
 * Expressed as `IsExactly<..., false>` over an assignability probe rather than
 * as commented-out code, so the prohibition is checked by the compiler on every
 * build instead of being a note someone has to remember to re-verify.
 */
type Assignable<T> = T extends NewSceneGeneration ? true : false;

  // --- 11. A literal carrying the legacy vocabulary is rejected ------------------
  const legacyResolutionRejected: Assert<IsExactly<Assignable<Omit<typeof VALID, "requestResolution"> & { requestResolution: "1080p" }>, false>> = true;
  expect(legacyResolutionRejected).toBe(true);

  // --- 12. A literal missing any V2 delivery member is rejected ------------------
  const missingModelKeyRejected: Assert<IsExactly<Assignable<Omit<typeof VALID, "requestModelKey">>, false>> = true;
  expect(missingModelKeyRejected).toBe(true);
  const missingTargetRejected: Assert<IsExactly<Assignable<Omit<typeof VALID, "requestTargetOutputResolution">>, false>> = true;
  expect(missingTargetRejected).toBe(true);
  const missingNativeRejected: Assert<IsExactly<Assignable<Omit<typeof VALID, "requestNativeGenerationResolution">>, false>> = true;
  expect(missingNativeRejected).toBe(true);
  const missingNormalizationRejected: Assert<IsExactly<Assignable<Omit<typeof VALID, "requestResolutionNormalization">>, false>> = true;
  expect(missingNormalizationRejected).toBe(true);
  const missingMeetsTargetRejected: Assert<IsExactly<Assignable<Omit<typeof VALID, "requestNativeMeetsTarget">>, false>> = true;
  expect(missingMeetsTargetRejected).toBe(true);

  // --- 13. A complete V2 snapshot with a null compiled prompt is rejected --------
  //
  // The combination that would otherwise slip through: everything ADR-0034 asks
  // for, on a row that predates ADR-0018 and therefore cannot be reconstructed.
  const nullPromptRejected: Assert<IsExactly<
    Assignable<Omit<typeof VALID, "requestCompiledPrompt"> & { requestCompiledPrompt: null }>,
    false
  >> = true;
  expect(nullPromptRejected).toBe(true);
  const nullDurationRejected: Assert<IsExactly<
    Assignable<Omit<typeof VALID, "requestDurationSeconds"> & { requestDurationSeconds: null }>,
    false
  >> = true;
  expect(nullDurationRejected).toBe(true);
  const nullAspectRatioRejected: Assert<IsExactly<
    Assignable<Omit<typeof VALID, "requestAspectRatio"> & { requestAspectRatio: null }>,
    false
  >> = true;
  expect(nullAspectRatioRejected).toBe(true);
  const nullRenderedPromptRejected: Assert<IsExactly<
    Assignable<Omit<typeof VALID, "requestRenderedPrompt"> & { requestRenderedPrompt: null }>,
    false
  >> = true;
  expect(nullRenderedPromptRejected).toBe(true);

    // The fixture is a real value, not only a type source: reading it here
    // proves a well-formed V2 admission is genuinely constructible, so the
    // negative assertions above are rejecting one specific defect rather than
    // an object that was never valid.
    expect(VALID.requestResolution).toBeNull();
    expect(VALID.requestModelKey).toBe("fixture-model");
    expect(VALID.requestNativeMeetsTarget).toBe(false);
  });
});
