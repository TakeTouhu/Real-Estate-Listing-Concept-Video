import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVE_SCENE_GENERATION_STATES,
  ActiveGenerationConflictError,
  SceneGenerationNotFoundError,
  TERMINAL_SCENE_GENERATION_STATES,
  type NewSceneGeneration,
  type SceneGenerationState,
} from "../generation/index";
import { createTestDeps } from "./in-memory";
import { InMemorySceneGenerationRepository } from "./in-memory-generation";

/**
 * The double is about to carry Phase 4B-1b's service tests, so it has to be
 * trustworthy itself. These tests prove it reproduces the *contract* the real
 * adapter proved against PostgreSQL — not Prisma's internals, which are
 * deliberately not simulated.
 */
const ORG_A = "org_a";
const ORG_B = "org_b";
const PROJECT_A = "vpr_a";
const PROJECT_A2 = "vpr_a2";
const PROJECT_B = "vpr_b";
const HASH = "sha256:aaaa";

let deps: ReturnType<typeof createTestDeps>;
let repo: InMemorySceneGenerationRepository;

function generation(id: string, o: Partial<NewSceneGeneration> = {}): NewSceneGeneration {
  return {
    id,
    videoProjectId: PROJECT_A,
    sourceStoryboardSceneId: "scn_1",
    assetId: "ast_1",
    sourceAnalysisRevision: 1,
    requestHash: HASH,
    providerName: "fixture-provider",
    providerModelId: "fixture/model-v1",
    requestCompiledPrompt: '{"preservation":[],"sceneFacts":{},"userCustomization":null}',
    requestDurationSeconds: 5,
    requestCameraMotion: "SLOW_PAN",
    requestAspectRatio: "16:9",
    requestResolution: "1080p",
    state: "QUEUED",
    providerPredictionId: null,
    submittedAt: null,
    lastPolledAt: null,
    normalizedErrorCode: null,
    normalizedErrorMessage: null,
    outputStorageKey: null,
    ...o,
  };
}

/** Capture a rejection without letting a resolved promise pass silently. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected the operation to reject, but it resolved");
    },
    (error: unknown) => error as Error,
  );
}

beforeEach(() => {
  deps = createTestDeps();
  repo = new InMemorySceneGenerationRepository(deps.clock);
  repo.registerProject(ORG_A, PROJECT_A);
  repo.registerProject(ORG_A, PROJECT_A2);
  repo.registerProject(ORG_B, PROJECT_B);
});

describe("create tenant boundary", () => {
  it("accepts a project the organization owns", async () => {
    expect((await repo.create(ORG_A, generation("gen_1"))).id).toBe("gen_1");
  });

  it("refuses another organization's project, and an unknown one, identically", async () => {
    const foreign = await rejectionOf(
      repo.create(ORG_A, generation("gen_x", { videoProjectId: PROJECT_B })),
    );
    const unknown = await rejectionOf(
      repo.create(ORG_A, generation("gen_y", { videoProjectId: "vpr_nope" })),
    );

    expect(foreign).toBeInstanceOf(SceneGenerationNotFoundError);
    expect(unknown).toBeInstanceOf(SceneGenerationNotFoundError);
    expect(unknown.message).toBe(foreign.message);
    expect(repo.all()).toHaveLength(0);
  });

  it("checks ownership before the identity, so a conflict cannot leak across tenants", async () => {
    await repo.create(ORG_B, generation("gen_b", { videoProjectId: PROJECT_B }));
    const error = await rejectionOf(
      repo.create(ORG_A, generation("gen_probe", { videoProjectId: PROJECT_B })),
    );

    expect(error).toBeInstanceOf(SceneGenerationNotFoundError);
    expect(error).not.toBeInstanceOf(ActiveGenerationConflictError);
  });
});

describe("active identity", () => {
  it.each(ACTIVE_SCENE_GENERATION_STATES)("is held while an attempt is %s", async (state) => {
    await repo.create(ORG_A, generation("gen_hold", { state }));
    const error = await rejectionOf(repo.create(ORG_A, generation("gen_dup")));

    expect(error).toBeInstanceOf(ActiveGenerationConflictError);
    expect(repo.all()).toHaveLength(1);
  });

  it.each(TERMINAL_SCENE_GENERATION_STATES)("is released once an attempt is %s", async (state) => {
    await repo.create(ORG_A, generation("gen_done", { state }));
    expect((await repo.create(ORG_A, generation("gen_next"))).id).toBe("gen_next");
    expect(repo.all()).toHaveLength(2);
  });

  it("uses the domain's active set rather than a local list", () => {
    // Imported, not restated — so the double cannot drift from the domain, and
    // therefore cannot drift from the SQL predicate the domain's test pins.
    expect([...ACTIVE_SCENE_GENERATION_STATES].sort()).toEqual(
      ["FAILED_RETRYABLE", "PROCESSING", "QUEUED", "SUBMISSION_UNKNOWN", "SUBMITTING"].sort(),
    );
  });

  it("does not collide across projects or tenants", async () => {
    await repo.create(ORG_A, generation("gen_1"));
    await repo.create(ORG_A, generation("gen_2", { videoProjectId: PROJECT_A2 }));
    await repo.create(ORG_B, generation("gen_3", { videoProjectId: PROJECT_B }));
    expect(repo.all()).toHaveLength(3);
  });

  it("finds an active attempt only for its owning organization", async () => {
    await repo.create(ORG_A, generation("gen_1"));
    expect((await repo.findActiveByRequestIdentity(ORG_A, PROJECT_A, HASH))?.id).toBe("gen_1");
    expect(await repo.findActiveByRequestIdentity(ORG_B, PROJECT_A, HASH)).toBeNull();
  });
});

describe("latest succeeded lookup", () => {
  it("returns a succeeded attempt for the owning organization", async () => {
    await repo.create(ORG_A, generation("gen_ok", { state: "SUCCEEDED" }));
    expect((await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, HASH))?.id).toBe(
      "gen_ok",
    );
  });

  it.each(ACTIVE_SCENE_GENERATION_STATES)("does not return an attempt that is %s", async (state) => {
    await repo.create(ORG_A, generation("gen_active", { state }));
    expect(await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, HASH)).toBeNull();
  });

  it.each(["FAILED_TERMINAL", "CANCELLED"] as const)(
    "does not return an attempt that is %s",
    async (state: SceneGenerationState) => {
      await repo.create(ORG_A, generation("gen_term", { state }));
      expect(await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, HASH)).toBeNull();
    },
  );

  it("returns the most recent of several, deterministically", async () => {
    await repo.create(ORG_A, generation("gen_old", { state: "SUCCEEDED" }));
    deps.clock.advanceSeconds(60);
    await repo.create(ORG_A, generation("gen_new", { state: "SUCCEEDED" }));

    const found = await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, HASH);
    expect(found?.id).toBe("gen_new");
    // Repeating the query gives the same answer; nothing depends on iteration
    // order or insertion luck.
    expect((await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, HASH))?.id).toBe(
      "gen_new",
    );
  });

  it("breaks a same-timestamp tie by id descending, exactly as Prisma does", async () => {
    // Review caught the double using insertion order here, which is NOT the
    // adapter's `id DESC`. The two disagree precisely when insertion order runs
    // opposite to lexical order — so that is what this constructs.
    //
    // Inserted "gen_zzz" FIRST and "gen_aaa" SECOND, with an identical
    // timestamp. Insertion-order-descending would answer "gen_aaa"; the
    // repository contract answers "gen_zzz". A test where the two orders agree
    // would have passed under the defect.
    await repo.create(ORG_A, generation("gen_zzz", { state: "SUCCEEDED" }));
    await repo.create(ORG_A, generation("gen_aaa", { state: "SUCCEEDED" }));

    const stored = repo.all();
    expect(stored[0]!.id).toBe("gen_zzz"); // insertion order, for contrast
    expect(stored[0]!.createdAt).toEqual(stored[1]!.createdAt); // a genuine tie

    const found = await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, HASH);
    expect(found?.id).toBe("gen_zzz");
    // And stable across repeats.
    expect((await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, HASH))?.id).toBe(
      "gen_zzz",
    );
  });

  it("prefers a newer timestamp over a lexically greater id", async () => {
    // `createdAt` is the primary key of the ordering; `id` only breaks ties.
    await repo.create(ORG_A, generation("gen_zzz", { state: "SUCCEEDED" }));
    deps.clock.advanceSeconds(60);
    await repo.create(ORG_A, generation("gen_aaa", { state: "SUCCEEDED" }));

    expect((await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, HASH))?.id).toBe(
      "gen_aaa",
    );
  });

  it("is tenant-scoped and project-scoped", async () => {
    await repo.create(ORG_A, generation("gen_ok", { state: "SUCCEEDED" }));
    expect(await repo.findLatestSucceededByRequestIdentity(ORG_B, PROJECT_A, HASH)).toBeNull();
    expect(await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A2, HASH)).toBeNull();
    expect(
      await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, "sha256:other"),
    ).toBeNull();
  });
});

describe("update", () => {
  beforeEach(async () => {
    await repo.create(ORG_A, generation("gen_1"));
  });

  it("applies changes for the owning organization", async () => {
    expect((await repo.update(ORG_A, "gen_1", { state: "SUBMITTING" })).state).toBe("SUBMITTING");
  });

  it("refuses another organization and an unknown id identically", async () => {
    const foreign = await rejectionOf(repo.update(ORG_B, "gen_1", { state: "SUCCEEDED" }));
    const unknown = await rejectionOf(repo.update(ORG_A, "gen_nope", { state: "SUCCEEDED" }));

    expect(foreign).toBeInstanceOf(SceneGenerationNotFoundError);
    expect(unknown).toBeInstanceOf(SceneGenerationNotFoundError);
    expect(unknown.message).toBe(foreign.message);
    expect((await repo.findById(ORG_A, "gen_1"))?.state).toBe("QUEUED");
  });

  it("carries the immutable request snapshot through create and read", async () => {
    const stored = (await repo.findById(ORG_A, "gen_1"))!;
    expect(stored.requestCompiledPrompt).toBe(
      '{"preservation":[],"sceneFacts":{},"userCustomization":null}',
    );
    expect(stored.requestDurationSeconds).toBe(5);
    expect(stored.requestCameraMotion).toBe("SLOW_PAN");
    expect(stored.requestAspectRatio).toBe("16:9");
    expect(stored.requestResolution).toBe("1080p");
  });

  it("cannot mutate the snapshot through an update", async () => {
    // `SceneGenerationUpdate` cannot express these fields at all, so this is a
    // compile-time guarantee first; the assertion pins the runtime behaviour of
    // an execution-field update leaving the snapshot alone.
    const before = (await repo.findById(ORG_A, "gen_1"))!;
    const after = await repo.update(ORG_A, "gen_1", {
      state: "PROCESSING",
      providerPredictionId: "pred_1",
    });

    expect(after.requestCompiledPrompt).toBe(before.requestCompiledPrompt);
    expect(after.requestDurationSeconds).toBe(before.requestDurationSeconds);
    expect(after.requestCameraMotion).toBe(before.requestCameraMotion);
    expect(after.requestAspectRatio).toBe(before.requestAspectRatio);
    expect(after.requestResolution).toBe(before.requestResolution);
  });

  it("represents a legacy attempt whose snapshot is absent", async () => {
    // Rows admitted before Phase 4B-1c carry nulls and must remain loadable
    // rather than being coerced into fabricated values.
    await repo.create(
      ORG_A,
      generation("gen_legacy", {
        requestHash: "sha256:legacy",
        requestCompiledPrompt: null,
        requestDurationSeconds: null,
        requestCameraMotion: null,
        requestAspectRatio: null,
        requestResolution: null,
      }),
    );
    const stored = (await repo.findById(ORG_A, "gen_legacy"))!;
    expect(stored.requestCompiledPrompt).toBeNull();
    expect(stored.requestDurationSeconds).toBeNull();
    expect(stored.requestAspectRatio).toBeNull();
    expect(stored.requestResolution).toBeNull();
  });

  it("leaves identity and provenance untouched", async () => {
    const before = (await repo.findById(ORG_A, "gen_1"))!;
    const after = await repo.update(ORG_A, "gen_1", {
      state: "PROCESSING",
      providerPredictionId: "pred_1",
    });

    expect(after.id).toBe(before.id);
    expect(after.videoProjectId).toBe(before.videoProjectId);
    expect(after.sourceStoryboardSceneId).toBe(before.sourceStoryboardSceneId);
    expect(after.assetId).toBe(before.assetId);
    expect(after.sourceAnalysisRevision).toBe(before.sourceAnalysisRevision);
    expect(after.requestHash).toBe(before.requestHash);
    expect(after.providerName).toBe(before.providerName);
    expect(after.providerModelId).toBe(before.providerModelId);
    expect(after.createdAt).toEqual(before.createdAt);
  });

  it("keeps providerPredictionId through a state-only update, and clears it only on request", async () => {
    await repo.update(ORG_A, "gen_1", { state: "PROCESSING", providerPredictionId: "pred_1" });
    expect((await repo.update(ORG_A, "gen_1", { state: "SUCCEEDED" })).providerPredictionId).toBe(
      "pred_1",
    );
    expect(
      (await repo.update(ORG_A, "gen_1", { providerPredictionId: null })).providerPredictionId,
    ).toBeNull();
  });
});
