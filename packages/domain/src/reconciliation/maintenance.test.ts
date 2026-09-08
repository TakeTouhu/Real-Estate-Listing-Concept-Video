import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeTransitionMetadata } from "../orchestration/transition-metadata";
import type { TransitionContext } from "../orchestration/ports";
import { epochMillis, epochMillisFromDate, type EpochMillis } from "../pricing/units";
import type { SubmissionOutcomeService } from "../submission/service";
import { createReconciliationMaintenance } from "./maintenance";
import type {
  ReconciliationCandidate,
  ReconciliationCandidateQuery,
  ReconciliationExhaustionResult,
  ReconciliationRepository,
} from "./ports";
import type { ReconciliationService } from "./service";

/**
 * One batch, and only one.
 *
 * The runner's job is to hand advisory candidates to the two authoritative
 * services and count what came back. Everything interesting about it is what it
 * refuses to be: a loop, a timer, a scheduler, or an authority in its own right.
 */

const NOW = epochMillisFromDate(new Date("2026-09-11T00:00:00.000Z"));

const CONTEXT: TransitionContext = {
  actorType: "SYSTEM",
  actorUserId: null,
  correlationId: "corr_batch",
  causationId: null,
  reasonCode: null,
  eventType: "CALLER_CHOSEN",
  metadata: sanitizeTransitionMetadata({}),
};

function candidate(n: number): ReconciliationCandidate {
  return { organizationId: "org_batch", attemptId: `sgen_${n}` };
}

function harness(options: {
  due?: readonly ReconciliationCandidate[];
  stale?: readonly ReconciliationCandidate[];
  exhaust?: (attemptId: string) => ReconciliationExhaustionResult;
  stale_result?: (attemptId: string) => { kind: string };
} = {}) {
  const seen: string[] = [];
  const queries: { which: string; query: ReconciliationCandidateQuery }[] = [];
  const staleCalls: string[] = [];
  const exhaustCalls: string[] = [];

  const reconciliation: ReconciliationRepository = {
    async withReconcilingAttempt() {
      throw new Error("the batch runner must not open its own transaction");
    },
    async findDueReconciliationCandidates(query) {
      seen.push("due-query");
      queries.push({ which: "due", query });
      return options.due ?? [];
    },
    async findStaleSubmittingCandidates(query) {
      seen.push("stale-query");
      queries.push({ which: "stale", query });
      return options.stale ?? [];
    },
  };

  const reconciliationService = {
    async resolveReconciliation() {
      throw new Error("a batch never resolves — it has no evidence to resolve with");
    },
    async exhaustReconciliation(input: { attemptId: string }) {
      seen.push(`exhaust:${input.attemptId}`);
      exhaustCalls.push(input.attemptId);
      return (
        options.exhaust?.(input.attemptId) ?? {
          kind: "EXHAUSTED" as const,
          attemptId: input.attemptId,
          stateVersion: 2,
          entitlementAnomaly: "NONE" as const,
        }
      );
    },
  } as unknown as ReconciliationService;

  const submissionOutcomes = {
    async recordObservation() {
      throw new Error("a batch observes nothing directly");
    },
    async enterUncertaintyForStaleSubmitting(input: {
      attemptId: string;
      normalizedErrorCode: string | null;
    }) {
      seen.push(`stale:${input.attemptId}`);
      staleCalls.push(`${input.attemptId}:${String(input.normalizedErrorCode)}`);
      return (
        options.stale_result?.(input.attemptId) ?? {
          kind: "APPLIED",
          attemptId: input.attemptId,
          stateVersion: 2,
          entitlementAnomaly: "NONE",
        }
      );
    },
  } as unknown as SubmissionOutcomeService;

  return {
    seen,
    queries,
    staleCalls,
    exhaustCalls,
    maintenance: createReconciliationMaintenance({
      reconciliation,
      clock: { now: (): EpochMillis => NOW },
      reconciliationService,
      submissionOutcomes,
    }),
  };
}

const INPUT = { cutoff: NOW, limit: 25, context: CONTEXT };

describe("one pass over what maintenance might need to touch", () => {
  it("counts what it discovered and what it changed", async () => {
    const { maintenance } = harness({
      stale: [candidate(1), candidate(2)],
      due: [candidate(3)],
    });
    expect(await maintenance.runOnce(INPUT)).toEqual({
      staleCandidates: 2,
      staleUncertaintyEntered: 2,
      dueCandidates: 1,
      exhausted: 1,
      unchanged: 0,
    });
  });

  it("does nothing at all when nothing is due", async () => {
    const { maintenance, seen } = harness();
    expect(await maintenance.runOnce(INPUT)).toEqual({
      staleCandidates: 0,
      staleUncertaintyEntered: 0,
      dueCandidates: 0,
      exhausted: 0,
      unchanged: 0,
    });
    expect(seen).toEqual(["stale-query", "due-query"]);
  });

  it("sweeps stale attempts before exhausting due ones", async () => {
    // A stale sweep *creates* uncertainty with a deadline in the future, so
    // doing it first means a newly uncertain attempt is never exhausted in the
    // same batch that discovered it.
    const { maintenance, seen } = harness({ stale: [candidate(1)], due: [candidate(2)] });
    await maintenance.runOnce(INPUT);
    expect(seen).toEqual(["stale-query", "stale:sgen_1", "due-query", "exhaust:sgen_2"]);
  });

  it("passes the caller's cutoff and bound to both queries", async () => {
    const { maintenance, queries } = harness();
    await maintenance.runOnce({ ...INPUT, cutoff: epochMillis(NOW - 5_000), limit: 7 });
    expect(queries).toEqual([
      { which: "stale", query: { cutoff: NOW - 5_000, limit: 7 } },
      { which: "due", query: { cutoff: NOW - 5_000, limit: 7 } },
    ]);
  });

  it("invents no diagnostic for a sweep", async () => {
    // Nobody observed anything. The honest classification is the absence of one,
    // and a manufactured code would put a fabricated cause in the audit trail.
    const { maintenance, staleCalls } = harness({ stale: [candidate(1)] });
    await maintenance.runOnce(INPUT);
    expect(staleCalls).toEqual(["sgen_1:null"]);
  });
});

describe("candidates are advisory, never authority", () => {
  it("counts a service's refusal as unchanged rather than failing the batch", async () => {
    // Between the query and the act, another worker may have resolved the
    // attempt. That is expected contention, not an error.
    const { maintenance } = harness({
      due: [candidate(1), candidate(2)],
      exhaust: (id) =>
        id === "sgen_1"
          ? { kind: "EXHAUSTED", attemptId: id, stateVersion: 2, entitlementAnomaly: "NONE" }
          : { kind: "NOT_RECONCILING", reason: "ATTEMPT_NEVER_BECAME_UNCERTAIN" },
    });
    expect(await maintenance.runOnce(INPUT)).toMatchObject({
      dueCandidates: 2,
      exhausted: 1,
      unchanged: 1,
    });
  });

  it.each([
    ["ALREADY_EXHAUSTED", { kind: "ALREADY_EXHAUSTED", attemptId: "sgen_1" }],
    ["ATTEMPT_NOT_FOUND", { kind: "ATTEMPT_NOT_FOUND" }],
    ["NOT_DUE", { kind: "NOT_DUE", dueAt: NOW }],
    ["LOST_CONCURRENCY", { kind: "LOST_CONCURRENCY" }],
  ] as const)("treats %s as unchanged, not as success", async (_label, result) => {
    const { maintenance } = harness({
      due: [candidate(1)],
      exhaust: () => result as ReconciliationExhaustionResult,
    });
    expect(await maintenance.runOnce(INPUT)).toMatchObject({ exhausted: 0, unchanged: 1 });
  });

  it("keeps going after one candidate is declined", async () => {
    const { maintenance, exhaustCalls } = harness({
      due: [candidate(1), candidate(2), candidate(3)],
      exhaust: (id) =>
        id === "sgen_1"
          ? { kind: "LOST_CONCURRENCY" }
          : { kind: "EXHAUSTED", attemptId: id, stateVersion: 2, entitlementAnomaly: "NONE" },
    });
    expect(await maintenance.runOnce(INPUT)).toMatchObject({ exhausted: 2, unchanged: 1 });
    expect(exhaustCalls).toEqual(["sgen_1", "sgen_2", "sgen_3"]);
  });

  it("counts a declined stale sweep as unchanged", async () => {
    const { maintenance } = harness({
      stale: [candidate(1)],
      stale_result: () => ({ kind: "NOT_STALE_YET" }),
    });
    expect(await maintenance.runOnce(INPUT)).toMatchObject({
      staleCandidates: 1,
      staleUncertaintyEntered: 0,
      unchanged: 1,
    });
  });

  it("re-checks every candidate through the authoritative service", async () => {
    // Never a bulk update. Each row is re-read under its own lock, against the
    // service's own post-lock clock.
    const { maintenance, exhaustCalls } = harness({
      due: [candidate(1), candidate(2)],
    });
    await maintenance.runOnce(INPUT);
    expect(exhaustCalls).toEqual(["sgen_1", "sgen_2"]);
  });
});

describe("the runner is a batch, not a daemon", () => {
  const TEXT = readFileSync(join(__dirname, "maintenance.ts"), "utf8");

  it("exposes exactly one operation", () => {
    const { maintenance } = harness();
    expect(Object.keys(maintenance)).toEqual(["runOnce"]);
  });

  it("does not loop, sleep, schedule itself or own a timer", () => {
    for (const banned of [
      "setTimeout",
      "setInterval",
      "setImmediate",
      "while (true)",
      "for (;;)",
      "runOnce()",
      "process.on",
      "cron",
    ]) {
      expect(`${banned}: ${TEXT.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("contacts no provider", () => {
    for (const banned of ["fetch(", "http", "provider.", "wavespeed", "fal."]) {
      expect(`${banned}: ${TEXT.toLowerCase().includes(banned.toLowerCase())}`).toBe(
        `${banned}: false`,
      );
    }
  });
});
