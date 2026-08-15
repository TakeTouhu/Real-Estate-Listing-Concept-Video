import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import type { AuditLog } from "../identity/types";
import type { AuditLogRepository } from "../identity/ports";
import type { Role } from "../identity/roles";
import { StoryboardService, type StoryboardView } from "../storyboard/storyboard-service";
import type { StoryboardScene, VideoProject } from "../storyboard/types";
import {
  createTestDeps,
  InMemorySceneGenerationRepository,
  RecordingSceneGenerationQueue,
} from "../testing/index";
import type { VideoModelCapability, VideoModelCapabilityProvider } from "./capability";
import { GenerationService, type GenerationServiceDeps } from "./generation-service";
import {
  ACTIVE_SCENE_GENERATION_STATES,
  ActiveGenerationConflictError,
  SceneGenerationNotFoundError,
  type NewSceneGeneration,
  type SceneGeneration,
  type SceneGenerationRepository,
  type SceneGenerationState,
  type StoryboardReader,
} from "./index";
import { computeGenerationRequestHash, generationRequestFactsFrom } from "./request-identity";

/**
 * The single-scene admission service. Every test drives the real
 * {@link GenerationService} against the Phase 4B-1a in-memory repository, a
 * recording queue double, a scripted storyboard stub, and a counting capability
 * fixture — no provider and no storage anywhere, which is itself part of what is
 * proven.
 */

const ORG = "org_a";
const OTHER_ORG = "org_b";
const PROJECT = "vpr_a";
const SCENE = "scn_a";
const ACTOR = "usr_actor";

/** A capability fixture. Clearly not real WaveSpeed values — Phase 4B-2 owns those. */
function capability(overrides: Partial<VideoModelCapability> = {}): VideoModelCapability {
  return {
    providerName: "fixture-provider",
    providerModelId: "fixture/model-v1",
    durationSeconds: { kind: "RANGE", minSeconds: 2, maxSeconds: 20 },
    resolutions: ["480p", "720p", "1080p"],
    aspectRatios: { kind: "SUPPORTED", ratios: ["16:9", "9:16", "1:1"] },
    negativePrompt: "SUPPORTED",
    cameraMotion: "SUPPORTED",
    ...overrides,
  };
}

function project(overrides: Partial<VideoProject> = {}): VideoProject {
  const now = new Date("2026-08-14T00:00:00.000Z");
  return {
    id: PROJECT,
    organizationId: ORG,
    propertyId: "prp_a",
    name: "Walkthrough",
    status: "STORYBOARD_READY",
    durationSeconds: 12,
    aspectRatio: "16:9",
    resolution: "1080p",
    stylePreset: null,
    cameraMotion: "SLOW_PAN",
    prompt: null,
    negativePrompt: null,
    includeMusic: false,
    includeCaptions: false,
    brandTemplateId: null,
    compositionFingerprint: "fp_1",
    createdBy: ACTOR,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function scene(overrides: Partial<StoryboardScene> = {}): StoryboardScene {
  const now = new Date("2026-08-14T00:00:00.000Z");
  return {
    id: SCENE,
    videoProjectId: PROJECT,
    propertyId: "prp_a",
    assetId: "ast_1",
    position: 1,
    roomType: "KITCHEN",
    durationSeconds: 5,
    cameraMotion: "SLOW_PAN",
    compiledPrompt: '{"preservation":[],"sceneFacts":{},"userCustomization":null}',
    sourceAnalysisRevision: 3,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** The request-hash the default fixtures should produce, computed independently. */
function expectedHash(
  s: StoryboardScene = scene(),
  p: VideoProject = project(),
  cap: VideoModelCapability = capability(),
): string {
  return computeGenerationRequestHash({
    assetId: s.assetId,
    compiledPrompt: s.compiledPrompt!,
    durationSeconds: s.durationSeconds,
    cameraMotion: s.cameraMotion,
    aspectRatio: p.aspectRatio,
    resolution: p.resolution,
    providerName: cap.providerName,
    providerModelId: cap.providerModelId,
  });
}

/** A fully-formed persisted attempt, for seeding reuse and race scenarios. */
function genRow(id: string, state: SceneGenerationState, overrides: Partial<SceneGeneration> = {}): SceneGeneration {
  const now = new Date("2026-08-14T00:00:00.000Z");
  return {
    id,
    videoProjectId: PROJECT,
    sourceStoryboardSceneId: SCENE,
    assetId: "ast_1",
    sourceAnalysisRevision: 3,
    requestHash: expectedHash(),
    providerName: "fixture-provider",
    providerModelId: "fixture/model-v1",
    // The immutable snapshot, consistent with the default scene/project
    // fixtures so a seeded row reproduces `expectedHash()`.
    requestCompiledPrompt: scene().compiledPrompt,
    requestDurationSeconds: scene().durationSeconds,
    requestCameraMotion: scene().cameraMotion,
    requestAspectRatio: project().aspectRatio,
    requestResolution: project().resolution,
    state,
    providerPredictionId: null,
    submittedAt: null,
    lastPolledAt: null,
    normalizedErrorCode: null,
    normalizedErrorMessage: null,
    outputStorageKey: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Records call order and returns a scripted view; freshness is injectable. */
class StubStoryboard implements StoryboardReader {
  readonly calls: string[] = [];
  freshError: AppError | null = null;
  constructor(private readonly viewValue: StoryboardView) {}
  assertFresh(): Promise<void> {
    this.calls.push("assertFresh");
    return this.freshError ? Promise.reject(this.freshError) : Promise.resolve();
  }
  getStoryboard(): Promise<StoryboardView> {
    this.calls.push("getStoryboard");
    return Promise.resolve(this.viewValue);
  }
}

/** Snapshots the capability once and counts how often it was asked. */
class CountingCapabilityProvider implements VideoModelCapabilityProvider {
  calls = 0;
  constructor(private readonly cap: VideoModelCapability) {}
  current(): VideoModelCapability {
    this.calls += 1;
    return this.cap;
  }
}

/** Always rejects append — for the audit-failure path. */
class FailingAuditLogRepository implements AuditLogRepository {
  append(): Promise<AuditLog> {
    return Promise.reject(new Error("audit sink unavailable"));
  }
  listByOrganization(): Promise<AuditLog[]> {
    return Promise.resolve([]);
  }
}

interface HarnessConfig {
  readonly role?: Role | null;
  readonly view?: StoryboardView;
  readonly fresh?: boolean;
  readonly capability?: VideoModelCapability;
  readonly generations?: SceneGenerationRepository;
  readonly auditLogs?: AuditLogRepository;
}

function harness(config: HarnessConfig = {}) {
  const deps = createTestDeps();
  const role = config.role === undefined ? "CREATOR" : config.role;
  if (role) void deps.repos.memberships.create({ organizationId: ORG, userId: ACTOR, role });

  const inMemoryGenerations = new InMemorySceneGenerationRepository(deps.clock);
  inMemoryGenerations.registerProject(ORG, PROJECT);
  const generations = config.generations ?? inMemoryGenerations;

  const queue = new RecordingSceneGenerationQueue();
  const capabilities = new CountingCapabilityProvider(config.capability ?? capability());
  const view: StoryboardView = config.view ?? {
    project: project(),
    scenes: [scene()],
    fresh: config.fresh ?? true,
  };
  const storyboard = new StubStoryboard(view);

  const identity = config.auditLogs
    ? { ...deps, repos: { ...deps.repos, auditLogs: config.auditLogs } }
    : deps;

  const serviceDeps: GenerationServiceDeps = {
    identity,
    storyboard,
    generations,
    capabilities,
    queue,
    ids: deps.ids,
  };
  const service = new GenerationService(serviceDeps);

  return {
    service,
    serviceDeps,
    deps,
    generations: inMemoryGenerations,
    queue,
    capabilities,
    storyboard,
    audits: () => deps.repos.auditLogs.all(),
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<AppError> {
  return promise.then(
    () => {
      throw new Error("expected the operation to reject, but it resolved");
    },
    (error: unknown) => error as AppError,
  );
}

// ---------------------------------------------------------------------------

describe("startScene — authorization", () => {
  it.each(["OWNER", "ADMIN", "CREATOR"] as const)("permits %s", async (role) => {
    const h = harness({ role });
    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(result.state).toBe("QUEUED");
  });

  it("denies REVIEWER with FORBIDDEN", async () => {
    const h = harness({ role: "REVIEWER" });
    const error = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, SCENE));
    expect(error.code).toBe("FORBIDDEN");
  });

  it("denies a non-member with FORBIDDEN", async () => {
    const h = harness({ role: null });
    const error = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, SCENE));
    expect(error.code).toBe("FORBIDDEN");
  });

  it("performs no read, capability lookup, enqueue, or audit before authorization fails", async () => {
    const h = harness({ role: null });
    await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, SCENE));

    expect(h.storyboard.calls).toHaveLength(0);
    expect(h.capabilities.calls).toBe(0);
    expect(h.generations.all()).toHaveLength(0);
    expect(h.queue.count).toBe(0);
    expect(h.audits()).toHaveLength(0);
  });
});

describe("startScene — nested integrity", () => {
  it("admits a scene that belongs to the scoped project", async () => {
    const h = harness();
    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(result.sourceStoryboardSceneId).toBe(SCENE);
  });

  it("treats an unknown scene id as NOT_FOUND", async () => {
    const h = harness();
    const error = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, "scn_unknown"));
    expect(error.code).toBe("NOT_FOUND");
  });

  it("treats a scene from another project identically to an unknown one", async () => {
    // getStoryboard returns only this project's scenes, so a scene living in a
    // different project is simply absent — the same neutral NOT_FOUND, with the
    // same message, disclosing nothing about the other project or scene.
    const h = harness();
    const foreign = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, "scn_other_project"));
    const unknown = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, "scn_unknown"));

    expect(foreign.code).toBe("NOT_FOUND");
    expect(foreign.message).toBe(unknown.message);
    expect(h.generations.all()).toHaveLength(0);
  });

  it("does not disclose a foreign organization's project or scene", async () => {
    // The actor is a member of ORG only. A request naming OTHER_ORG is refused
    // at authorization, before any storyboard read.
    const h = harness();
    const error = await rejectionOf(h.service.startScene(ACTOR, OTHER_ORG, PROJECT, SCENE));
    expect(error.code).toBe("FORBIDDEN");
    expect(h.storyboard.calls).toHaveLength(0);
  });
});

describe("startScene — freshness", () => {
  function expectNothingHappened(h: ReturnType<typeof harness>): void {
    expect(h.generations.all()).toHaveLength(0);
    expect(h.queue.count).toBe(0);
    expect(h.audits()).toHaveLength(0);
  }

  it("proceeds when the storyboard is fresh", async () => {
    const h = harness({ fresh: true });
    await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(h.generations.all()).toHaveLength(1);
  });

  it("refuses a STALE storyboard with its precise message and no side effects", async () => {
    const h = harness();
    h.storyboard.freshError = new AppError(
      "VALIDATION_FAILED",
      "The approved photos have changed since this storyboard was composed; compose it again",
    );
    const error = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, SCENE));

    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toContain("approved photos have changed");
    expectNothingHappened(h);
  });

  it("refuses a NEVER_COMPOSED storyboard with its distinct message and no side effects", async () => {
    const h = harness();
    h.storyboard.freshError = new AppError(
      "VALIDATION_FAILED",
      "This project has no composed storyboard",
    );
    const error = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, SCENE));

    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toContain("no composed storyboard");
    expectNothingHappened(h);
  });

  it("refuses when assertFresh passes but the returned view is not fresh", async () => {
    // assertFresh does not throw, but getStoryboard re-derives freshness and
    // reports false. The later, more current observation wins: a known-stale
    // storyboard is never admitted.
    const h = harness({ fresh: false });
    const error = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, SCENE));

    expect(error.code).toBe("VALIDATION_FAILED");
    expect(h.storyboard.calls).toEqual(["assertFresh", "getStoryboard"]);
    expectNothingHappened(h);
  });
});

describe("startScene — prompt readiness", () => {
  it("refuses a scene with no compiled prompt before any side effect", async () => {
    const h = harness({
      view: { project: project(), scenes: [scene({ compiledPrompt: null })], fresh: true },
    });
    const error = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, SCENE));

    expect(error.code).toBe("VALIDATION_FAILED");
    expect(h.generations.all()).toHaveLength(0);
    expect(h.queue.count).toBe(0);
    expect(h.audits()).toHaveLength(0);
  });
});

describe("startScene — capability validation", () => {
  function expectRefusedBeforeAdmission(h: ReturnType<typeof harness>): void {
    expect(h.generations.all()).toHaveLength(0);
    expect(h.queue.count).toBe(0);
    expect(h.audits()).toHaveLength(0);
  }

  it("proceeds when every setting is supported", async () => {
    const h = harness();
    await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(h.generations.all()).toHaveLength(1);
  });

  it("reads the capability snapshot exactly once", async () => {
    const h = harness();
    await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(h.capabilities.calls).toBe(1);
  });

  it("refuses an unsupported duration", async () => {
    const h = harness({ capability: capability({ durationSeconds: { kind: "ENUMERATED", seconds: [6, 8] } }) });
    const error = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, SCENE));
    expect(error.code).toBe("VALIDATION_FAILED");
    expectRefusedBeforeAdmission(h);
  });

  it("refuses an unsupported resolution", async () => {
    const h = harness({ capability: capability({ resolutions: ["720p"] }) });
    const error = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, SCENE));
    expect(error.code).toBe("VALIDATION_FAILED");
    expectRefusedBeforeAdmission(h);
  });

  it("refuses an unsupported aspect ratio and never silently drops it", async () => {
    const h = harness({ capability: capability({ aspectRatios: { kind: "UNSUPPORTED" } }) });
    const error = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, SCENE));
    expect(error.code).toBe("VALIDATION_FAILED");
    expectRefusedBeforeAdmission(h);
  });

  it("refuses a non-empty negative prompt the model cannot honour", async () => {
    const h = harness({
      view: { project: project({ negativePrompt: "no people" }), scenes: [scene()], fresh: true },
      capability: capability({ negativePrompt: "UNSUPPORTED" }),
    });
    const error = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, SCENE));
    expect(error.code).toBe("VALIDATION_FAILED");
    expectRefusedBeforeAdmission(h);
  });

  it("does not require negative-prompt support for a blank/whitespace value", async () => {
    // Preserves merged 4B-1a semantics: a whitespace-only negative prompt is
    // absent, so an UNSUPPORTED model does not block the request.
    const h = harness({
      view: { project: project({ negativePrompt: "   " }), scenes: [scene()], fresh: true },
      capability: capability({ negativePrompt: "UNSUPPORTED" }),
    });
    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(result.state).toBe("QUEUED");
  });

  it("refuses a camera motion the model cannot honour", async () => {
    const h = harness({ capability: capability({ cameraMotion: "UNSUPPORTED" }) });
    const error = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, SCENE));
    expect(error.code).toBe("VALIDATION_FAILED");
    expectRefusedBeforeAdmission(h);
  });
});

describe("startScene — request identity", () => {
  it("hashes exactly the authoritative facts", async () => {
    const h = harness();
    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(result.requestHash).toBe(expectedHash());
  });

  it("is unchanged by scene position", async () => {
    const a = harness({ view: { project: project(), scenes: [scene({ position: 1 })], fresh: true } });
    const b = harness({ view: { project: project(), scenes: [scene({ position: 9 })], fresh: true } });
    const ra = await a.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    const rb = await b.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(ra.requestHash).toBe(rb.requestHash);
  });

  it("is unchanged by sourceAnalysisRevision", async () => {
    const a = harness({ view: { project: project(), scenes: [scene({ sourceAnalysisRevision: 3 })], fresh: true } });
    const b = harness({ view: { project: project(), scenes: [scene({ sourceAnalysisRevision: 11 })], fresh: true } });
    const ra = await a.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    const rb = await b.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(ra.requestHash).toBe(rb.requestHash);
  });

  it("is unchanged by the storyboard scene id", async () => {
    const a = harness({ view: { project: project(), scenes: [scene({ id: "scn_a" })], fresh: true } });
    const b = harness({ view: { project: project(), scenes: [scene({ id: "scn_b" })], fresh: true } });
    const ra = await a.service.startScene(ACTOR, ORG, PROJECT, "scn_a");
    const rb = await b.service.startScene(ACTOR, ORG, PROJECT, "scn_b");
    expect(ra.requestHash).toBe(rb.requestHash);
  });

  it("changes when providerName changes", async () => {
    const a = harness();
    const b = harness({ capability: capability({ providerName: "other-provider" }) });
    const ra = await a.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    const rb = await b.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(ra.requestHash).not.toBe(rb.requestHash);
  });

  it("changes when providerModelId changes", async () => {
    const a = harness();
    const b = harness({ capability: capability({ providerModelId: "fixture/model-v2" }) });
    const ra = await a.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    const rb = await b.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(ra.requestHash).not.toBe(rb.requestHash);
  });
});

describe("startScene — active reuse", () => {
  it.each(ACTIVE_SCENE_GENERATION_STATES)(
    "returns the existing attempt while it is %s, creating/enqueuing/auditing nothing",
    async (state) => {
      const h = harness();
      const seeded = await h.generations.create(ORG, genRow("gen_seed", state) as NewSceneGeneration);

      const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);

      expect(result.id).toBe(seeded.id);
      expect(result.state).toBe(state);
      expect(h.generations.all()).toHaveLength(1);
      expect(h.queue.count).toBe(0);
      expect(h.audits()).toHaveLength(0);
    },
  );

  it("never replaces a SUBMISSION_UNKNOWN attempt", async () => {
    const h = harness();
    await h.generations.create(ORG, genRow("gen_unknown", "SUBMISSION_UNKNOWN") as NewSceneGeneration);
    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(result.id).toBe("gen_unknown");
    expect(h.generations.all()).toHaveLength(1);
  });
});

describe("startScene — SUCCEEDED reuse", () => {
  it("returns the latest succeeded attempt, creating/enqueuing/auditing nothing", async () => {
    const h = harness();
    const seeded = await h.generations.create(ORG, genRow("gen_ok", "SUCCEEDED") as NewSceneGeneration);

    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);

    expect(result.id).toBe(seeded.id);
    expect(h.generations.all()).toHaveLength(1);
    expect(h.queue.count).toBe(0);
    expect(h.audits()).toHaveLength(0);
  });

  it.each(["FAILED_TERMINAL", "CANCELLED"] as const)(
    "permits a new attempt after a %s one",
    async (state: SceneGenerationState) => {
      const h = harness();
      await h.generations.create(ORG, genRow("gen_terminal", state) as NewSceneGeneration);

      const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);

      expect(result.state).toBe("QUEUED");
      expect(result.id).not.toBe("gen_terminal");
      expect(h.generations.all()).toHaveLength(2);
      expect(h.queue.count).toBe(1);
    },
  );
});

describe("startScene — lookup precedence", () => {
  it("prefers an active attempt over an older succeeded one", async () => {
    const h = harness();
    await h.generations.create(
      ORG,
      genRow("gen_succeeded", "SUCCEEDED", { createdAt: new Date("2026-08-01T00:00:00.000Z") }) as NewSceneGeneration,
    );
    await h.generations.create(ORG, genRow("gen_active", "PROCESSING") as NewSceneGeneration);

    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);

    expect(result.id).toBe("gen_active");
    expect(h.queue.count).toBe(0);
    expect(h.audits()).toHaveLength(0);
  });
});

// A repository whose create always conflicts, with scripted lookup responses so
// the race-recovery branch can be exercised deterministically.
class ConflictOnCreateRepo implements SceneGenerationRepository {
  createCalls = 0;
  private activeIdx = 0;
  private succeededIdx = 0;
  constructor(
    private readonly activeResponses: (SceneGeneration | null)[],
    private readonly succeededResponses: (SceneGeneration | null)[],
    private readonly createError: Error = new ActiveGenerationConflictError(),
  ) {}
  create(): Promise<SceneGeneration> {
    this.createCalls += 1;
    return Promise.reject(this.createError);
  }
  findActiveByRequestIdentity(): Promise<SceneGeneration | null> {
    const value = this.activeResponses[this.activeIdx] ?? null;
    this.activeIdx += 1;
    return Promise.resolve(value);
  }
  findLatestSucceededByRequestIdentity(): Promise<SceneGeneration | null> {
    const value = this.succeededResponses[this.succeededIdx] ?? null;
    this.succeededIdx += 1;
    return Promise.resolve(value);
  }
  findById(): Promise<SceneGeneration | null> {
    return Promise.resolve(null);
  }
  update(): Promise<SceneGeneration> {
    return Promise.reject(new Error("update is not exercised in race tests"));
  }
}

describe("startScene — race recovery", () => {
  it("returns the active winner when create conflicts", async () => {
    const winner = genRow("gen_winner", "SUBMITTING");
    const repo = new ConflictOnCreateRepo([null, winner], [null]);
    const h = harness({ generations: repo });

    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);

    expect(result.id).toBe("gen_winner");
    expect(repo.createCalls).toBe(1);
    expect(h.queue.count).toBe(0);
    expect(h.audits()).toHaveLength(0);
  });

  it("returns the succeeded winner when create conflicts and no active winner exists", async () => {
    const winner = genRow("gen_succeeded_winner", "SUCCEEDED");
    const repo = new ConflictOnCreateRepo([null, null], [null, winner]);
    const h = harness({ generations: repo });

    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);

    expect(result.id).toBe("gen_succeeded_winner");
    expect(repo.createCalls).toBe(1);
    expect(h.queue.count).toBe(0);
    expect(h.audits()).toHaveLength(0);
  });

  it("raises a neutral INTERNAL_ERROR when no winner can be found", async () => {
    const repo = new ConflictOnCreateRepo([null, null], [null, null]);
    const h = harness({ generations: repo });

    const error = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, SCENE));

    expect(error.code).toBe("INTERNAL_ERROR");
    // The message names no id, hash, tenant, provider, or database detail.
    expect(error.message).toBe("The generation request could not be completed; please try again");
    expect(repo.createCalls).toBe(1);
  });

  it("attempts create exactly once and never loops", async () => {
    const repo = new ConflictOnCreateRepo([null, null], [null, null]);
    const h = harness({ generations: repo });
    await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, SCENE));
    expect(repo.createCalls).toBe(1);
  });

  it("propagates an unrelated repository error unchanged", async () => {
    const repo = new ConflictOnCreateRepo([null], [null], new SceneGenerationNotFoundError());
    const h = harness({ generations: repo });

    const error = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, SCENE));

    expect(error).toBeInstanceOf(SceneGenerationNotFoundError);
    expect(h.queue.count).toBe(0);
    expect(h.audits()).toHaveLength(0);
  });
});

describe("startScene — new-attempt initialization", () => {
  it("pins every field of a genuinely new attempt", async () => {
    const h = harness();
    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);

    expect(result.id).toMatch(/^gen_/);
    expect(result.videoProjectId).toBe(PROJECT);
    expect(result.sourceStoryboardSceneId).toBe(SCENE);
    expect(result.assetId).toBe("ast_1");
    expect(result.sourceAnalysisRevision).toBe(3);
    expect(result.requestHash).toBe(expectedHash());
    expect(result.providerName).toBe("fixture-provider");
    expect(result.providerModelId).toBe("fixture/model-v1");
    expect(result.state).toBe("QUEUED");
    expect(result.providerPredictionId).toBeNull();
    expect(result.submittedAt).toBeNull();
    expect(result.lastPolledAt).toBeNull();
    expect(result.normalizedErrorCode).toBeNull();
    expect(result.normalizedErrorMessage).toBeNull();
    expect(result.outputStorageKey).toBeNull();
  });

  it("persists the complete immutable request snapshot (ADR-0018)", async () => {
    const h = harness();
    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);

    // Taken from the admitted scene and project, not re-read from anywhere.
    expect(result.requestCompiledPrompt).toBe(scene().compiledPrompt);
    expect(result.requestDurationSeconds).toBe(scene().durationSeconds);
    expect(result.requestCameraMotion).toBe(scene().cameraMotion);
    expect(result.requestAspectRatio).toBe(project().aspectRatio);
    expect(result.requestResolution).toBe(project().resolution);
  });

  it("never writes a null snapshot for a newly admitted attempt", async () => {
    const h = harness();
    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);

    // requestCameraMotion is excluded: null is a legitimate request value there.
    expect(result.requestCompiledPrompt).not.toBeNull();
    expect(result.requestDurationSeconds).not.toBeNull();
    expect(result.requestAspectRatio).not.toBeNull();
    expect(result.requestResolution).not.toBeNull();
  });

  it("snapshots the scene duration rather than the project total", async () => {
    // The project asks for 12s overall; this scene's allocation is 5s. A worker
    // must submit 5, which is also what the hash covers.
    const h = harness();
    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(project().durationSeconds).toBe(12);
    expect(result.requestDurationSeconds).toBe(5);
  });

  it("stores the compiled prompt byte-identically, without parsing it", async () => {
    const h = harness();
    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);

    // Byte-for-byte the admitted string — a parse/re-serialize round trip would
    // reorder or reformat and silently break the hash invariant.
    expect(result.requestCompiledPrompt).toBe(scene().compiledPrompt);
    expect(computeGenerationRequestHash(generationRequestFactsFrom(result))).toBe(
      result.requestHash,
    );
  });

  it("keeps the snapshot consistent with the request hash it was admitted under", async () => {
    const h = harness();
    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(computeGenerationRequestHash(generationRequestFactsFrom(result))).toBe(
      result.requestHash,
    );
  });

  it("freezes provider and model from the single capability snapshot", async () => {
    const h = harness({ capability: capability({ providerName: "frozen-provider", providerModelId: "frozen/model" }) });
    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(result.providerName).toBe("frozen-provider");
    expect(result.providerModelId).toBe("frozen/model");
    expect(h.capabilities.calls).toBe(1);
  });
});

describe("startScene — queue", () => {
  it("enqueues a new attempt exactly once with a generationId-only payload", async () => {
    const h = harness();
    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);

    expect(h.queue.count).toBe(1);
    const [job] = h.queue.jobs();
    expect(Object.keys(job!)).toEqual(["generationId"]);
    expect(job!.generationId).toBe(result.id);
  });

  it("does not enqueue a reused attempt", async () => {
    const h = harness();
    await h.generations.create(ORG, genRow("gen_active", "QUEUED") as NewSceneGeneration);
    await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(h.queue.count).toBe(0);
  });
});

describe("startScene — enqueue failure", () => {
  it("leaves a durable QUEUED row, audits nothing, and propagates the error", async () => {
    const h = harness();
    h.queue.failNext(new Error("queue down"));

    const error = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, SCENE));

    expect(error.message).toContain("queue down");
    const rows = h.generations.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("QUEUED");
    expect(h.audits()).toHaveLength(0);
  });

  it("returns the stranded QUEUED row on a later call without re-enqueuing", async () => {
    const h = harness();
    h.queue.failNext(new Error("queue down"));
    const first = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, SCENE));
    expect(first.message).toContain("queue down");

    const stranded = h.generations.all()[0]!;
    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);

    expect(result.id).toBe(stranded.id);
    expect(h.generations.all()).toHaveLength(1);
    expect(h.queue.count).toBe(0); // never successfully enqueued, and not retried by startScene
    expect(h.audits()).toHaveLength(0);
  });
});

describe("startScene — audit", () => {
  it("emits exactly one generation.requested entry after a successful enqueue", async () => {
    const h = harness();
    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);

    const audits = h.audits();
    expect(audits).toHaveLength(1);
    const entry = audits[0]!;
    expect(entry.action).toBe("generation.requested");
    expect(entry.resourceType).toBe("scene_generation");
    expect(entry.resourceId).toBe(result.id);
    expect(entry.organizationId).toBe(ORG);
    expect(entry.actorUserId).toBe(ACTOR);
  });

  it("carries exactly the allowlisted metadata and no leaked secrets", async () => {
    const h = harness();
    await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    const metadata = h.audits()[0]!.metadata;

    expect(Object.keys(metadata).sort()).toEqual(
      [
        "assetId",
        "durationSeconds",
        "providerModelId",
        "providerName",
        "requestHash",
        "sourceAnalysisRevision",
        "sourceStoryboardSceneId",
        "state",
        "videoProjectId",
      ].sort(),
    );
    for (const forbidden of [
      "compiledPrompt",
      "prompt",
      "negativePrompt",
      "providerPredictionId",
      "outputStorageKey",
      "organizationId",
      "apiKey",
    ]) {
      expect(metadata).not.toHaveProperty(forbidden);
    }
  });

  it("does not audit active reuse", async () => {
    const h = harness();
    await h.generations.create(ORG, genRow("gen_active", "PROCESSING") as NewSceneGeneration);
    await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(h.audits()).toHaveLength(0);
  });

  it("does not audit SUCCEEDED reuse", async () => {
    const h = harness();
    await h.generations.create(ORG, genRow("gen_ok", "SUCCEEDED") as NewSceneGeneration);
    await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(h.audits()).toHaveLength(0);
  });

  it("does not audit a race winner", async () => {
    const winner = genRow("gen_winner", "SUBMITTING");
    const repo = new ConflictOnCreateRepo([null, winner], [null]);
    const h = harness({ generations: repo });
    await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(h.audits()).toHaveLength(0);
  });

  it("propagates an audit-sink failure without undoing the row or the enqueue", async () => {
    const h = harness({ auditLogs: new FailingAuditLogRepository() });

    const error = await rejectionOf(h.service.startScene(ACTOR, ORG, PROJECT, SCENE));

    expect(error.message).toContain("audit sink unavailable");
    // The row persists and the job stays enqueued exactly once — no rollback,
    // no second enqueue.
    expect(h.generations.all()).toHaveLength(1);
    expect(h.generations.all()[0]!.state).toBe("QUEUED");
    expect(h.queue.count).toBe(1);
  });
});

describe("startScene — provider/storage non-interference", () => {
  it("depends on no provider or storage collaborator", () => {
    const h = harness();
    // The wired dependency set is exactly these six; there is no
    // VideoGenerationProvider, provider factory, or storage port among them.
    expect(Object.keys(h.serviceDeps).sort()).toEqual([
      "capabilities",
      "generations",
      "identity",
      "ids",
      "queue",
      "storyboard",
    ]);
  });

  it("makes no provider call and writes no storage on a successful admission", async () => {
    // There is no provider or storage double in this harness; a run that
    // completes proves the path needs neither.
    const h = harness();
    const result = await h.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(result.state).toBe("QUEUED");
    expect(h.queue.count).toBe(1);
  });
});

describe("StoryboardReader contract", () => {
  it("is structurally satisfied by StoryboardService (compile-time)", () => {
    // If StoryboardService's assertFresh/getStoryboard signatures drift from the
    // port, this stops compiling.
    type Satisfies = StoryboardService extends StoryboardReader ? true : never;
    const contract: Satisfies = true;
    expect(contract).toBe(true);
  });
});

// Keep the fixture module honest: the default scene must actually be admissible,
// otherwise every "proceeds" assertion above would be vacuous.
describe("fixtures", () => {
  let base: ReturnType<typeof harness>;
  beforeEach(() => {
    base = harness();
  });
  it("default fixtures form an admissible request", async () => {
    const result = await base.service.startScene(ACTOR, ORG, PROJECT, SCENE);
    expect(result.state).toBe("QUEUED");
  });
});
