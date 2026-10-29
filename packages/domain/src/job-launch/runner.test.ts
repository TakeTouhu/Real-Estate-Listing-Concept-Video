import { describe, expect, it } from "vitest";
import type { TransitionContext } from "../orchestration/ports";
import { epochMillis } from "../pricing/units";
import { JobLaunchDefect } from "./launch";
import type {
  EndUnlaunchableJobInput,
  EndUnlaunchableJobOutcome,
  JobLaunchCandidate,
  JobLaunchFacts,
  JobLaunchNoPlanCode,
  JobLaunchPlan,
  JobLaunchRepository,
  LaunchJobInput,
  LaunchJobOutcome,
  PropertyDeletedWaitingJob,
  UnlaunchableJobEndingRepository,
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

/** The ending, sharing the repository's call log so the order of both is one sequence. */
class ScriptedEnding implements UnlaunchableJobEndingRepository {
  readonly inputs: EndUnlaunchableJobInput[] = [];

  constructor(
    private readonly calls: string[],
    private readonly deleted: readonly PropertyDeletedWaitingJob[] = [],
    private readonly outcomes: Record<string, EndUnlaunchableJobOutcome | "DEFECT" | "THROW"> = {},
  ) {}

  async findPropertyDeletedWaitingJobs(query: { readonly limit: number }) {
    this.calls.push(`deleted:${query.limit}`);
    return this.deleted;
  }

  async endUnlaunchableJob(input: EndUnlaunchableJobInput) {
    this.calls.push(`end:${input.organizationId}:${input.generationJobId}`);
    this.inputs.push(input);
    const outcome = this.outcomes[input.generationJobId];
    if (outcome === undefined || outcome === "THROW") throw new Error("deadlock detected: secret");
    if (outcome === "DEFECT") throw new JobLaunchDefect("ENDING_LOST_UNDER_LOCK");
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

function runner(
  repository: ScriptedRepository,
  planner = new ScriptedPlanner(),
  ending = new ScriptedEnding(repository.calls),
) {
  let n = 0;
  let attempt = 0;
  let snapshot = 0;
  let now = 5_000;
  return new JobLaunchRunner({
    repository,
    ending,
    planner,
    ids: { nextAttemptId: () => `att_${++attempt}`, nextPricingSnapshotId: () => `psn_${++snapshot}` },
    context: () => context(`corr-${++n}`),
    clock: () => ++now,
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

    expect(repository.calls).toEqual(["deleted:10", "find:10", "launch:org_a:job_a", "launch:org_b:job_b"]);
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
      ended: 0,
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
    expect(repository.calls).toEqual(["deleted:5", "find:5", "launch:org_a:job_a1"]);
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
    expect(repository.calls).toEqual(["deleted:1", "find:1"]);
    expect(report).toEqual({
      launched: 0,
      ended: 0,
      failed: 0,
      outcomes: [
        { organizationId: "org_a", generationJobId: "job_a", outcome: { kind: "NOT_PLANNED", code: "NO_FX_RATE" } },
      ],
    });
  });

  it.each<JobLaunchNoPlanCode>(["NO_ROUTE", "AMBIGUOUS_ROUTE", "NO_CURRENT_PRICING", "AMBIGUOUS_CURRENT_PRICING"])(
    "is left waiting, not ended, for %s: a catalog or a price can change",
    async (code) => {
      const planner = new ScriptedPlanner({ job_a: { kind: "NO_PLAN", code } });
      const repository = new ScriptedRepository(
        [{ organizationId: "org_a", generationJobId: "job_a", facts: facts("job_a") }],
        {},
      );
      const report = await runner(repository, planner).runOnce(1);
      expect(repository.calls).toEqual(["deleted:1", "find:1"]);
      expect(report.outcomes.map((entry) => entry.outcome)).toEqual([{ kind: "NOT_PLANNED", code }]);
    },
  );

  it("passes the commit's other refusals through as they are", async () => {
    const refusals: LaunchJobOutcome[] = [
      { kind: "NO_SUBSCRIPTION" },
      { kind: "AT_LIMIT" },
      { kind: "NOT_NEXT" },
      { kind: "SAME_REQUEST_RUNNING" },
      { kind: "NOT_LAUNCHABLE", reason: "NOT_WAITING" },
      { kind: "NOT_LAUNCHABLE", reason: "FACTS_CHANGED" },
    ];
    const repository = new ScriptedRepository(
      refusals.map((_, i) => ({ organizationId: `org_${i}`, generationJobId: `job_${i}`, facts: facts(`job_${i}`) })),
      Object.fromEntries(refusals.map((outcome, i) => [`job_${i}`, outcome])),
    );
    const report = await runner(repository).runOnce(10);
    expect(report.outcomes.map((entry) => entry.outcome)).toEqual(refusals);
    expect(repository.calls.filter((call) => call.startsWith("end:"))).toEqual([]);
    expect(report.launched).toBe(0);
    expect(report.failed).toBe(0);
  });
});

describe("a job that can never launch", () => {
  const ENDED = (cause: string): EndUnlaunchableJobOutcome => ({ kind: "ENDED", cause } as EndUnlaunchableJobOutcome);

  it("ends every waiting job of a deleted Property first, before any launch, at the clock's instant", async () => {
    const repository = new ScriptedRepository(
      [{ organizationId: "org_a", generationJobId: "job_a", facts: facts("job_a") }],
      { job_a: LAUNCHED("job_a", ["att_1", "att_2"]) },
    );
    const ending = new ScriptedEnding(
      repository.calls,
      [
        { organizationId: "org_a", generationJobId: "job_d1" },
        { organizationId: "org_a", generationJobId: "job_d2" },
      ],
      { job_d1: ENDED("PROPERTY_DELETED"), job_d2: ENDED("PROPERTY_DELETED") },
    );
    const report = await runner(repository, new ScriptedPlanner(), ending).runOnce(7);

    expect(repository.calls).toEqual([
      "deleted:7",
      "end:org_a:job_d1",
      "end:org_a:job_d2",
      "find:7",
      "launch:org_a:job_a",
    ]);
    expect(ending.inputs.map((input) => [input.endedAt, input.context.correlationId])).toEqual([
      [5_001, "corr-1"],
      [5_002, "corr-2"],
    ]);
    expect(report).toEqual({
      launched: 1,
      ended: 2,
      failed: 0,
      outcomes: [
        { organizationId: "org_a", generationJobId: "job_d1", outcome: ENDED("PROPERTY_DELETED") },
        { organizationId: "org_a", generationJobId: "job_d2", outcome: ENDED("PROPERTY_DELETED") },
        { organizationId: "org_a", generationJobId: "job_a", outcome: LAUNCHED("job_a", ["att_1", "att_2"]) },
      ],
    });
  });

  it.each<JobLaunchNoPlanCode>([
    "TARGET_RESOLUTION_UNKNOWN",
    "NO_SCENES",
    "SCENE_PROMPT_MISSING",
    "SCENE_PROMPT_UNRENDERABLE",
  ])(
    "is ended, not committed, when the planner refuses its own facts (%s)",
    async (code) => {
      const planner = new ScriptedPlanner({ job_a: { kind: "NO_PLAN", code } });
      const repository = new ScriptedRepository(
        [{ organizationId: "org_a", generationJobId: "job_a", facts: facts("job_a") }],
        {},
      );
      const ending = new ScriptedEnding(repository.calls, [], { job_a: ENDED(code) });
      const report = await runner(repository, planner, ending).runOnce(1);
      expect(repository.calls).toEqual(["deleted:1", "find:1", "end:org_a:job_a"]);
      expect(report.outcomes.map((entry) => entry.outcome)).toEqual([ENDED(code)]);
      expect(report.ended).toBe(1);
    },
  );

  it("is ended, neither planned nor committed, when its scenes are not of the start's shape", async () => {
    const planner = new ScriptedPlanner();
    const repository = new ScriptedRepository([{ organizationId: "org_a", generationJobId: "job_a", facts: null }], {});
    const ending = new ScriptedEnding(repository.calls, [], { job_a: ENDED("SHAPE_CONFLICT") });
    const report = await runner(repository, planner, ending).runOnce(1);
    expect(planner.planned).toEqual([]);
    expect(repository.calls).toEqual(["deleted:1", "find:1", "end:org_a:job_a"]);
    expect(report.outcomes[0]?.outcome).toEqual(ENDED("SHAPE_CONFLICT"));
  });

  it.each(["PROPERTY_DELETED", "SHAPE_CONFLICT"] as const)(
    "is ended after the commit refuses it as %s",
    async (reason) => {
      const repository = new ScriptedRepository(
        [{ organizationId: "org_a", generationJobId: "job_a", facts: facts("job_a") }],
        { job_a: { kind: "NOT_LAUNCHABLE", reason } },
      );
      const ending = new ScriptedEnding(repository.calls, [], { job_a: ENDED(reason) });
      const report = await runner(repository, new ScriptedPlanner(), ending).runOnce(1);
      expect(repository.calls).toEqual(["deleted:1", "find:1", "launch:org_a:job_a", "end:org_a:job_a"]);
      expect(ending.inputs[0]?.context.correlationId).toBe("corr-2");
      expect(report.outcomes.map((entry) => entry.outcome)).toEqual([ENDED(reason)]);
    },
  );

  it("reports the ending's refusal, which wrote nothing", async () => {
    const repository = new ScriptedRepository([{ organizationId: "org_a", generationJobId: "job_a", facts: null }], {});
    const ending = new ScriptedEnding(repository.calls, [], {
      job_a: { kind: "NOT_ENDED", reason: "ATTEMPT_ADMITTED" },
    });
    const report = await runner(repository, new ScriptedPlanner(), ending).runOnce(1);
    expect(report.outcomes.map((entry) => entry.outcome)).toEqual([{ kind: "NOT_ENDED", reason: "ATTEMPT_ADMITTED" }]);
    expect(report.ended).toBe(0);
  });

  it("is that job's FAILED outcome when the ending throws, with a defect's code alone; the pass goes on", async () => {
    const repository = new ScriptedRepository(
      [
        { organizationId: "org_s", generationJobId: "job_s", facts: null },
        { organizationId: "org_ok", generationJobId: "job_ok", facts: facts("job_ok", 1) },
      ],
      { job_ok: LAUNCHED("job_ok", ["att_1"]) },
    );
    const ending = new ScriptedEnding(
      repository.calls,
      [
        { organizationId: "org_d", generationJobId: "job_d" },
        { organizationId: "org_t", generationJobId: "job_t" },
      ],
      { job_d: "DEFECT", job_t: "THROW", job_s: "THROW" },
    );
    const report = await runner(repository, new ScriptedPlanner(), ending).runOnce(10);
    expect(report.outcomes.map((entry) => entry.outcome)).toEqual([
      { kind: "FAILED", code: "ENDING_LOST_UNDER_LOCK" },
      { kind: "FAILED", code: null },
      { kind: "FAILED", code: null },
      LAUNCHED("job_ok", ["att_1"]),
    ]);
    expect(report.failed).toBe(3);
    expect(report.launched).toBe(1);
    expect(JSON.stringify(report)).not.toContain("secret");
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
