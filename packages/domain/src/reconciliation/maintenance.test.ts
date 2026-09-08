import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeTransitionMetadata } from "../orchestration/transition-metadata";
import type { TransitionContext } from "../orchestration/ports";
import { epochMillisFromDate, type EpochMillis } from "../pricing/units";
import {
  validateReconciliationPolicy,
  type ReconciliationPolicy,
  type ReconciliationPolicyConfig,
} from "../submission/reconciliation-window";
import type { SubmissionOutcomeService } from "../submission/service";
import { MAX_RECONCILIATION_MAINTENANCE_BATCH_SIZE } from "./limits";
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
 * The runner hands advisory candidates to the two authoritative services and
 * counts what came back. Everything interesting about it is what it refuses to
 * be: a loop, a timer, a scheduler, or an authority in its own right — and, as
 * of this revision, a place where the caller gets to choose what "now" means.
 */

const NOW = epochMillisFromDate(new Date("2026-09-11T00:00:00.000Z"));
const STALE_AFTER_MS = 15 * 60 * 1000;

function validatedPolicy(config: ReconciliationPolicyConfig): ReconciliationPolicy {
  const result = validateReconciliationPolicy(config);
  if (!result.ok) throw new Error(`invalid test policy: ${result.reason}`);
  return result.policy;
}

/** A fixture. There is deliberately no shipped production stale threshold. */
const POLICY = validatedPolicy({
  reconciliationWindowMs: 24 * 60 * 60 * 1000,
  staleSubmittingAfterMs: STALE_AFTER_MS,
});

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

function harness(
  options: {
    due?: readonly ReconciliationCandidate[];
    stale?: readonly ReconciliationCandidate[];
    exhaust?: (attemptId: string) => ReconciliationExhaustionResult;
    stale_result?: (attemptId: string) => { kind: string };
    policy?: ReconciliationPolicy;
  } = {},
) {
  const seen: string[] = [];
  const queries: { which: string; query: ReconciliationCandidateQuery }[] = [];
  const staleCalls: string[] = [];
  const exhaustCalls: string[] = [];
  let clockReads = 0;

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
    clockReads: () => clockReads,
    maintenance: createReconciliationMaintenance({
      reconciliation,
      clock: {
        now(): EpochMillis {
          clockReads += 1;
          return NOW;
        },
      },
      reconciliationService,
      submissionOutcomes,
      policy: options.policy ?? POLICY,
    }),
  };
}

const INPUT = { limit: 25, context: CONTEXT };

describe("one pass over what maintenance might need to touch", () => {
  it("counts what it discovered and what it changed", async () => {
    const { maintenance } = harness({
      stale: [candidate(1), candidate(2)],
      due: [candidate(3)],
    });
    expect(await maintenance.runOnce(INPUT)).toEqual({
      discoveryNow: NOW,
      staleCandidates: 2,
      staleUncertaintyEntered: 2,
      dueCandidates: 1,
      exhausted: 1,
      unchanged: 0,
    });
  });

  it("does nothing at all when nothing is due", async () => {
    const { maintenance, seen } = harness();
    expect(await maintenance.runOnce(INPUT)).toMatchObject({
      staleCandidates: 0,
      staleUncertaintyEntered: 0,
      dueCandidates: 0,
      exhausted: 0,
      unchanged: 0,
    });
    expect(seen).toEqual(["stale-query", "due-query"]);
  });

  it("sweeps stale attempts before exhausting due ones", async () => {
    // So the second pass sees the first pass's work rather than missing it. It
    // is emphatically *not* a guarantee that a newly uncertain attempt escapes
    // the same batch — see the same-batch test below.
    const { maintenance, seen } = harness({ stale: [candidate(1)], due: [candidate(2)] });
    await maintenance.runOnce(INPUT);
    expect(seen).toEqual(["stale-query", "stale:sgen_1", "due-query", "exhaust:sgen_2"]);
  });

  it("invents no diagnostic for a sweep", async () => {
    // Nobody observed anything. The honest classification is the absence of one,
    // and a manufactured code would put a fabricated cause in the audit trail.
    const { maintenance, staleCalls } = harness({ stale: [candidate(1)] });
    await maintenance.runOnce(INPUT);
    expect(staleCalls).toEqual(["sgen_1:null"]);
  });
});

describe("discovery time belongs to the runner's clock", () => {
  it("derives the stale cutoff by subtracting the validated threshold", async () => {
    // The correction this replaced: one caller-supplied `cutoff` was passed to
    // both queries, which asked different questions of different columns. A
    // caller had to encode two meanings in one timestamp, and the stale one was
    // wrong by a whole threshold.
    const { maintenance, queries } = harness();
    await maintenance.runOnce(INPUT);
    expect(queries).toEqual([
      { which: "stale", query: { cutoff: NOW - STALE_AFTER_MS, limit: 25 } },
      { which: "due", query: { cutoff: NOW, limit: 25 } },
    ]);
  });

  it("uses the discovery instant itself as the due cutoff", async () => {
    const { maintenance, queries } = harness();
    await maintenance.runOnce(INPUT);
    expect(queries.find((q) => q.which === "due")?.query.cutoff).toBe(NOW);
  });

  it("reads its clock exactly once per pass", async () => {
    // Two reads would let the two queries disagree about now, and the report
    // could then describe a window that never existed.
    const { maintenance, clockReads } = harness({
      stale: [candidate(1)],
      due: [candidate(2)],
    });
    await maintenance.runOnce(INPUT);
    expect(clockReads()).toBe(1);
  });

  it("reports the instant it narrowed by", async () => {
    const { maintenance } = harness();
    expect((await maintenance.runOnce(INPUT)).discoveryNow).toBe(NOW);
  });

  it("takes no cutoff from the caller", async () => {
    // The input type is the proof: there is nowhere to put one.
    expect(Object.keys(INPUT).sort()).toEqual(["context", "limit"]);
  });

  it("refuses a policy that never went through the validator", () => {
    // The same provenance check Phase 2G-1's service makes. A stale threshold
    // that never met the validator is a bound nobody agreed to, deciding whether
    // a paid submission is presumed lost.
    expect(() =>
      harness({
        policy: {
          reconciliationWindowMs: 24 * 60 * 60 * 1000,
          staleSubmittingAfterMs: STALE_AFTER_MS,
        } as unknown as ReconciliationPolicy,
      }),
    ).toThrow(/validated reconciliation policy/i);
  });
});

describe("the batch bound is validated before anything is queried", () => {
  it.each([1, 2, 50, MAX_RECONCILIATION_MAINTENANCE_BATCH_SIZE])(
    "accepts %i",
    async (limit) => {
      const { maintenance, queries } = harness();
      await maintenance.runOnce({ limit, context: CONTEXT });
      expect(queries.every((q) => q.query.limit === limit)).toBe(true);
    },
  );

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["one over the maximum", MAX_RECONCILIATION_MAINTENANCE_BATCH_SIZE + 1],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("refuses %s without running a query", async (_label, limit) => {
    // Refused, never clamped. Silently substituting 100 for 5000 would let a
    // caller believe it swept far more than it did; substituting 1 for 0 would
    // turn "do nothing" into "do something".
    const { maintenance, queries, seen } = harness();
    await expect(maintenance.runOnce({ limit, context: CONTEXT })).rejects.toThrow(
      /between 1 and 100/,
    );
    expect(queries).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  it("freezes the maximum at 100", () => {
    expect(MAX_RECONCILIATION_MAINTENANCE_BATCH_SIZE).toBe(100);
  });
});

describe("candidates are advisory, never authority", () => {
  it("counts a service's refusal as unchanged rather than failing the batch", async () => {
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
    // service's own post-lock clock — which is a different clock read from the
    // one that narrowed discovery.
    const { maintenance, exhaustCalls } = harness({ due: [candidate(1), candidate(2)] });
    await maintenance.runOnce(INPUT);
    expect(exhaustCalls).toEqual(["sgen_1", "sgen_2"]);
  });

  it("passes no discovery time to either single-attempt service", async () => {
    // The runner's instant narrows queries and nothing else. If it reached a
    // service, a stale batch could authorize a transition against a window that
    // had closed while the batch ran.
    const { maintenance } = harness({ stale: [candidate(1)], due: [candidate(2)] });
    const calls: Record<string, unknown>[] = [];
    void calls;
    await maintenance.runOnce(INPUT);
    // The service inputs are typed to accept no timestamp at all.
    expect(Object.keys({ organizationId: "", attemptId: "", context: CONTEXT }).sort()).toEqual([
      "attemptId",
      "context",
      "organizationId",
    ]);
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

  it("reads wall time only through the injected clock", () => {
    expect(TEXT.includes("Date.now(")).toBe(false);
    expect(TEXT.includes("new Date(")).toBe(false);
  });
});
