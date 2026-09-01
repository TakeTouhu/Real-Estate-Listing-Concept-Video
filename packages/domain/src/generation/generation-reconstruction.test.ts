import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import type { StoryboardView } from "../storyboard/storyboard-service";
import type { StoryboardScene, VideoProject } from "../storyboard/types";
import { PRESERVATION_RULES, SYSTEM_NEGATIVE_CONSTRAINTS } from "../storyboard/prompt";
import { createTestDeps, InMemorySceneGenerationRepository } from "../testing/index";
import type { VideoModelCapability } from "./capability";
import type { VerifiedModelEntry, VideoModelCatalog } from "./model-catalog";
import { GenerationService } from "./generation-service";
import type { StoryboardReader } from "./ports";
import { computeGenerationRequestHash, generationRequestFactsFrom } from "./request-identity";
import type { SceneGeneration } from "./types";

/**
 * The architectural proof for Phase 4B-1c (ADR-0018).
 *
 * This is not a "the columns exist" test. It reproduces the exact failure the
 * old design permitted: a generation is admitted, the storyboard is then
 * recomposed so its scene is gone, and the project's request settings are edited
 * to different values. Under the previous contract the admitted request became
 * unreconstructable, and any worker that fell back to current state would have
 * submitted — and paid for — a request the customer never approved.
 *
 * What makes it discriminating is step 3: the replacement scene and the mutated
 * project hold **different** values from the admitted ones. A reconstruction
 * that consulted either would produce different facts and a different hash, and
 * these assertions would fail. Reconstruction that reads only the persisted
 * snapshot reproduces the original hash exactly.
 */

/**
 * A compiled prompt the renderer accepts, differing only in the customer text.
 *
 * Since Phase 4C-0a admission renders the prompt and freezes the result, so a
 * fixture that is not renderable cannot be admitted (ADR-0023). The two
 * variants below stay byte-different, which is what these reconstruction
 * assertions depend on.
 */
function renderablePrompt(customization: string): string {
  return JSON.stringify({
    preservation: [...PRESERVATION_RULES],
    sceneFacts: {
      assetId: "ast_rc",
      position: 1,
      roomType: "KITCHEN",
      durationSeconds: 5,
      cameraMotion: "SLOW_PAN_LEFT",
    },
    userCustomization: customization,
    negativeConstraints: { system: [...SYSTEM_NEGATIVE_CONSTRAINTS], user: null },
  });
}

const ORG = "org_rc";
const PROJECT = "vpr_rc";
const SCENE_A = "scn_rc_a";
const ACTOR = "usr_rc";
const MODEL_KEY = "fixture-model";

const ADMITTED = {
  compiledPrompt: renderablePrompt("warm light"),
  durationSeconds: 5,
  cameraMotion: "SLOW_PAN_LEFT",
  aspectRatio: "16:9",
  targetOutputResolution: "1080p",
  nativeGenerationResolution: "1080p",
} as const;

/** Deliberately different from ADMITTED in every field. */
const AFTER_RECOMPOSE = {
  compiledPrompt: renderablePrompt("cool light"),
  durationSeconds: 9,
  cameraMotion: "SLOW_PAN_RIGHT",
  aspectRatio: "9:16",
  targetOutputResolution: "720p",
  nativeGenerationResolution: "720p",
} as const;

function capability(): VideoModelCapability {
  return {
    providerName: "fixture-provider",
    providerModelId: "fixture/model-v1",
    durationSeconds: { kind: "RANGE", minSeconds: 2, maxSeconds: 20 },
    nativeGenerationResolutions: ["480p", "720p", "1080p"],
    aspectRatios: { kind: "PROVIDER_HONORED", ratios: ["16:9", "9:16", "1:1"] },
    negativePrompt: { kind: "PROVIDER_FIELD" },
    cameraMotion: { kind: "PROVIDER_FIELD" },
  };
}

const NOW = new Date("2026-08-15T00:00:00.000Z");

function project(o: Partial<VideoProject> = {}): VideoProject {
  return {
    id: PROJECT,
    organizationId: ORG,
    propertyId: "prp_rc",
    name: "Walkthrough",
    status: "STORYBOARD_READY",
    durationSeconds: 12,
    aspectRatio: ADMITTED.aspectRatio,
    targetOutputResolution: ADMITTED.targetOutputResolution,
    stylePreset: null,
    cameraMotion: ADMITTED.cameraMotion,
    prompt: null,
    negativePrompt: null,
    includeMusic: false,
    includeCaptions: false,
    brandTemplateId: null,
    compositionFingerprint: "fp_rc",
    createdBy: ACTOR,
    createdAt: NOW,
    updatedAt: NOW,
    ...o,
  };
}

function scene(o: Partial<StoryboardScene> = {}): StoryboardScene {
  return {
    id: SCENE_A,
    videoProjectId: PROJECT,
    propertyId: "prp_rc",
    assetId: "ast_rc",
    position: 1,
    roomType: "KITCHEN",
    durationSeconds: ADMITTED.durationSeconds,
    cameraMotion: ADMITTED.cameraMotion,
    compiledPrompt: ADMITTED.compiledPrompt,
    sourceAnalysisRevision: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...o,
  };
}

/**
 * A storyboard reader whose view can be swapped to simulate recomposition, and
 * which **fails the test** if it is consulted after reconstruction begins.
 */
class SwappableStoryboard implements StoryboardReader {
  sealed = false;
  constructor(public view: StoryboardView) {}
  private guard(): void {
    if (this.sealed) {
      throw new Error(
        "reconstruction consulted the storyboard — it must use only the persisted snapshot",
      );
    }
  }
  assertFresh(): Promise<void> {
    this.guard();
    return Promise.resolve();
  }
  getStoryboard(): Promise<StoryboardView> {
    this.guard();
    return Promise.resolve(this.view);
  }
}

function harness() {
  const deps = createTestDeps();
  void deps.repos.memberships.create({ organizationId: ORG, userId: ACTOR, role: "CREATOR" });
  const generations = new InMemorySceneGenerationRepository(deps.clock);
  generations.registerProject(ORG, PROJECT);
  const storyboard = new SwappableStoryboard({ project: project(), scenes: [scene()], fresh: true });
  // Both product targets are served natively, so recomposition changing the
  // project's target changes what would be generated — which is the point of
  // the test below.
  const entry: VerifiedModelEntry = {
    key: MODEL_KEY,
    providerName: "fixture-provider",
    providerModelId: "fixture/model-v1",
    displayName: "Fixture model",
    tier: "RECOMMENDED",
    recommended: true,
    availability: { kind: "SELECTABLE" },
    capability: capability(),
    nativeGeneration: {
      byTarget: {
        "720p": {
          nativeGenerationResolution: { providerValue: "720p" },
          normalization: "NONE",
          nativeMeetsTarget: true,
        },
        "1080p": {
          nativeGenerationResolution: { providerValue: "1080p" },
          normalization: "NONE",
          nativeMeetsTarget: true,
        },
      },
    },
    pricing: null,
  };
  const models: VideoModelCatalog = {
    list: () => [entry],
    default: () => entry,
    find: (key: string) => (key === entry.key ? entry : undefined),
  };

  const service = new GenerationService({
    identity: deps,
    storyboard,
    generations,
    models,
    ids: deps.ids,
  });
  return { service, storyboard, generations, deps };
}

describe("an admitted generation survives recomposition", () => {
  it("reconstructs the exact admitted request from the persisted snapshot alone", async () => {
    const h = harness();

    // (1) Admit from scene A, with known facts.
    const admitted = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE_A);

    // (2) It is persisted QUEUED, carrying the full immutable snapshot.
    expect(admitted.state).toBe("QUEUED");
    expect(admitted.requestCompiledPrompt).toBe(ADMITTED.compiledPrompt);
    expect(admitted.requestDurationSeconds).toBe(ADMITTED.durationSeconds);
    expect(admitted.requestCameraMotion).toBe(ADMITTED.cameraMotion);
    expect(admitted.requestAspectRatio).toBe(ADMITTED.aspectRatio);
    expect(admitted.requestResolution).toBeNull();
    expect(admitted.requestTargetOutputResolution).toBe(ADMITTED.targetOutputResolution);
    expect(admitted.requestNativeGenerationResolution).toBe(ADMITTED.nativeGenerationResolution);

    // (3) Recompose: scene A is gone, replaced by a scene with a new id and
    // DIFFERENT values, and the project's request settings are edited.
    h.storyboard.view = {
      project: project({
        aspectRatio: AFTER_RECOMPOSE.aspectRatio,
        targetOutputResolution: AFTER_RECOMPOSE.targetOutputResolution,
        cameraMotion: AFTER_RECOMPOSE.cameraMotion,
      }),
      scenes: [
        scene({
          id: "scn_rc_replacement",
          compiledPrompt: AFTER_RECOMPOSE.compiledPrompt,
          durationSeconds: AFTER_RECOMPOSE.durationSeconds,
          cameraMotion: AFTER_RECOMPOSE.cameraMotion,
        }),
      ],
      fresh: true,
    };

    // (4) Any storyboard or mutable-project read from here on fails the test.
    h.storyboard.sealed = true;

    // (5) Reconstruct exclusively from the persisted row.
    const stored = (await h.generations.findById(ORG, admitted.id))!;
    const facts = generationRequestFactsFrom(stored);

    // (6) The reconstructed facts are the ADMITTED ones, not today's.
    expect(facts.compiledPrompt).toBe(ADMITTED.compiledPrompt);
    expect(facts.durationSeconds).toBe(ADMITTED.durationSeconds);
    expect(facts.cameraMotion).toBe(ADMITTED.cameraMotion);
    expect(facts.aspectRatio).toBe(ADMITTED.aspectRatio);
    expect(facts.targetOutputResolution).toBe(ADMITTED.targetOutputResolution);
    expect(facts.nativeGenerationResolution).toBe(ADMITTED.nativeGenerationResolution);
    expect(facts.modelKey).toBe(MODEL_KEY);
    expect(facts.assetId).toBe("ast_rc");
    expect(facts.providerName).toBe("fixture-provider");
    expect(facts.providerModelId).toBe("fixture/model-v1");

    // ...and emphatically NOT the current storyboard/project values.
    expect(facts.compiledPrompt).not.toBe(AFTER_RECOMPOSE.compiledPrompt);
    expect(facts.aspectRatio).not.toBe(AFTER_RECOMPOSE.aspectRatio);
    expect(facts.targetOutputResolution).not.toBe(AFTER_RECOMPOSE.targetOutputResolution);

    // (7)(8) Recomputing the hash from the snapshot reproduces the stored one.
    expect(computeGenerationRequestHash(facts)).toBe(stored.requestHash);
    expect(computeGenerationRequestHash(facts)).toBe(admitted.requestHash);
  });

  it("would produce a different hash if current state were used instead", async () => {
    // Proves the previous assertion is load-bearing rather than accidental: the
    // post-recomposition facts really do hash differently, so a fallback
    // implementation could not have passed the test above.
    const h = harness();
    const admitted = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE_A);

    const currentStateHash = computeGenerationRequestHash({
      assetId: "ast_rc",
      compiledPrompt: AFTER_RECOMPOSE.compiledPrompt,
      durationSeconds: AFTER_RECOMPOSE.durationSeconds,
      cameraMotion: AFTER_RECOMPOSE.cameraMotion,
      aspectRatio: AFTER_RECOMPOSE.aspectRatio,
      targetOutputResolution: AFTER_RECOMPOSE.targetOutputResolution,
      nativeGenerationResolution: AFTER_RECOMPOSE.nativeGenerationResolution,
      resolutionNormalization: "NONE",
      nativeMeetsTarget: true,
      modelKey: MODEL_KEY,
      providerName: "fixture-provider",
      providerModelId: "fixture/model-v1",
    });

    expect(currentStateHash).not.toBe(admitted.requestHash);
  });

  it("holds the self-verifying invariant for every newly admitted generation", async () => {
    const h = harness();
    const admitted = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE_A);
    expect(computeGenerationRequestHash(generationRequestFactsFrom(admitted))).toBe(
      admitted.requestHash,
    );
  });

  it("needs no source-image URL persisted — only the durable asset identity", async () => {
    const h = harness();
    const admitted = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE_A);

    // The row carries an asset id and no URL of any kind; a fresh signed URL is
    // derived at execution time from the asset's durable storage key.
    expect(admitted.assetId).toBe("ast_rc");
    expect(JSON.stringify(admitted)).not.toMatch(/https?:\/\//);
    expect(admitted).not.toHaveProperty("sourceImageUrl");
  });
});

describe("legacy generations without a snapshot", () => {
  /** A row as written before Phase 4B-1c: snapshot columns all null. */
  function legacyRow(): SceneGeneration {
    return {
      id: "gen_legacy",
      videoProjectId: PROJECT,
      sourceStoryboardSceneId: "scn_gone",
      assetId: "ast_rc",
      sourceAnalysisRevision: 1,
      requestHash: "sha256:legacy",
      providerName: "fixture-provider",
      providerModelId: "fixture/model-v1",
      requestCompiledPrompt: null,
      requestDurationSeconds: null,
      requestCameraMotion: null,
      requestAspectRatio: null,
      requestResolution: null,
      requestModelKey: null,
      requestTargetOutputResolution: null,
      requestNativeGenerationResolution: null,
      requestResolutionNormalization: null,
      requestNativeMeetsTarget: null,
      requestRenderedPrompt: null,
      state: "QUEUED",
      providerPredictionId: null,
      submittedAt: null,
      lastPolledAt: null,
      normalizedErrorCode: null,
      normalizedErrorMessage: null,
      outputStorageKey: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  it("loads without fabricated values", () => {
    const row = legacyRow();
    expect(row.requestCompiledPrompt).toBeNull();
    expect(row.requestDurationSeconds).toBeNull();
    expect(row.requestAspectRatio).toBeNull();
    expect(row.requestResolution).toBeNull();
  });

  it("fails closed rather than reconstructing from current state", () => {
    let thrown: AppError | null = null;
    try {
      generationRequestFactsFrom(legacyRow());
    } catch (error) {
      thrown = error as AppError;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown!.code).toBe("INTERNAL_ERROR");
    // Neutral: no id, hash, prompt, tenant, model key, or provider detail —
    // and deliberately silent about WHICH way the row is unusable, since
    // "legacy" and "corrupt" are not different things for the caller to do.
    expect(thrown!.message).toBe(
      "This generation cannot be reconstructed under the current request identity",
    );
  });

  /** Everything a V2 row must carry, so each case can remove exactly one thing. */
  function completeV2Row(): SceneGeneration {
    return {
      ...legacyRow(),
      requestHash: "sha256:v2:complete",
      requestCompiledPrompt: ADMITTED.compiledPrompt,
      requestDurationSeconds: ADMITTED.durationSeconds,
      requestCameraMotion: ADMITTED.cameraMotion,
      requestAspectRatio: ADMITTED.aspectRatio,
      requestResolution: null,
      requestModelKey: MODEL_KEY,
      requestTargetOutputResolution: ADMITTED.targetOutputResolution,
      requestNativeGenerationResolution: ADMITTED.nativeGenerationResolution,
      requestResolutionNormalization: "NONE",
      requestNativeMeetsTarget: true,
    };
  }

  it.each([
    ["requestCompiledPrompt", { requestCompiledPrompt: null }],
    ["requestDurationSeconds", { requestDurationSeconds: null }],
    ["requestAspectRatio", { requestAspectRatio: null }],
    // The five V2 columns are all-or-none. A partially populated snapshot is
    // corruption rather than a legacy record, and both are equally unexecutable.
    ["requestModelKey", { requestModelKey: null }],
    ["requestTargetOutputResolution", { requestTargetOutputResolution: null }],
    ["requestNativeGenerationResolution", { requestNativeGenerationResolution: null }],
    ["requestResolutionNormalization", { requestResolutionNormalization: null }],
    ["requestNativeMeetsTarget", { requestNativeMeetsTarget: null }],
  ])("refuses when only %s is missing", (_name, missing) => {
    expect(() => generationRequestFactsFrom({ ...completeV2Row(), ...missing })).toThrow(AppError);
  });

  it("refuses a realistic V1 row rather than inferring what its resolution meant", () => {
    // The row this whole milestone exists because of: a real pre-3B-2B attempt,
    // carrying the ambiguous `requestResolution` and none of the V2 facts.
    //
    // It is inferable — the only wired model was OpenVideo, which generates
    // natively at exactly that string — and inferring it is precisely what must
    // not happen. "Old rows must have been WaveSpeed" is an assumption about
    // history written into an immutable record of a possibly-paid attempt, and
    // the facts it produced would not reproduce the stored hash anyway.
    const v1: SceneGeneration = {
      ...legacyRow(),
      requestHash: "sha256:realv1",
      requestCompiledPrompt: ADMITTED.compiledPrompt,
      requestDurationSeconds: ADMITTED.durationSeconds,
      requestCameraMotion: ADMITTED.cameraMotion,
      requestAspectRatio: ADMITTED.aspectRatio,
      requestResolution: "720p",
    };

    expect(() => generationRequestFactsFrom(v1)).toThrow(AppError);
  });

  it("refuses a row carrying both request-identity vocabularies", () => {
    // A V2 row that also holds the ambiguous V1 column cannot say which one it
    // was admitted under. The database rejects it too; this is the domain half.
    expect(() =>
      generationRequestFactsFrom({ ...completeV2Row(), requestResolution: "1080p" }),
    ).toThrow(AppError);
  });

  it("refuses a complete V2 snapshot stored under a V1 hash", () => {
    // The hash prefix is the row's own statement of which tuple produced it.
    // Reconstructing V2 facts for a `sha256:` hash would compute an identity
    // that never matches, so it is refused as unreconstructable instead.
    expect(() =>
      generationRequestFactsFrom({ ...completeV2Row(), requestHash: "sha256:legacy" }),
    ).toThrow(AppError);
  });

  it("accepts a null camera motion, which is a real request value", () => {
    const noMotion: SceneGeneration = { ...completeV2Row(), requestCameraMotion: null };
    expect(generationRequestFactsFrom(noMotion).cameraMotion).toBeNull();
  });
});
