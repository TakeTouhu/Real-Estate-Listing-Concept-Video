import { beforeEach, describe, expect, it } from "vitest";
import {
  GenerationService,
  PRESERVATION_RULES,
  SYSTEM_NEGATIVE_CONSTRAINTS,
  computeGenerationRequestHash,
  generationRequestFactsFrom,
  planGenerationResolution,
  type StoryboardReader,
  type StoryboardScene,
  type StoryboardView,
  type TargetOutputResolution,
  type VideoProject,
} from "@app/domain";
import type { AppError } from "@app/shared";
import { createTestDeps, InMemorySceneGenerationRepository } from "@app/domain/testing";
import { createVideoModelCatalog } from "@app/video-providers";

/**
 * Model selection against the **real production catalog**.
 *
 * Every other model-selection test in this repository runs on fixture entries,
 * which is right for proving the *rules* — a fixture that looked like a real
 * model would make a rule pass for the wrong reason. This file asks the
 * complementary question the fixtures cannot: does the shipped catalog, wired
 * into the real `GenerationService`, actually admit the requests the product
 * says it admits, and refuse the ones it says it refuses?
 *
 * It is the only place the concrete strings `minimax-h3-max`, `768P` and
 * `minimax/h3-max/image-to-video` appear in an admission assertion. If the
 * catalog's default moves or H3 Max's native token is re-transcribed, this
 * fails — which is the point, because those values decide what a paid request
 * would be.
 *
 * It lives under `tests/` rather than in `packages/domain` because it crosses
 * the package boundary on purpose: the domain owns the rules and
 * `@app/video-providers` owns the vendor values (ADR-0033), and the domain must
 * not import the adapter package.
 *
 * **No provider is constructed and nothing is submitted.** Constructing the
 * catalog performs no I/O, `GenerationService` holds no provider, and there is
 * no fal adapter to reach even if one were wanted.
 */

const ORG = "org_ms";
const PROJECT = "vpr_ms";
const SCENE = "scn_ms";
const ACTOR = "usr_ms";
const ASSET = "ast_ms";

const catalog = createVideoModelCatalog();
const NOW = new Date("2026-09-01T00:00:00.000Z");

function compiledPrompt(): string {
  return JSON.stringify({
    preservation: [...PRESERVATION_RULES],
    sceneFacts: {
      assetId: ASSET,
      position: 1,
      roomType: "LIVING_ROOM",
      durationSeconds: 5,
      cameraMotion: "SLOW_PAN_LEFT",
    },
    userCustomization: null,
    negativeConstraints: { system: [...SYSTEM_NEGATIVE_CONSTRAINTS], user: null },
  });
}

function project(targetOutputResolution: TargetOutputResolution): VideoProject {
  return {
    id: PROJECT,
    organizationId: ORG,
    propertyId: "prp_ms",
    name: "Walkthrough",
    status: "STORYBOARD_READY",
    durationSeconds: 10,
    aspectRatio: "16:9",
    targetOutputResolution,
    stylePreset: null,
    cameraMotion: "SLOW_PAN_LEFT",
    prompt: null,
    // Null on purpose: OpenVideo declares `negativePrompt: UNSUPPORTED`, so a
    // project carrying one would be refused for that reason instead and this
    // file would stop testing model selection.
    negativePrompt: null,
    includeMusic: false,
    includeCaptions: false,
    brandTemplateId: null,
    compositionFingerprint: "fp_ms",
    createdBy: ACTOR,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function scene(): StoryboardScene {
  return {
    id: SCENE,
    videoProjectId: PROJECT,
    propertyId: "prp_ms",
    assetId: ASSET,
    position: 1,
    roomType: "LIVING_ROOM",
    // Inside both models' documented ranges (H3 Max 5–15, OpenVideo 3–20), so a
    // duration refusal cannot masquerade as a selection outcome.
    durationSeconds: 5,
    cameraMotion: "SLOW_PAN_LEFT",
    compiledPrompt: compiledPrompt(),
    sourceAnalysisRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

class FixedStoryboard implements StoryboardReader {
  constructor(private readonly view: StoryboardView) {}
  assertFresh(): Promise<void> {
    return Promise.resolve();
  }
  getStoryboard(): Promise<StoryboardView> {
    return Promise.resolve(this.view);
  }
}

function harness(target: TargetOutputResolution = "1080p") {
  const deps = createTestDeps();
  void deps.repos.memberships.create({ organizationId: ORG, userId: ACTOR, role: "CREATOR" });

  const generations = new InMemorySceneGenerationRepository(deps.clock);
  generations.registerProject(ORG, PROJECT);

  const service = new GenerationService({
    identity: deps,
    storyboard: new FixedStoryboard({
      project: project(target),
      scenes: [scene()],
      fresh: true,
    }),
    generations,
    models: catalog,
    ids: deps.ids,
  });

  return { service, generations, audits: () => deps.repos.auditLogs.all() };
}

async function rejectionOf(promise: Promise<unknown>): Promise<AppError> {
  return promise.then(
    () => {
      throw new Error("expected the operation to reject, but it resolved");
    },
    (error: unknown) => error as AppError,
  );
}

let h: ReturnType<typeof harness>;

describe("the shipped default is MiniMax H3 Max", () => {
  beforeEach(() => {
    h = harness("1080p");
  });

  it("admits with no model key onto H3 Max through fal", async () => {
    const admitted = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);

    expect(admitted.requestModelKey).toBe("minimax-h3-max");
    expect(admitted.providerName).toBe("fal");
    expect(admitted.providerModelId).toBe("minimax/h3-max/image-to-video");
  });

  it("records a 1080p target as a 768P generation that is NOT native", async () => {
    // The single most important assertion in this file. H3 Max generates at
    // 768P and nothing else, so a 1080p deliverable is an enlargement — and the
    // row has to say so, because nothing in the product may later describe it
    // as native 1080p.
    const admitted = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);

    expect(admitted.requestTargetOutputResolution).toBe("1080p");
    expect(admitted.requestNativeGenerationResolution).toBe("768P");
    expect(admitted.requestResolutionNormalization).toBe("UPSCALE");
    expect(admitted.requestNativeMeetsTarget).toBe(false);
  });

  it("records a 720p target as the same 768P generation, downscaled", async () => {
    const admitted = await harness("720p").service.startScene(ACTOR, ORG, PROJECT, SCENE);

    expect(admitted.requestTargetOutputResolution).toBe("720p");
    expect(admitted.requestNativeGenerationResolution).toBe("768P");
    expect(admitted.requestResolutionNormalization).toBe("DOWNSCALE");
    // Downscaling from a larger generation keeps the detail; upscaling does not.
    expect(admitted.requestNativeMeetsTarget).toBe(true);
  });

  it("never writes the ambiguous legacy column, and self-verifies its hash", async () => {
    const admitted = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);

    expect(admitted.requestResolution).toBeNull();
    expect(admitted.requestHash).toMatch(/^sha256:v2:[0-9a-f]{64}$/);
    expect(computeGenerationRequestHash(generationRequestFactsFrom(admitted))).toBe(
      admitted.requestHash,
    );
  });
});

describe("WaveSpeed OpenVideo can be selected explicitly", () => {
  it("admits onto the verified WaveSpeed entry at its own native token", async () => {
    // The economy path stays reachable. It is the one entry that needs no
    // normalization at either target — which is exactly the coincidence that
    // made a single `resolution` field look correct for as long as it was the
    // only wired model.
    const admitted = await harness("1080p").service.startScene(
      ACTOR,
      ORG,
      PROJECT,
      SCENE,
      "wavespeed-open-video",
    );

    expect(admitted.requestModelKey).toBe("wavespeed-open-video");
    expect(admitted.providerName).toBe("wavespeed");
    expect(admitted.requestNativeGenerationResolution).toBe("1080p");
    expect(admitted.requestResolutionNormalization).toBe("NONE");
    expect(admitted.requestNativeMeetsTarget).toBe(true);
  });

  it("gives the same scene a different identity on each model", async () => {
    const onDefault = await harness("1080p").service.startScene(ACTOR, ORG, PROJECT, SCENE);
    const onWaveSpeed = await harness("1080p").service.startScene(
      ACTOR,
      ORG,
      PROJECT,
      SCENE,
      "wavespeed-open-video",
    );

    expect(onDefault.requestHash).not.toBe(onWaveSpeed.requestHash);
  });
});

describe("unverified and unknown models are refused, with no fallback", () => {
  it.each(["minimax-h3", "veo-3-1"])("refuses the unverified %s", async (modelKey) => {
    const local = harness("1080p");
    const error = await rejectionOf(
      local.service.startScene(ACTOR, ORG, PROJECT, SCENE, modelKey),
    );

    expect(error.code).toBe("VALIDATION_FAILED");
    // The message is pinned because two different guards can refuse an
    // unverified entry, and only one of them is the right one. Admission's own
    // check must fire here; `planGenerationResolution` also refuses unverified
    // entries, so a selection guard that had been removed entirely would still
    // produce a VALIDATION_FAILED — from a layer whose message describes a
    // resolution-planning failure rather than an unavailable model.
    expect(error.message).toBe(`The model ${modelKey} is not available for generation yet`);
    // Refused before anything durable exists — no row, no audit entry.
    expect(local.generations.all()).toHaveLength(0);
    expect(local.audits()).toHaveLength(0);
  });

  it("refuses an unknown key rather than silently using the default", async () => {
    const local = harness("1080p");
    const error = await rejectionOf(
      local.service.startScene(ACTOR, ORG, PROJECT, SCENE, "gpt-video-9"),
    );

    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toBe("There is no model named gpt-video-9");
    expect(local.generations.all()).toHaveLength(0);
    expect(local.audits()).toHaveLength(0);
  });
});

describe("the catalog itself agrees with what admission persisted", () => {
  it("matches planGenerationResolution for every selectable model and target", () => {
    // Independent of the service: proves the numbers asserted above are the
    // catalog's own answers rather than values this file happens to expect.
    const expected: ReadonlyArray<[string, TargetOutputResolution, string, string, boolean]> = [
      ["minimax-h3-max", "720p", "768P", "DOWNSCALE", true],
      ["minimax-h3-max", "1080p", "768P", "UPSCALE", false],
      ["wavespeed-open-video", "720p", "720p", "NONE", true],
      ["wavespeed-open-video", "1080p", "1080p", "NONE", true],
    ];

    for (const [key, target, native, normalization, meets] of expected) {
      const entry = catalog.find(key)!;
      const plan = planGenerationResolution(entry, target);
      expect(plan.nativeGenerationResolution.providerValue).toBe(native);
      expect(plan.normalization).toBe(normalization);
      expect(plan.nativeMeetsTarget).toBe(meets);
    }
  });
});
