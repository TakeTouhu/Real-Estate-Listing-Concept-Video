import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import type { StoryboardView } from "../storyboard/storyboard-service";
import type { StoryboardScene, VideoProject } from "../storyboard/types";
import { createTestDeps, InMemorySceneGenerationRepository, RecordingSceneGenerationQueue } from "../testing/index";
import type { VideoModelCapability, VideoModelCapabilityProvider } from "./capability";
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

const ORG = "org_rc";
const PROJECT = "vpr_rc";
const SCENE_A = "scn_rc_a";
const ACTOR = "usr_rc";

const ADMITTED = {
  compiledPrompt: '{"preservation":["keep"],"sceneFacts":{"p":1},"userCustomization":"warm light"}',
  durationSeconds: 5,
  cameraMotion: "SLOW_PAN",
  aspectRatio: "16:9",
  resolution: "1080p",
} as const;

/** Deliberately different from ADMITTED in every field. */
const AFTER_RECOMPOSE = {
  compiledPrompt: '{"preservation":["keep"],"sceneFacts":{"p":1},"userCustomization":"cool light"}',
  durationSeconds: 9,
  cameraMotion: "FAST_ZOOM",
  aspectRatio: "9:16",
  resolution: "720p",
} as const;

function capability(): VideoModelCapability {
  return {
    providerName: "fixture-provider",
    providerModelId: "fixture/model-v1",
    durationSeconds: { kind: "RANGE", minSeconds: 2, maxSeconds: 20 },
    resolutions: ["480p", "720p", "1080p"],
    aspectRatios: { kind: "SUPPORTED", ratios: ["16:9", "9:16", "1:1"] },
    negativePrompt: "SUPPORTED",
    cameraMotion: "SUPPORTED",
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
    resolution: ADMITTED.resolution,
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
  const capabilities: VideoModelCapabilityProvider = { current: () => capability() };
  const queue = new RecordingSceneGenerationQueue();

  const service = new GenerationService({
    identity: deps,
    storyboard,
    generations,
    capabilities,
    queue,
    ids: deps.ids,
  });
  return { service, storyboard, generations, queue, deps };
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
    expect(admitted.requestResolution).toBe(ADMITTED.resolution);

    // (3) Recompose: scene A is gone, replaced by a scene with a new id and
    // DIFFERENT values, and the project's request settings are edited.
    h.storyboard.view = {
      project: project({
        aspectRatio: AFTER_RECOMPOSE.aspectRatio,
        resolution: AFTER_RECOMPOSE.resolution,
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
    expect(facts.resolution).toBe(ADMITTED.resolution);
    expect(facts.assetId).toBe("ast_rc");
    expect(facts.providerName).toBe("fixture-provider");
    expect(facts.providerModelId).toBe("fixture/model-v1");

    // ...and emphatically NOT the current storyboard/project values.
    expect(facts.compiledPrompt).not.toBe(AFTER_RECOMPOSE.compiledPrompt);
    expect(facts.aspectRatio).not.toBe(AFTER_RECOMPOSE.aspectRatio);
    expect(facts.resolution).not.toBe(AFTER_RECOMPOSE.resolution);

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
      resolution: AFTER_RECOMPOSE.resolution,
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
    // Neutral: no id, hash, prompt, tenant, or provider detail.
    expect(thrown!.message).toBe(
      "This generation predates the request snapshot and cannot be reconstructed",
    );
  });

  it.each([
    ["requestCompiledPrompt", { requestCompiledPrompt: null }],
    ["requestDurationSeconds", { requestDurationSeconds: null }],
    ["requestAspectRatio", { requestAspectRatio: null }],
    ["requestResolution", { requestResolution: null }],
  ])("refuses when only %s is missing", (_name, missing) => {
    const complete: SceneGeneration = {
      ...legacyRow(),
      requestCompiledPrompt: ADMITTED.compiledPrompt,
      requestDurationSeconds: ADMITTED.durationSeconds,
      requestCameraMotion: ADMITTED.cameraMotion,
      requestAspectRatio: ADMITTED.aspectRatio,
      requestResolution: ADMITTED.resolution,
    };
    expect(() => generationRequestFactsFrom({ ...complete, ...missing })).toThrow(AppError);
  });

  it("accepts a null camera motion, which is a real request value", () => {
    const noMotion: SceneGeneration = {
      ...legacyRow(),
      requestCompiledPrompt: ADMITTED.compiledPrompt,
      requestDurationSeconds: ADMITTED.durationSeconds,
      requestCameraMotion: null,
      requestAspectRatio: ADMITTED.aspectRatio,
      requestResolution: ADMITTED.resolution,
    };
    expect(generationRequestFactsFrom(noMotion).cameraMotion).toBeNull();
  });
});
