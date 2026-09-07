import { describe, expect, it } from "vitest";
import {
  MAX_RECONCILIATION_WINDOW_MS,
  isStaleSubmitting,
  reconciliationDeadlineFor,
  staleSubmittingBoundary,
  validateReconciliationPolicy,
  type ReconciliationPolicy,
  type ReconciliationPolicyConfig,
} from "./reconciliation-window";
import { decideSubmissionOutcome } from "./outcome";
import type { SubmissionOutcomeDeps } from "./ports";
import { epochMillisFromDate, type EpochMillis } from "../pricing/units";

/**
 * Having a validator is not the same as enforcing one.
 *
 * While the consumed policy type was structural, this compiled and ran:
 *
 * ```ts
 * { reconciliationWindowMs: 86_400_001, staleSubmittingAfterMs: 1_000 }
 * ```
 *
 * — a window past the 24-hour ceiling, reaching the service without ever meeting
 * the validator, because it happened to have the right two fields. The bounds
 * were documented rather than enforced. This file is the proof that they are now
 * enforced by the type system rather than by convention.
 */

const BOUNDARY = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));

function validated(config: ReconciliationPolicyConfig): ReconciliationPolicy {
  const result = validateReconciliationPolicy(config);
  if (!result.ok) throw new Error(`invalid: ${result.reason}`);
  return result.policy;
}

/**
 * The exact object from the review, and the shape of every consumer.
 *
 * `@ts-expect-error` is the assertion: the test *fails to compile* if the
 * annotated line ever starts type-checking, so this is a real compile-time
 * guard rather than a comment claiming one.
 */
describe("a raw policy object cannot enter the phase", () => {
  it("does not satisfy ReconciliationPolicy", () => {
    // @ts-expect-error a raw object is not a validated policy
    const raw: ReconciliationPolicy = {
      reconciliationWindowMs: 60_000,
      staleSubmittingAfterMs: 10_000,
    };
    // Referenced so the binding is used; the assertion above is the point.
    expect(raw.reconciliationWindowMs).toBe(60_000);
  });

  it("does not satisfy ReconciliationPolicy even when out of bounds", () => {
    // The object from the correction brief: a window one millisecond past the
    // ceiling, which previously reached the service unchecked.
    // @ts-expect-error an out-of-bounds raw object is still not a validated policy
    const raw: ReconciliationPolicy = {
      reconciliationWindowMs: 86_400_001,
      staleSubmittingAfterMs: 1_000,
    };
    expect(raw.staleSubmittingAfterMs).toBe(1_000);
  });

  it("cannot be assigned to SubmissionOutcomeDeps.policy", () => {
    const config: ReconciliationPolicyConfig = {
      reconciliationWindowMs: 86_400_001,
      staleSubmittingAfterMs: 1_000,
    };
    const deps = {
      outcomes: {} as SubmissionOutcomeDeps["outcomes"],
      clock: {} as SubmissionOutcomeDeps["clock"],
      // @ts-expect-error a ReconciliationPolicyConfig is not a validated policy
      policy: config,
    } satisfies SubmissionOutcomeDeps;
    expect(deps.policy.reconciliationWindowMs).toBe(86_400_001);
  });

  it("cannot be passed to reconciliationDeadlineFor", () => {
    const config: ReconciliationPolicyConfig = {
      reconciliationWindowMs: 86_400_001,
      staleSubmittingAfterMs: 1_000,
    };
    // @ts-expect-error the deadline may only be derived from a validated policy
    expect(() => reconciliationDeadlineFor(BOUNDARY, config)).not.toThrow();
  });

  it("cannot be passed to staleSubmittingBoundary", () => {
    const config: ReconciliationPolicyConfig = {
      reconciliationWindowMs: 60_000,
      staleSubmittingAfterMs: 60_000,
    };
    // @ts-expect-error the stale boundary may only be derived from a validated policy
    expect(() => staleSubmittingBoundary(BOUNDARY, config)).not.toThrow();
  });

  it("cannot be passed to isStaleSubmitting", () => {
    const config: ReconciliationPolicyConfig = {
      reconciliationWindowMs: 60_000,
      staleSubmittingAfterMs: 10_000,
    };
    expect(
      isStaleSubmitting({
        submissionBoundaryEnteredAt: BOUNDARY,
        now: BOUNDARY,
        // @ts-expect-error staleness may only be judged against a validated policy
        policy: config,
      }),
    ).toBe(false);
  });

  it("cannot be passed to decideSubmissionOutcome", () => {
    const config: ReconciliationPolicyConfig = {
      reconciliationWindowMs: 60_000,
      staleSubmittingAfterMs: 10_000,
    };
    expect(() =>
      decideSubmissionOutcome({
        facts: {
          attemptId: "sgen_x",
          orchestrationState: "SUBMITTING",
          submissionCertainty: "PRE_SUBMISSION",
          stateVersion: 1,
          submissionBoundaryEnteredAt: BOUNDARY,
          providerPredictionId: null,
          reconciliationStartedAt: null,
          reconciliationDeadlineAt: null,
        },
        observation: { kind: "SUBMISSION_UNKNOWN", normalizedErrorCode: null },
        // @ts-expect-error the evaluator may only decide against a validated policy
        policy: config,
        now: BOUNDARY,
      }),
    ).not.toThrow();
  });

  it("accepts a policy that came through the validator", () => {
    // The positive control: the same consumers take a validated policy without
    // complaint, so the assertions above are about provenance and not about the
    // call sites being broken.
    const policy = validated({
      reconciliationWindowMs: 60_000,
      staleSubmittingAfterMs: 10_000,
    });
    expect(reconciliationDeadlineFor(BOUNDARY, policy)).toBe(BOUNDARY + 60_000);
    expect(staleSubmittingBoundary(BOUNDARY, policy)).toBe(BOUNDARY + 10_000);
  });
});

describe("what the validator refuses", () => {
  const IN_BOUNDS = 60_000;

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative Infinity", Number.NEGATIVE_INFINITY],
    ["beyond safe integer range", Number.MAX_SAFE_INTEGER + 2],
  ])("refuses a %s window", (_label, reconciliationWindowMs) => {
    const result = validateReconciliationPolicy({
      reconciliationWindowMs,
      staleSubmittingAfterMs: 1_000,
    });
    expect(result.ok).toBe(false);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("refuses a %s stale threshold", (_label, staleSubmittingAfterMs) => {
    const result = validateReconciliationPolicy({
      reconciliationWindowMs: IN_BOUNDS,
      staleSubmittingAfterMs,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts exactly the 24-hour ceiling and refuses one millisecond past it", () => {
    expect(
      validateReconciliationPolicy({
        reconciliationWindowMs: MAX_RECONCILIATION_WINDOW_MS,
        staleSubmittingAfterMs: 1_000,
      }).ok,
    ).toBe(true);
    expect(
      validateReconciliationPolicy({
        reconciliationWindowMs: MAX_RECONCILIATION_WINDOW_MS + 1,
        staleSubmittingAfterMs: 1_000,
      }),
    ).toEqual({ ok: false, reason: "RECONCILIATION_WINDOW_TOO_LONG" });
    // Named absolutely once, so a ceiling that silently doubled fails here.
    expect(MAX_RECONCILIATION_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("accepts stale one millisecond inside the window and refuses equality", () => {
    expect(
      validateReconciliationPolicy({
        reconciliationWindowMs: IN_BOUNDS,
        staleSubmittingAfterMs: IN_BOUNDS - 1,
      }).ok,
    ).toBe(true);
    expect(
      validateReconciliationPolicy({
        reconciliationWindowMs: IN_BOUNDS,
        staleSubmittingAfterMs: IN_BOUNDS,
      }),
    ).toEqual({
      ok: false,
      reason: "STALE_THRESHOLD_NOT_BEFORE_RECONCILIATION_DEADLINE",
    });
    expect(
      validateReconciliationPolicy({
        reconciliationWindowMs: IN_BOUNDS,
        staleSubmittingAfterMs: IN_BOUNDS + 1,
      }),
    ).toEqual({
      ok: false,
      reason: "STALE_THRESHOLD_NOT_BEFORE_RECONCILIATION_DEADLINE",
    });
  });

  it("passes values through unchanged rather than clamping them", () => {
    // Silently repairing an operator's number would hide the mistake rather
    // than report it, and would make the persisted deadline disagree with the
    // configuration someone believes is in force.
    const policy = validated({
      reconciliationWindowMs: 3_599_999,
      staleSubmittingAfterMs: 61,
    });
    expect(policy.reconciliationWindowMs).toBe(3_599_999);
    expect(policy.staleSubmittingAfterMs).toBe(61);
  });

  it("offers no way to build a policy without validating", async () => {
    // No default, no factory, no escape hatch — and in particular no
    // reinstated fifteen-minute production threshold.
    const windowModule: Record<string, unknown> = await import("./reconciliation-window");
    const constructors = Object.keys(windowModule).filter(
      (name) =>
        /DEFAULT/i.test(name) ||
        (/policy/i.test(name) && name !== "validateReconciliationPolicy"),
    );
    expect(constructors).toEqual([]);
  });

  it("derives the deadline from the validated window and nothing else", () => {
    const policy = validated({
      reconciliationWindowMs: 90_000,
      staleSubmittingAfterMs: 30_000,
    });
    const late = (BOUNDARY + 10 * 60 * 60 * 1000) as EpochMillis;
    expect(reconciliationDeadlineFor(BOUNDARY, policy)).toBe(BOUNDARY + 90_000);
    expect(reconciliationDeadlineFor(BOUNDARY, policy)).toBeLessThan(late);
  });
});
