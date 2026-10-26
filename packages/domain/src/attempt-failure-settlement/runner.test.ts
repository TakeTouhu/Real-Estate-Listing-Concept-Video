import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import type { TransitionContext } from "../orchestration/ports";
import { epochMillis, type EpochMillis } from "../pricing/units";
import { AttemptFailureSettlementDefect } from "./settlement";
import type {
  AttemptFailureCandidate,
  AttemptFailureSettlementOutcome,
  AttemptFailureSettlementRepository,
  SettleAttemptFailureInput,
} from "./ports";
import { AttemptFailureSettlementRunner } from "./runner";

/**
 * The dormant runner against a scripted repository. These hold what the runner
 * does with candidates; the database suite holds what the settlement does.
 */

class ScriptedRepository implements AttemptFailureSettlementRepository {
  readonly calls: string[] = [];
  readonly inputs: SettleAttemptFailureInput[] = [];

  constructor(
    private readonly candidates: readonly AttemptFailureCandidate[],
    private readonly outcomes: Record<string, AttemptFailureSettlementOutcome | "DEFECT">,
  ) {}

  async findAttemptFailureCandidates(query: { readonly limit: number }) {
    this.calls.push(`find:${query.limit}`);
    return this.candidates;
  }

  async settleAttemptFailure(input: SettleAttemptFailureInput) {
    this.calls.push(`settle:${input.organizationId}:${input.generationSceneRequestId}`);
    this.inputs.push(input);
    const outcome = this.outcomes[input.generationSceneRequestId];
    if (outcome === undefined) throw new Error("unscripted request: SELECT secret");
    if (outcome === "DEFECT") throw new AttemptFailureSettlementDefect("SETTLEMENT_LOST_UNDER_LOCK");
    return outcome;
  }
}

const RELEASED: AttemptFailureSettlementOutcome = {
  kind: "SETTLED",
  settlement: "INITIAL_FAILED",
  unitReleased: true,
};

function context(correlationId: string): TransitionContext {
  return {
    actorType: "WORKER",
    actorUserId: null,
    correlationId,
    causationId: null,
    reasonCode: null,
    metadata: {},
    eventType: "attempt_failure_settlement.pass",
  };
}

function runner(repository: ScriptedRepository, times: EpochMillis[] = []) {
  let n = 0;
  let t = 0;
  return new AttemptFailureSettlementRunner({
    repository,
    clock: () => times[t++] ?? epochMillis(1_000),
    context: () => context(`corr-${++n}`),
  });
}

describe("one pass", () => {
  it("settles each candidate once, with its own instant and correlation, and counts them", async () => {
    const repository = new ScriptedRepository(
      [
        { organizationId: "org_a", generationSceneRequestId: "req_1" },
        { organizationId: "org_b", generationSceneRequestId: "req_2" },
        { organizationId: "org_a", generationSceneRequestId: "req_3" },
        { organizationId: "org_a", generationSceneRequestId: "req_4" },
        { organizationId: "org_a", generationSceneRequestId: "req_1" },
      ],
      {
        req_1: RELEASED,
        req_2: { kind: "SETTLED", settlement: "INITIAL_FAILED", unitReleased: false },
        req_3: { kind: "SETTLED", settlement: "REGENERATION_ROLLED_BACK", unitReleased: false },
        req_4: { kind: "NOT_SETTLEABLE", reason: "JOB_NOT_GENERATING" },
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
      "settle:org_a:req_1",
      "settle:org_b:req_2",
      "settle:org_a:req_3",
      "settle:org_a:req_4",
    ]);
    expect(repository.inputs.map((i) => [i.settledAt, i.context.correlationId])).toEqual([
      [10, "corr-1"],
      [20, "corr-2"],
      [30, "corr-3"],
      [40, "corr-4"],
    ]);
    expect([report.settled, report.unitsReleased, report.failed]).toEqual([3, 1, 0]);
    expect(report.outcomes).toEqual([
      { generationSceneRequestId: "req_1", outcome: RELEASED },
      {
        generationSceneRequestId: "req_2",
        outcome: { kind: "SETTLED", settlement: "INITIAL_FAILED", unitReleased: false },
      },
      {
        generationSceneRequestId: "req_3",
        outcome: { kind: "SETTLED", settlement: "REGENERATION_ROLLED_BACK", unitReleased: false },
      },
      {
        generationSceneRequestId: "req_4",
        outcome: { kind: "NOT_SETTLEABLE", reason: "JOB_NOT_GENERATING" },
      },
    ]);
  });

  it("reports an empty pass", async () => {
    const repository = new ScriptedRepository([], {});
    expect(await runner(repository).runOnce(1)).toEqual({
      settled: 0,
      unitsReleased: 0,
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

  it("isolates a settlement that throws and goes on to the next", async () => {
    const repository = new ScriptedRepository(
      [
        { organizationId: "org_a", generationSceneRequestId: "req_defect" },
        { organizationId: "org_a", generationSceneRequestId: "req_missing" },
        { organizationId: "org_a", generationSceneRequestId: "req_1" },
      ],
      { req_defect: "DEFECT", req_1: RELEASED },
    );
    const report = await runner(repository).runOnce(5);

    expect(repository.calls).toEqual([
      "find:5",
      "settle:org_a:req_defect",
      "settle:org_a:req_missing",
      "settle:org_a:req_1",
    ]);
    // A defect keeps its code; any other error is reported without its text.
    expect(report).toEqual({
      settled: 1,
      unitsReleased: 1,
      failed: 2,
      outcomes: [
        {
          generationSceneRequestId: "req_defect",
          outcome: { kind: "FAILED", code: "SETTLEMENT_LOST_UNDER_LOCK" },
        },
        { generationSceneRequestId: "req_missing", outcome: { kind: "FAILED", code: null } },
        { generationSceneRequestId: "req_1", outcome: RELEASED },
      ],
    });
  });
});
