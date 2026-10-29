import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import type { TransitionContext } from "../orchestration/ports";
import {
  DeliverableCompositionDefect,
  MAX_COMPOSITION_PLAN_BATCH_SIZE,
  type AdmitCompositionPlanOutcome,
} from "./plan";
import type {
  AdmitCompositionPlanInput,
  CompositionPlanCandidate,
  DeliverableCompositionPlanRepository,
} from "./ports";
import { CompositionPlanRunner } from "./runner";

/**
 * The dormant runner against a scripted repository. These hold what the runner
 * does with candidates; the database suite holds what Transaction I does.
 */

class ScriptedRepository implements DeliverableCompositionPlanRepository {
  readonly calls: string[] = [];
  readonly inputs: AdmitCompositionPlanInput[] = [];

  constructor(
    private readonly candidates: readonly CompositionPlanCandidate[] | "THROW",
    private readonly outcomes: Record<string, AdmitCompositionPlanOutcome | "DEFECT">,
  ) {}

  async findCompositionPlanCandidates(query: { readonly limit: number }) {
    this.calls.push(`find:${query.limit}`);
    if (this.candidates === "THROW") throw new Error("connection lost: SELECT secret");
    return this.candidates;
  }

  async admitCompositionPlan(input: AdmitCompositionPlanInput) {
    this.calls.push(`admit:${input.organizationId}:${input.generationJobId}`);
    this.inputs.push(input);
    const outcome = this.outcomes[input.generationJobId];
    if (outcome === undefined) throw new Error("unscripted job: SELECT secret");
    if (outcome === "DEFECT") {
      throw new DeliverableCompositionDefect("SOURCE_RECEIPT_BINDING_CONFLICT");
    }
    return outcome;
  }
}

const PLANNED_1: AdmitCompositionPlanOutcome = {
  kind: "PLANNED",
  deliverableVersionId: "gdv_1",
  ordinal: 1,
  inputFingerprint: "sha256:deliverable-input:v2:aa",
};

const ALREADY: AdmitCompositionPlanOutcome = {
  kind: "ALREADY_PLANNED",
  deliverableVersionId: "gdv_old",
  ordinal: 2,
  inputFingerprint: "sha256:deliverable-input:v2:bb",
};

function context(correlationId: string): TransitionContext {
  return {
    actorType: "WORKER",
    actorUserId: null,
    correlationId,
    causationId: null,
    reasonCode: null,
    metadata: {},
    eventType: "composition_plan.pass",
  };
}

function runner(repository: ScriptedRepository) {
  let correlation = 0;
  let version = 0;
  return new CompositionPlanRunner({
    repository,
    ids: { nextDeliverableVersionId: () => `gdv_${++version}` },
    context: () => context(`corr-${++correlation}`),
  });
}

describe("one pass", () => {
  it("offers each job once, with its own version id and correlation, and counts the plans", async () => {
    const repository = new ScriptedRepository(
      [
        { organizationId: "org_a", generationJobId: "job_1" },
        { organizationId: "org_b", generationJobId: "job_2" },
        { organizationId: "org_a", generationJobId: "job_3" },
        { organizationId: "org_a", generationJobId: "job_4" },
        { organizationId: "org_a", generationJobId: "job_5" },
        { organizationId: "org_a", generationJobId: "job_1" },
      ],
      {
        job_1: PLANNED_1,
        job_2: { ...PLANNED_1, deliverableVersionId: "gdv_2", ordinal: 3 },
        job_3: ALREADY,
        job_4: { kind: "NOT_ELIGIBLE" },
        job_5: { kind: "NOT_FOUND" },
      },
    );
    const report = await runner(repository).runOnce(7);

    expect(repository.calls).toEqual([
      "find:7",
      "admit:org_a:job_1",
      "admit:org_b:job_2",
      "admit:org_a:job_3",
      "admit:org_a:job_4",
      "admit:org_a:job_5",
    ]);
    expect(repository.inputs.map((i) => [i.deliverableVersionId, i.context.correlationId])).toEqual([
      ["gdv_1", "corr-1"],
      ["gdv_2", "corr-2"],
      ["gdv_3", "corr-3"],
      ["gdv_4", "corr-4"],
      ["gdv_5", "corr-5"],
    ]);
    expect(report).toEqual({
      planned: 2,
      failed: 0,
      outcomes: [
        { generationJobId: "job_1", outcome: PLANNED_1 },
        {
          generationJobId: "job_2",
          outcome: { ...PLANNED_1, deliverableVersionId: "gdv_2", ordinal: 3 },
        },
        { generationJobId: "job_3", outcome: ALREADY },
        { generationJobId: "job_4", outcome: { kind: "NOT_ELIGIBLE" } },
        { generationJobId: "job_5", outcome: { kind: "NOT_FOUND" } },
      ],
    });
  });

  it("reports an empty pass", async () => {
    const repository = new ScriptedRepository([], {});
    expect(await runner(repository).runOnce(1)).toEqual({ planned: 0, failed: 0, outcomes: [] });
    expect(repository.calls).toEqual(["find:1"]);
  });

  it("passes the largest bound through, and refuses an unusable one before asking for candidates", async () => {
    const repository = new ScriptedRepository([], {});
    await runner(repository).runOnce(MAX_COMPOSITION_PLAN_BATCH_SIZE);
    expect(repository.calls).toEqual([`find:${MAX_COMPOSITION_PLAN_BATCH_SIZE}`]);
    for (const bad of [0, -1, MAX_COMPOSITION_PLAN_BATCH_SIZE + 1, 1.5, Number.NaN]) {
      await expect(runner(repository).runOnce(bad)).rejects.toThrow(AppError);
    }
    expect(repository.calls).toEqual([`find:${MAX_COMPOSITION_PLAN_BATCH_SIZE}`]);
  });

  it("isolates an admission that throws and goes on to the next", async () => {
    const repository = new ScriptedRepository(
      [
        { organizationId: "org_a", generationJobId: "job_defect" },
        { organizationId: "org_a", generationJobId: "job_missing" },
        { organizationId: "org_a", generationJobId: "job_1" },
      ],
      { job_defect: "DEFECT", job_1: PLANNED_1 },
    );
    const report = await runner(repository).runOnce(5);

    expect(repository.calls).toEqual([
      "find:5",
      "admit:org_a:job_defect",
      "admit:org_a:job_missing",
      "admit:org_a:job_1",
    ]);
    // A defect keeps its code; any other error is reported without its text.
    expect(report).toEqual({
      planned: 1,
      failed: 2,
      outcomes: [
        {
          generationJobId: "job_defect",
          outcome: { kind: "FAILED", code: "SOURCE_RECEIPT_BINDING_CONFLICT" },
        },
        { generationJobId: "job_missing", outcome: { kind: "FAILED", code: null } },
        { generationJobId: "job_1", outcome: PLANNED_1 },
      ],
    });
  });

  it("rejects the pass when discovery throws, and plans nothing", async () => {
    const repository = new ScriptedRepository("THROW", {});
    await expect(runner(repository).runOnce(3)).rejects.toThrow("connection lost");
    expect(repository.calls).toEqual(["find:3"]);
  });
});
