import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import type { TransitionContext } from "../orchestration/ports";
import { epochMillis, type EpochMillis } from "../pricing/units";
import { FailedJobSceneClosureDefect } from "./closure";
import type {
  CloseFailedJobSceneInput,
  FailedJobSceneCandidate,
  FailedJobSceneClosureOutcome,
  FailedJobSceneClosureRepository,
} from "./ports";
import { FailedJobSceneClosureRunner } from "./runner";

/**
 * The dormant runner against a scripted repository. These hold what the runner
 * does with candidates; the database suite holds what the closure does.
 */

class ScriptedRepository implements FailedJobSceneClosureRepository {
  readonly calls: string[] = [];
  readonly inputs: CloseFailedJobSceneInput[] = [];

  constructor(
    private readonly candidates: readonly FailedJobSceneCandidate[],
    private readonly outcomes: Record<string, FailedJobSceneClosureOutcome | "DEFECT">,
  ) {}

  async findFailedJobSceneCandidates(query: { readonly limit: number }) {
    this.calls.push(`find:${query.limit}`);
    return this.candidates;
  }

  async closeFailedJobScene(input: CloseFailedJobSceneInput) {
    this.calls.push(`close:${input.organizationId}:${input.generationSceneId}`);
    this.inputs.push(input);
    const outcome = this.outcomes[input.generationSceneId];
    if (outcome === undefined) throw new Error("unscripted scene: SELECT secret");
    if (outcome === "DEFECT") throw new FailedJobSceneClosureDefect("CLOSURE_LOST_UNDER_LOCK");
    return outcome;
  }
}

const FAILED_TWO: FailedJobSceneClosureOutcome = {
  kind: "CLOSED",
  scene: "FAILED_TERMINAL",
  attemptsCancelled: 2,
};

function context(correlationId: string): TransitionContext {
  return {
    actorType: "WORKER",
    actorUserId: null,
    correlationId,
    causationId: null,
    reasonCode: null,
    metadata: {},
    eventType: "failed_job_scene_closure.pass",
  };
}

function runner(repository: ScriptedRepository, times: EpochMillis[] = []) {
  let n = 0;
  let t = 0;
  return new FailedJobSceneClosureRunner({
    repository,
    clock: () => times[t++] ?? epochMillis(1_000),
    context: () => context(`corr-${++n}`),
  });
}

describe("one pass", () => {
  it("closes each candidate once, with its own instant and correlation, and counts them", async () => {
    const repository = new ScriptedRepository(
      [
        { organizationId: "org_a", generationSceneId: "scene_1" },
        { organizationId: "org_b", generationSceneId: "scene_2" },
        { organizationId: "org_a", generationSceneId: "scene_3" },
        { organizationId: "org_a", generationSceneId: "scene_4" },
        { organizationId: "org_a", generationSceneId: "scene_1" },
      ],
      {
        scene_1: FAILED_TWO,
        scene_2: { kind: "CLOSED", scene: "CANCELLED", attemptsCancelled: 0 },
        scene_3: { kind: "NOT_CLOSABLE", reason: "ATTEMPT_IN_FLIGHT" },
        scene_4: { kind: "CLOSED", scene: "FAILED_TERMINAL", attemptsCancelled: 1 },
      },
    );
    const report = await runner(repository, [
      epochMillis(10),
      epochMillis(20),
      epochMillis(30),
      epochMillis(40),
    ]).runOnce(7);

    expect(repository.calls).toEqual([
      "find:7",
      "close:org_a:scene_1",
      "close:org_b:scene_2",
      "close:org_a:scene_3",
      "close:org_a:scene_4",
    ]);
    expect(repository.inputs.map((i) => [i.closedAt, i.context.correlationId])).toEqual([
      [10, "corr-1"],
      [20, "corr-2"],
      [30, "corr-3"],
      [40, "corr-4"],
    ]);
    expect([report.closed, report.attemptsCancelled, report.failed]).toEqual([3, 3, 0]);
    expect(report.outcomes).toEqual([
      { generationSceneId: "scene_1", outcome: FAILED_TWO },
      {
        generationSceneId: "scene_2",
        outcome: { kind: "CLOSED", scene: "CANCELLED", attemptsCancelled: 0 },
      },
      {
        generationSceneId: "scene_3",
        outcome: { kind: "NOT_CLOSABLE", reason: "ATTEMPT_IN_FLIGHT" },
      },
      {
        generationSceneId: "scene_4",
        outcome: { kind: "CLOSED", scene: "FAILED_TERMINAL", attemptsCancelled: 1 },
      },
    ]);
  });

  it("reports an empty pass", async () => {
    const repository = new ScriptedRepository([], {});
    expect(await runner(repository).runOnce(1)).toEqual({
      closed: 0,
      attemptsCancelled: 0,
      failed: 0,
      outcomes: [],
    });
    expect(repository.calls).toEqual(["find:1"]);
  });

  it("refuses an unusable bound before asking for candidates", async () => {
    const repository = new ScriptedRepository([], {});
    for (const bad of [0, 101, 1.5, Number.NaN]) {
      await expect(runner(repository).runOnce(bad)).rejects.toThrow(AppError);
    }
    expect(repository.calls).toEqual([]);
  });

  it("isolates a closure that throws and goes on to the next", async () => {
    const repository = new ScriptedRepository(
      [
        { organizationId: "org_a", generationSceneId: "scene_defect" },
        { organizationId: "org_a", generationSceneId: "scene_missing" },
        { organizationId: "org_a", generationSceneId: "scene_1" },
      ],
      { scene_defect: "DEFECT", scene_1: FAILED_TWO },
    );
    const report = await runner(repository).runOnce(5);

    expect(repository.calls).toEqual([
      "find:5",
      "close:org_a:scene_defect",
      "close:org_a:scene_missing",
      "close:org_a:scene_1",
    ]);
    // A defect keeps its code; any other error is reported without its text.
    expect(report).toEqual({
      closed: 1,
      attemptsCancelled: 2,
      failed: 2,
      outcomes: [
        {
          generationSceneId: "scene_defect",
          outcome: { kind: "FAILED", code: "CLOSURE_LOST_UNDER_LOCK" },
        },
        { generationSceneId: "scene_missing", outcome: { kind: "FAILED", code: null } },
        { generationSceneId: "scene_1", outcome: FAILED_TWO },
      ],
    });
  });
});
