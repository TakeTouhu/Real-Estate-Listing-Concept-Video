import { describe, expect, it } from "vitest";
import { InMemorySceneGenerationExecutionRepository } from "../testing/index";
import { SCENE_GENERATION_STATES, type SceneGeneration, type SceneGenerationState } from "./types";
import { ACTIVE_SCENE_GENERATION_STATES } from "./state-machine";
import type { SceneGenerationExecutionRepository } from "./execution-ports";

/**
 * The system-scoped execution boundary, exercised against the in-memory double.
 *
 * These cover the *contract*: what discovery returns, what a claim does, and
 * where tenant identity comes from. Concurrency itself is not provable here —
 * a single-threaded double cannot demonstrate that PostgreSQL picks one winner —
 * so the race is proven in `tests/integration/generation-execution-repository.db.test.ts`
 * against a real database. Splitting it that way is deliberate: a unit test that
 * *claimed* to prove exclusivity would be the most dangerous kind of green.
 */

const ORG_A = "org_a";
const ORG_B = "org_b";
const PROJECT_A = "vpr_a";
const PROJECT_B = "vpr_b";

function row(
  id: string,
  state: SceneGenerationState,
  overrides: Partial<SceneGeneration> = {},
): SceneGeneration {
  const now = new Date("2026-08-18T00:00:00.000Z");
  return {
    id,
    videoProjectId: PROJECT_A,
    sourceStoryboardSceneId: "scn_1",
    assetId: "ast_1",
    sourceAnalysisRevision: 1,
    requestHash: `sha256:${id}`,
    providerName: "fixture-provider",
    providerModelId: "fixture/model-v1",
    requestCompiledPrompt: '{"preservation":["r"]}',
    requestDurationSeconds: 5,
    requestCameraMotion: "SLOW_PAN_LEFT",
    requestAspectRatio: "16:9",
    requestResolution: "1080p",
    requestRenderedPrompt: "Preservation rules:\n- frozen at admission",
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

function repo(): InMemorySceneGenerationExecutionRepository {
  const r = new InMemorySceneGenerationExecutionRepository();
  r.registerProject(ORG_A, PROJECT_A);
  r.registerProject(ORG_B, PROJECT_B);
  return r;
}

describe("findNextQueuedForPreparation", () => {
  it("returns nothing when there is no queued work", async () => {
    expect(await repo().findNextQueuedForPreparation()).toBeNull();
  });

  it("returns the row with its tenant resolved from the owning project", async () => {
    const r = repo();
    r.seed(row("gen_1", "QUEUED", { videoProjectId: PROJECT_B }));

    const candidate = await r.findNextQueuedForPreparation();

    expect(candidate!.generation.id).toBe("gen_1");
    // Resolved, not supplied: nothing in the call named an organization.
    expect(candidate!.organizationId).toBe(ORG_B);
  });

  it("carries the frozen execution artifact and the immutable snapshot", async () => {
    // What a later milestone will prepare a request from. If discovery dropped
    // these, preparation would have to re-read mutable state — the exact drift
    // ADR-0018 and ADR-0023 exist to prevent.
    const r = repo();
    r.seed(row("gen_1", "QUEUED"));

    const { generation } = (await r.findNextQueuedForPreparation())!;

    expect(generation.requestRenderedPrompt).toBe("Preservation rules:\n- frozen at admission");
    expect(generation.requestCompiledPrompt).toBe('{"preservation":["r"]}');
    expect(generation.requestHash).toBe("sha256:gen_1");
  });

  it.each(SCENE_GENERATION_STATES.filter((s) => s !== "QUEUED"))(
    "never offers a %s row",
    async (state: SceneGenerationState) => {
      const r = repo();
      r.seed(row("gen_other", state));
      expect(await r.findNextQueuedForPreparation()).toBeNull();
    },
  );

  it("offers the oldest queued row first", async () => {
    const r = repo();
    r.seed(row("gen_new", "QUEUED", { createdAt: new Date("2026-08-18T03:00:00.000Z") }));
    r.seed(row("gen_old", "QUEUED", { createdAt: new Date("2026-08-18T01:00:00.000Z") }));

    expect((await r.findNextQueuedForPreparation())!.generation.id).toBe("gen_old");
  });

  it("breaks a same-instant tie deterministically by id", async () => {
    // Two rows written in the same millisecond must still have a defined order,
    // or a scan could keep returning one and starve the other.
    const same = new Date("2026-08-18T01:00:00.000Z");
    const r = repo();
    r.seed(row("gen_b", "QUEUED", { createdAt: same }));
    r.seed(row("gen_a", "QUEUED", { createdAt: same }));

    expect((await r.findNextQueuedForPreparation())!.generation.id).toBe("gen_a");
  });

  it("changes nothing it looked at", async () => {
    // Discovery is read-only, which is what makes it safe for two workers to
    // see the same candidate.
    const r = repo();
    r.seed(row("gen_1", "QUEUED"));

    await r.findNextQueuedForPreparation();
    await r.findNextQueuedForPreparation();

    expect(r.all()).toHaveLength(1);
    expect(r.all()[0]!.state).toBe("QUEUED");
  });

  it("scans across tenants rather than within one", async () => {
    // The queue is global; eligibility is the row's own state (ADR-0024).
    const r = repo();
    r.seed(row("gen_b", "QUEUED", { videoProjectId: PROJECT_B }));

    expect((await r.findNextQueuedForPreparation())!.organizationId).toBe(ORG_B);
  });
});

describe("claimQueuedForSubmission", () => {
  it("moves the row to SUBMITTING and returns it in that state", async () => {
    const r = repo();
    r.seed(row("gen_1", "QUEUED"));

    const claimed = await r.claimQueuedForSubmission("gen_1");

    // The post-claim value, not the pre-claim one — a caller acting on a stale
    // `QUEUED` copy would be reasoning about a row that no longer exists.
    expect(claimed!.generation.state).toBe("SUBMITTING");
    expect(r.all()[0]!.state).toBe("SUBMITTING");
  });

  it("resolves the tenant through the owning project", async () => {
    const r = repo();
    r.seed(row("gen_1", "QUEUED", { videoProjectId: PROJECT_B }));

    expect((await r.claimQueuedForSubmission("gen_1"))!.organizationId).toBe(ORG_B);
  });

  it("yields null to the second caller, and claims only once", async () => {
    const r = repo();
    r.seed(row("gen_1", "QUEUED"));

    const first = await r.claimQueuedForSubmission("gen_1");
    const second = await r.claimQueuedForSubmission("gen_1");

    expect(first).not.toBeNull();
    // Losing is an ordinary outcome, reported as null rather than thrown: one
    // licence to spend money, and the loser simply moves on.
    expect(second).toBeNull();
  });

  it.each(SCENE_GENERATION_STATES.filter((s) => s !== "QUEUED"))(
    "refuses a %s row",
    async (state: SceneGenerationState) => {
      const r = repo();
      r.seed(row("gen_1", state));

      expect(await r.claimQueuedForSubmission("gen_1")).toBeNull();
      expect(r.all()[0]!.state).toBe(state);
    },
  );

  it("returns null for an unknown id without inventing a row", async () => {
    const r = repo();
    expect(await r.claimQueuedForSubmission("gen_missing")).toBeNull();
    expect(r.all()).toHaveLength(0);
  });

  it("preserves the frozen prompt and every request fact", async () => {
    // The claim advances state and nothing else. Anything it rewrote here would
    // change what a later milestone submits, under a hash that still validates.
    const r = repo();
    const before = row("gen_1", "QUEUED");
    r.seed(before);

    const { generation: after } = (await r.claimQueuedForSubmission("gen_1"))!;

    expect({ ...after, state: before.state }).toEqual(before);
  });
});

describe("the execution port is separate from the tenant-facing one", () => {
  it("takes no organizationId on any method (compile-time)", () => {
    // The contract that keeps this boundary trustworthy: tenant identity is
    // *returned*, never accepted. A method that took one would let a caller
    // assert a tenant instead of resolving it, which is the whole difference
    // between this port and `SceneGenerationRepository`.
    type Discovery = Parameters<SceneGenerationExecutionRepository["findNextQueuedForPreparation"]>;
    type Claim = Parameters<SceneGenerationExecutionRepository["claimQueuedForSubmission"]>;

    const discoveryTakesNothing: Discovery extends [] ? true : never = true;
    const claimTakesOnlyAnId: Claim extends [string] ? true : never = true;

    expect(discoveryTakesNothing && claimTakesOnlyAnId).toBe(true);
  });

  it("claims into a state the domain still considers active", () => {
    // `SUBMITTING` must stay inside ACTIVE_SCENE_GENERATION_STATES: it holds the
    // request identity, so admission cannot create a duplicate attempt while a
    // claim is in flight. If that set ever stopped covering it, a claim would
    // silently open the duplicate-charge window this phase exists to close.
    expect(ACTIVE_SCENE_GENERATION_STATES).toContain("SUBMITTING");
  });
});
