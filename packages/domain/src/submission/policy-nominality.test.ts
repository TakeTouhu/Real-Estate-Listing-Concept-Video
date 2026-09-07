import { describe, expect, it } from "vitest";
import {
  MAX_RECONCILIATION_WINDOW_MS,
  ReconciliationPolicy,
  isReconciliationPolicy,
  isStaleSubmitting,
  reconciliationDeadlineFor,
  staleSubmittingBoundary,
  validateReconciliationPolicy,
  type ReconciliationPolicyConfig,
} from "./reconciliation-window";
import { createSubmissionOutcomeService } from "./service";
import { decideSubmissionOutcome } from "./outcome";
import type { SubmissionOutcomeDeps } from "./ports";
import { epochMillisFromDate, type EpochMillis } from "../pricing/units";

/**
 * Two boundaries failed here, each one step short of the invariant that matters.
 *
 * The first consumed a structural type, so an unchecked literal with the right
 * two fields reached the service without ever meeting the validator.
 *
 * The second added a phantom `unique symbol` brand, which stopped a literal but
 * not a *copy*: TypeScript's spread type carries the phantom property along
 * with everything else, so `{ ...policy, reconciliationWindowMs: 86_400_001 }`
 * was still a `ReconciliationPolicy` with no cast anywhere. The brand proved
 * that some value had once passed the validator, not that the numbers being
 * consumed were still the validated ones.
 *
 * The invariant this file now proves: **copying the validated policy's public
 * values does not copy its validation authority.**
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

  it("offers no default and no second way to build a policy", async () => {
    // No default stale threshold, and in particular no reinstated fifteen
    // minutes. The class itself is exported — a nominal type has to be, and the
    // runtime guard needs it — but its constructor is private, so exporting it
    // is not an escape hatch.
    const windowModule: Record<string, unknown> = await import("./reconciliation-window");
    const names = Object.keys(windowModule);

    expect(names.filter((name) => /DEFAULT/i.test(name))).toEqual([]);
    expect(windowModule["defaultReconciliationPolicy"]).toBeUndefined();

    // Exactly one entry point that yields a policy, plus the class and its
    // read-only guard. Anything else appearing here is a new construction site.
    const policyRelated = names.filter((name) => /policy/i.test(name)).sort();
    expect(policyRelated).toEqual([
      "ReconciliationPolicy",
      "isReconciliationPolicy",
      "validateReconciliationPolicy",
    ]);
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

describe("copying a policy's values does not copy its authority", () => {
  // The bug the previous revision's suite missed entirely. Each case starts
  // from a *genuinely validated* policy — not a literal — and then rebuilds it
  // the way ordinary code rebuilds objects. Every `@ts-expect-error` here fails
  // to compile against the phantom-brand implementation, which is what makes
  // this suite discriminating rather than decorative.
  const policy = validated({
    reconciliationWindowMs: 60_000,
    staleSubmittingAfterMs: 10_000,
  });

  it("refuses a spread that raises the window past the 24-hour ceiling", () => {
    const corrupted = {
      ...policy,
      reconciliationWindowMs: MAX_RECONCILIATION_WINDOW_MS + 1,
    };
    // @ts-expect-error a reconstructed object carries no validation authority
    const accepted: ReconciliationPolicy = corrupted;
    expect(accepted.reconciliationWindowMs).toBe(MAX_RECONCILIATION_WINDOW_MS + 1);
    // And it is not one at runtime either.
    expect(isReconciliationPolicy(corrupted)).toBe(false);
  });

  it("refuses a spread that sets the stale threshold equal to the window", () => {
    const corrupted = {
      ...policy,
      staleSubmittingAfterMs: policy.reconciliationWindowMs,
    };
    // @ts-expect-error a reconstructed object carries no validation authority
    const accepted: ReconciliationPolicy = corrupted;
    expect(accepted.staleSubmittingAfterMs).toBe(60_000);
    expect(isReconciliationPolicy(corrupted)).toBe(false);
  });

  it("refuses a spread that sets a negative stale threshold", () => {
    const corrupted = { ...policy, staleSubmittingAfterMs: -1 };
    // @ts-expect-error a reconstructed object carries no validation authority
    const accepted: ReconciliationPolicy = corrupted;
    expect(accepted.staleSubmittingAfterMs).toBe(-1);
    expect(isReconciliationPolicy(corrupted)).toBe(false);
  });

  it("refuses a spread that makes a value fractional or unsafe", () => {
    const fractional = { ...policy, reconciliationWindowMs: 1.5 };
    // @ts-expect-error a reconstructed object carries no validation authority
    const asFractional: ReconciliationPolicy = fractional;
    expect(asFractional.reconciliationWindowMs).toBe(1.5);

    const unsafe = { ...policy, reconciliationWindowMs: Number.MAX_SAFE_INTEGER + 2 };
    // @ts-expect-error a reconstructed object carries no validation authority
    const asUnsafe: ReconciliationPolicy = unsafe;
    expect(asUnsafe.reconciliationWindowMs).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it("refuses an unmodified spread, because authority is not in the values", () => {
    // Even a faithful copy loses it. That is the whole point: what makes a
    // policy authoritative is where it came from, not what it contains.
    const copied = { ...policy };
    // @ts-expect-error even a faithful copy carries no validation authority
    const accepted: ReconciliationPolicy = copied;
    expect(accepted).toBeDefined();
    expect(isReconciliationPolicy(copied)).toBe(false);
  });

  it("is caught at runtime, not compile time, for an Object.assign clone", () => {
    // The one honest gap in the compile-time boundary, stated rather than
    // hidden. `Object.assign` is typed as returning an *intersection* of its
    // sources — `{} & ReconciliationPolicy & { reconciliationWindowMs: number }`
    // — so the result keeps the policy type by construction of the lib
    // signature, and no `@ts-expect-error` would fire here.
    //
    // Spread does not behave this way, and spread is what ordinary code writes.
    // For this case the runtime nominal check is what refuses it: `Object.assign`
    // copies own enumerable properties, and the private field is not one.
    const cloned = Object.assign({}, policy, { reconciliationWindowMs: 999_999_999 });
    const stillTyped: ReconciliationPolicy = cloned;
    expect(stillTyped.reconciliationWindowMs).toBe(999_999_999);

    // Not a policy, and the service boundary says so.
    expect(isReconciliationPolicy(cloned)).toBe(false);
  });

  it("refuses a JSON round trip", () => {
    const revived: unknown = JSON.parse(JSON.stringify(policy));
    expect(isReconciliationPolicy(revived)).toBe(false);
  });

  it("cannot be constructed directly", () => {
    // @ts-expect-error the constructor is private; the validator is the only way in
    const forged = new ReconciliationPolicy(60_000, 10_000);
    expect(forged).toBeDefined();
  });

  it("exposes values that cannot be edited in place", () => {
    // Getters over private fields, so there is no setter to call. Under ESM
    // strict mode the assignment throws rather than failing silently, which is
    // the better of the two failures — and either way the validated number
    // survives.
    expect(() => {
      // @ts-expect-error reconciliationWindowMs has no setter
      policy.reconciliationWindowMs = MAX_RECONCILIATION_WINDOW_MS + 1;
    }).toThrow(TypeError);
    expect(policy.reconciliationWindowMs).toBe(60_000);
  });

  it("exposes no construction path other than the validator", () => {
    // An unused escape hatch changes no behaviour, so no behavioural test can
    // see one appear. This asserts the class's own surface instead: `validate`
    // builds policies, `isPolicy` inspects them, and nothing else exists. A new
    // static — an `unchecked(w, s)`, a `fromValues`, a `create` — fails here
    // the moment it is added, which is the point at which it is cheap to argue
    // about.
    const statics = Object.getOwnPropertyNames(ReconciliationPolicy)
      .filter((name) => !["length", "name", "prototype"].includes(name))
      .sort();
    expect(statics).toEqual(["isPolicy", "validate"]);

    // And the instance surface is two read-only accessors, nothing writable.
    const accessors = Object.getOwnPropertyNames(ReconciliationPolicy.prototype)
      .filter((name) => name !== "constructor")
      .sort();
    expect(accessors).toEqual(["reconciliationWindowMs", "staleSubmittingAfterMs"]);
    for (const name of accessors) {
      const descriptor = Object.getOwnPropertyDescriptor(
        ReconciliationPolicy.prototype,
        name,
      );
      expect(descriptor?.get).toBeTypeOf("function");
      expect(descriptor?.set).toBeUndefined();
    }
  });

  it("keeps its validated numbers off the instance's own properties", () => {
    // The reason a spread copies nothing: the values live in private fields and
    // are reached through prototype accessors, so there is no own enumerable
    // property for a copy to pick up.
    expect(Object.keys(policy)).toEqual([]);
    expect(Object.getOwnPropertyNames(policy)).toEqual([]);
  });

  it("still reads its validated values through the public getters", () => {
    expect(policy.reconciliationWindowMs).toBe(60_000);
    expect(policy.staleSubmittingAfterMs).toBe(10_000);
    expect(isReconciliationPolicy(policy)).toBe(true);
  });
});

describe("the runtime defence at the service boundary", () => {
  const outcomes = {
    withAttemptOutcome: async () => {
      throw new Error("not reached");
    },
  } as unknown as Parameters<typeof createSubmissionOutcomeService>[0]["outcomes"];
  const clock = { now: () => 0 as never };

  it("refuses a forged policy that a cast smuggled past the types", () => {
    // Types cannot stop `as unknown as`. The construction boundary asks the
    // private field directly, so a forgery is refused before any work starts.
    const forged = {
      reconciliationWindowMs: MAX_RECONCILIATION_WINDOW_MS + 1,
      staleSubmittingAfterMs: 1_000,
    } as unknown as ReconciliationPolicy;
    expect(() =>
      createSubmissionOutcomeService({ outcomes, clock, policy: forged }),
    ).toThrow(/validated reconciliation policy/);
  });

  it("refuses a spread of a genuine policy just the same", () => {
    const real = validated({ reconciliationWindowMs: 60_000, staleSubmittingAfterMs: 10_000 });
    const corrupted = {
      ...real,
      reconciliationWindowMs: MAX_RECONCILIATION_WINDOW_MS + 1,
    } as unknown as ReconciliationPolicy;
    expect(() =>
      createSubmissionOutcomeService({ outcomes, clock, policy: corrupted }),
    ).toThrow(/validated reconciliation policy/);
  });

  it("accepts a genuinely validated policy", () => {
    const real = validated({ reconciliationWindowMs: 60_000, staleSubmittingAfterMs: 10_000 });
    expect(() =>
      createSubmissionOutcomeService({ outcomes, clock, policy: real }),
    ).not.toThrow();
  });
});
