import { describe, expect, it } from "vitest";
import type { TransitionContext } from "../orchestration/ports";
import { epochMillis } from "../pricing/units";
import { JobLaunchDefect } from "./launch";
import type {
  JobLaunchCandidate,
  JobLaunchFacts,
  JobLaunchPlan,
  JobLaunchRepository,
  LaunchJobInput,
  LaunchJobOutcome,
} from "./ports";
import { JobLaunchRunner } from "./runner";

/**
 * The dormant runner against a scripted repository and planner. These hold
 * what the runner does with candidates; the database suite holds what the
 * launch commit does.
 */

function facts(jobId: string, sceneCount = 2): JobLaunchFacts {
  return {
    qualityTier: "NORMAL",
    targetOutputResolution: "720p",
    aspectRatio: "16:9",
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      generationSceneId: `${jobId}_scene_${i}`,
      initialRequestId: `${jobId}_request_${i}`,
      durationSeconds: 5,
      cameraMotion: null,
      compiledPrompt: `compiled ${i}`,
    })),
  };
}

function planFor(from: JobLaunchFacts): JobLaunchPlan {
  return {
    kind: "PLANNED",
    route: {
      providerName: "fake",
      providerModelId: "fake/model",
      requestModelKey: "fake-model",
      requestNativeGenerationResolution: "720p",
      requestResolutionNormalization: "NONE",
      requestNativeMeetsTarget: true,
    },
    scenes: from.scenes.map((scene) => ({
      generationSceneId: scene.generationSceneId,
      generationSceneRequestId: scene.initialRequestId,
      compiledPrompt: scene.compiledPrompt ?? "",
      requestRenderedPrompt: "rendered",
      pricingSnapshot: {} as never,
      fxSnapshot: {} as never,
    })),
    plannedAt: epochMillis(1_000),
  };
}

class ScriptedRepository implements JobLaunchRepository {
  readonly calls: string[] = [];
  readonly inputs: LaunchJobInput[] = [];

  constructor(
    private readonly candidates: readonly JobLaunchCandidate[],
    private readonly outcomes: Record<string, LaunchJobOutcome | "DEFECT" | "THROW">,
  ) {}

  async findJobLaunchCandidates(query: { readonly limit: number }) {
    this.calls.push(`find:${query.limit}`);
    return this.candidates;
  }

  async launchJob(input: LaunchJobInput) {
    this.calls.push(`launch:${input.organizationId}:${input.generationJobId}`);
    this.inputs.push(input);
    const outcome = this.outcomes[input.generationJobId];
    if (outcome === undefined || outcome === "THROW") throw new Error("connection lost: SELECT secret");
    if (outcome === "DEFECT") throw new JobLaunchDefect("ADMISSION_REFUSED");
    return outcome;
  }
}

class ScriptedPlanner {
  readonly planned: string[] = [];

  constructor(private readonly answers: Record<string, JobLaunchPlan | "THROW"> = {}) {}

  async plan(input: JobLaunchFacts): Promise<JobLaunchPlan> {
    const sceneId = input.scenes[0]?.generationSceneId ?? "";
    const jobId = sceneId.replace(/_scene_\d+$/, "");
    this.planned.push(jobId);
    const answer = this.answers[jobId];
    if (answer === "THROW") throw new Error("rate source down: token=secret");
    return answer ?? planFor(input);
  }
}

function context(correlationId: string): TransitionContext {
  return {
    actorType: "WORKER",
    actorUserId: null,
    correlationId,
    causationId: null,
    reasonCode: null,
    metadata: {},
    eventType: "job_launch.pass",
  };
}

function runner(repository: ScriptedRepository, planner = new ScriptedPlanner()) {
  let n = 0;
  let attempt = 0;
  let snapshot = 0;
  return new JobLaunchRunner({
    repository,
    planner,
    ids: { nextAttemptId: () => `att_${++attempt}`, nextPricingSnapshotId: () => `psn_${++snapshot}` },
    context: () => context(`corr-${++n}`),
  });
}

const LAUNCHED = (jobId: string, ids: string[]): LaunchJobOutcome => ({
  kind: "LAUNCHED",
  generationJobId: jobId,
  attemptIds: ids,
});

describe("one pass", () => {
  it("plans each candidate and hands the commit its facts, plan, fresh ids and own correlation", async () => {
    const a = facts("job_a");
    const b = facts("job_b", 1);
    const repository = new ScriptedRepository(
      [
        { organizationId: "org_a", generationJobId: "job_a", facts: a },
        { organizationId: "org_b", generationJobId: "job_b", facts: b },
      ],
      { job_a: LAUNCHED("job_a", ["att_1", "att_2"]), job_b: { kind: "AT_LIMIT" } },
    );
    const report = await runner(repository).runOnce(10);

    expect(repository.calls).toEqual(["find:10", "launch:org_a:job_a", "launch:org_b:job_b"]);
    expect(repository.inputs.map((input) => input.facts)).toEqual([a, b]);
    expect(repository.inputs.map((input) => input.plan)).toEqual([planFor(a), planFor(b)]);
    expect(repository.inputs.map((input) => input.attemptIds)).toEqual([
      [
        { attemptId: "att_1", pricingSnapshotId: "psn_1" },
        { attemptId: "att_2", pricingSnapshotId: "psn_2" },
      ],
      [{ attemptId: "att_3", pricingSnapshotId: "psn_3" }],
    ]);
    expect(repository.inputs.map((input) => input.context.correlationId)).toEqual(["corr-1", "corr-2"]);
    expect(report).toEqual({
      launched: 1,
      failed: 0,
      outcomes: [
        { organizationId: "org_a", generationJobId: "job_a", outcome: LAUNCHED("job_a", ["att_1", "att_2"]) },
        { organizationId: "org_b", generationJobId: "job_b", outcome: { kind: "AT_LIMIT" } },
      ],
    });
  });

  it("offers each organization one launch per pass", async () => {
    const repository = new ScriptedRepository(
      [
        { organizationId: "org_a", generationJobId: "job_a1", facts: facts("job_a1") },
        { organizationId: "org_a", generationJobId: "job_a2", facts: facts("job_a2") },
      ],
      { job_a1: LAUNCHED("job_a1", ["att_1", "att_2"]), job_a2: LAUNCHED("job_a2", ["att_3", "att_4"]) },
    );
    const report = await runner(repository).runOnce(5);
    expect(repository.calls).toEqual(["find:5", "launch:org_a:job_a1"]);
    expect(report.launched).toBe(1);
    expect(report.outcomes).toHaveLength(1);
  });

  it("refuses a limit it cannot honour before reading anything", async () => {
    const repository = new ScriptedRepository([], {});
    for (const bad of [0, 101, 1.5]) {
      await expect(runner(repository).runOnce(bad)).rejects.toThrow(/batch limit/);
    }
    expect(repository.calls).toEqual([]);
  });
});

describe("a job not launched", () => {
  it("is left waiting with the planner's code when there is no plan, and nothing is committed", async () => {
    const planner = new ScriptedPlanner({ job_a: { kind: "NO_PLAN", code: "NO_FX_RATE" } });
    const repository = new ScriptedRepository(
      [{ organizationId: "org_a", generationJobId: "job_a", facts: facts("job_a") }],
      {},
    );
    const report = await runner(repository, planner).runOnce(1);
    expect(repository.calls).toEqual(["find:1"]);
    expect(report).toEqual({
      launched: 0,
      failed: 0,
      outcomes: [
        { organizationId: "org_a", generationJobId: "job_a", outcome: { kind: "NOT_PLANNED", code: "NO_FX_RATE" } },
      ],
    });
  });

  it("is neither planned nor committed when its scenes are not of the start's shape", async () => {
    const planner = new ScriptedPlanner();
    const repository = new ScriptedRepository([{ organizationId: "org_a", generationJobId: "job_a", facts: null }], {});
    const report = await runner(repository, planner).runOnce(1);
    expect(planner.planned).toEqual([]);
    expect(repository.calls).toEqual(["find:1"]);
    expect(report.outcomes[0]?.outcome).toEqual({ kind: "NOT_LAUNCHABLE", reason: "SHAPE_CONFLICT" });
  });

  it("passes the commit's refusals through as they are", async () => {
    const refusals: LaunchJobOutcome[] = [
      { kind: "NO_SUBSCRIPTION" },
      { kind: "AT_LIMIT" },
      { kind: "NOT_NEXT" },
      { kind: "SAME_REQUEST_RUNNING" },
      { kind: "NOT_LAUNCHABLE", reason: "PROPERTY_DELETED" },
    ];
    const repository = new ScriptedRepository(
      refusals.map((_, i) => ({ organizationId: `org_${i}`, generationJobId: `job_${i}`, facts: facts(`job_${i}`) })),
      Object.fromEntries(refusals.map((outcome, i) => [`job_${i}`, outcome])),
    );
    const report = await runner(repository).runOnce(10);
    expect(report.outcomes.map((entry) => entry.outcome)).toEqual(refusals);
    expect(report.launched).toBe(0);
    expect(report.failed).toBe(0);
  });
});

describe("a launch that throws", () => {
  it("is that candidate's FAILED outcome, keeps only a defect's code, and the pass goes on", async () => {
    const planner = new ScriptedPlanner({ job_p: "THROW" });
    const repository = new ScriptedRepository(
      [
        { organizationId: "org_d", generationJobId: "job_d", facts: facts("job_d") },
        { organizationId: "org_t", generationJobId: "job_t", facts: facts("job_t") },
        { organizationId: "org_p", generationJobId: "job_p", facts: facts("job_p") },
        { organizationId: "org_ok", generationJobId: "job_ok", facts: facts("job_ok", 1) },
      ],
      { job_d: "DEFECT", job_t: "THROW", job_ok: LAUNCHED("job_ok", ["att_5"]) },
    );
    const report = await runner(repository, planner).runOnce(10);
    expect(report.outcomes.map((entry) => entry.outcome)).toEqual([
      { kind: "FAILED", code: "ADMISSION_REFUSED" },
      { kind: "FAILED", code: null },
      { kind: "FAILED", code: null },
      LAUNCHED("job_ok", ["att_5"]),
    ]);
    expect(report.failed).toBe(3);
    expect(report.launched).toBe(1);
    expect(JSON.stringify(report)).not.toContain("secret");
  });
});
