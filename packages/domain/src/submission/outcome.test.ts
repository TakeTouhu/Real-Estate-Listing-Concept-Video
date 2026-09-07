import { describe, expect, it } from "vitest";
import { GENERATION_ATTEMPT_STATES, SUBMISSION_CERTAINTIES } from "../orchestration/types";
import { epochMillisFromDate, type EpochMillis } from "../pricing/units";
import type { ProviderSubmissionObservation } from "./observation";
import {
  decideSubmissionOutcome,
  isRecoverableStaleSubmitting,
  type AttemptSubmissionFacts,
} from "./outcome";
import {
  MAX_RECONCILIATION_WINDOW_MS,
  reconciliationDeadlineFor,
  staleSubmittingBoundary,
  validateReconciliationPolicy,
  type ReconciliationPolicy,
  type ReconciliationPolicyConfig,
} from "./reconciliation-window";
import { parseSubmissionDiagnosticCode, type SubmissionDiagnosticCode } from "./diagnostic-code";

/**
 * What the durable record should say, decided without a database.
 *
 * The expensive mistakes in this phase are all decisions rather than writes:
 * treating a replay as new news, treating conflicting news as a replay, or
 * moving a deadline because someone asked twice. All three are reachable here
 * from plain objects.
 */


/**
 * The only way a test may obtain a policy.
 *
 * Fixtures go through the same validator production callers do, so a test can
 * never exercise the phase against a policy the type system would refuse in
 * production — which is the whole point of the validated type.
 */
function validatedPolicy(config: ReconciliationPolicyConfig): ReconciliationPolicy {
  const result = validateReconciliationPolicy(config);
  if (!result.ok) throw new Error(`invalid test policy: ${result.reason}`);
  return result.policy;
}

const BOUNDARY = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));

/**
 * A test fixture, not a product policy.
 *
 * There is deliberately no shipped default stale threshold — how long an attempt
 * may sit at the boundary before it is presumed lost is a production-activation
 * decision that depends on provider latency nobody has measured. These numbers
 * are chosen for arithmetic that is easy to read.
 */
const POLICY: ReconciliationPolicy = validatedPolicy({
  reconciliationWindowMs: 24 * 60 * 60 * 1000,
  staleSubmittingAfterMs: 15 * 60 * 1000,
});

/** Codes must pass the safe-code boundary to exist at all. */
function code(value: string): SubmissionDiagnosticCode {
  const parsed = parseSubmissionDiagnosticCode(value);
  if (!parsed.ok || parsed.code === null) throw new Error(`not a safe code: ${value}`);
  return parsed.code;
}

/** An attempt sitting exactly at the provider boundary. */
function atBoundary(overrides: Partial<AttemptSubmissionFacts> = {}): AttemptSubmissionFacts {
  return {
    attemptId: "sgen_out",
    orchestrationState: "SUBMITTING",
    submissionCertainty: "PRE_SUBMISSION",
    stateVersion: 3,
    submissionBoundaryEnteredAt: BOUNDARY,
    providerPredictionId: null,
    reconciliationStartedAt: null,
    reconciliationDeadlineAt: null,
    ...overrides,
  };
}

const ACCEPTED: ProviderSubmissionObservation = {
  kind: "ACCEPTED",
  providerPredictionId: "pred_abc",
};
const REJECTED_TERMINAL: ProviderSubmissionObservation = {
  kind: "DEFINITIVELY_REJECTED",
  retryable: false,
  normalizedErrorCode: code("LOCAL_CONFIGURATION"),
};
const REJECTED_RETRYABLE: ProviderSubmissionObservation = {
  kind: "DEFINITIVELY_REJECTED",
  retryable: true,
  normalizedErrorCode: code("CONNECTION_RESET"),
};
const UNKNOWN: ProviderSubmissionObservation = {
  kind: "SUBMISSION_UNKNOWN",
  normalizedErrorCode: code("TIMEOUT"),
};

function decide(
  facts: AttemptSubmissionFacts,
  observation: ProviderSubmissionObservation,
  now: EpochMillis = BOUNDARY,
) {
  return decideSubmissionOutcome({ facts, observation, policy: POLICY, now });
}

describe("applying a first submission outcome", () => {
  it("records an acceptance as PROCESSING with the provider's own reference", () => {
    const decision = decide(atBoundary(), ACCEPTED);
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(decision.write).toMatchObject({
      orchestrationState: "PROCESSING",
      submissionCertainty: "ACCEPTED",
      providerPredictionId: "pred_abc",
      holdReservation: false,
    });
    // Acceptance resolves the entitlement question rather than suspending it.
    expect(decision.write.reconciliationDeadlineAt).toBeNull();
  });

  it("records a terminal rejection as FAILED_TERMINAL with no reference", () => {
    const decision = decide(atBoundary(), REJECTED_TERMINAL);
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(decision.write).toMatchObject({
      orchestrationState: "FAILED_TERMINAL",
      submissionCertainty: "DEFINITIVELY_REJECTED",
      providerPredictionId: null,
      holdReservation: false,
    });
  });

  it("records a retryable rejection as FAILED_RETRYABLE, still definitively rejected", () => {
    // Both are definitive rejections — the provider did not take the work. The
    // flag says only whether a *new* attempt row may be admitted.
    const decision = decide(atBoundary(), REJECTED_RETRYABLE);
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(decision.write).toMatchObject({
      orchestrationState: "FAILED_RETRYABLE",
      submissionCertainty: "DEFINITIVELY_REJECTED",
      providerPredictionId: null,
    });
  });

  it("records uncertainty as RECONCILIATION_PENDING and suspends the hold", () => {
    const decision = decide(atBoundary(), UNKNOWN);
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(decision.write).toMatchObject({
      orchestrationState: "RECONCILIATION_PENDING",
      submissionCertainty: "SUBMISSION_UNKNOWN",
      providerPredictionId: null,
      holdReservation: true,
    });
  });

  it("separates when uncertainty began from when it must be resolved by", () => {
    // Two different facts. The *start* is when this system first durably
    // concluded it did not know, so it moves with the clock — a stale attempt
    // swept six hours later did not become uncertain at the boundary, and
    // saying so would backdate operational history. The *deadline* is derived
    // from the boundary, so it does not move, which is what stops a delayed
    // worker granting itself a longer window than a prompt one.
    const late = (BOUNDARY + 6 * 60 * 60 * 1000) as EpochMillis;
    const early = decide(atBoundary(), UNKNOWN, BOUNDARY);
    const later = decide(atBoundary(), UNKNOWN, late);
    if (early.kind !== "APPLY" || later.kind !== "APPLY") throw new Error("expected APPLY");

    expect(early.write.reconciliationStartedAt).toBe(BOUNDARY);
    expect(later.write.reconciliationStartedAt).toBe(late);

    const deadline = reconciliationDeadlineFor(BOUNDARY, POLICY);
    expect(early.write.reconciliationDeadlineAt).toBe(deadline);
    expect(later.write.reconciliationDeadlineAt).toBe(deadline);

    // Everything else the two routes would write is identical, which is what
    // makes their race benign: the loser replays rather than conflicting.
    expect({ ...later.write, reconciliationStartedAt: null }).toEqual({
      ...early.write,
      reconciliationStartedAt: null,
    });
  });

  it("never carries a provider reference on anything but an acceptance", () => {
    for (const observation of [REJECTED_TERMINAL, REJECTED_RETRYABLE, UNKNOWN]) {
      const decision = decide(atBoundary(), observation);
      if (decision.kind !== "APPLY") throw new Error("expected APPLY");
      expect(decision.write.providerPredictionId).toBeNull();
    }
  });

  it("refuses an acceptance that cannot name what was accepted", () => {
    // A reference that is blank satisfies every presence check while naming
    // nothing the provider could be asked about. That is uncertainty.
    const decision = decide(atBoundary(), {
      kind: "ACCEPTED",
      providerPredictionId: "   ",
    });
    expect(decision).toEqual({ kind: "MALFORMED_OBSERVATION" });
  });
});

describe("replay", () => {
  it("treats an identical acceptance as a replay, writing nothing", () => {
    const decision = decide(
      atBoundary({
        orchestrationState: "PROCESSING",
        submissionCertainty: "ACCEPTED",
        providerPredictionId: "pred_abc",
      }),
      ACCEPTED,
    );
    expect(decision).toEqual({ kind: "REPLAY" });
  });

  it("treats identical uncertainty as a replay, so no deadline is extended", () => {
    // The reason the deadline is anchored to the boundary at all: a retry that
    // recomputed from `now` would silently buy itself more time to resolve a
    // charge the window exists to bound.
    const decision = decide(
      atBoundary({
        orchestrationState: "RECONCILIATION_PENDING",
        submissionCertainty: "SUBMISSION_UNKNOWN",
        reconciliationStartedAt: BOUNDARY,
        reconciliationDeadlineAt: reconciliationDeadlineFor(BOUNDARY, POLICY),
      }),
      UNKNOWN,
      (BOUNDARY + 10 * 60 * 60 * 1000) as EpochMillis,
    );
    expect(decision).toEqual({ kind: "REPLAY" });
  });

  it("treats an identical rejection as a replay for either terminal shape", () => {
    expect(
      decide(
        atBoundary({
          orchestrationState: "FAILED_TERMINAL",
          submissionCertainty: "DEFINITIVELY_REJECTED",
        }),
        REJECTED_TERMINAL,
      ),
    ).toEqual({ kind: "REPLAY" });
    expect(
      decide(
        atBoundary({
          orchestrationState: "FAILED_RETRYABLE",
          submissionCertainty: "DEFINITIVELY_REJECTED",
        }),
        REJECTED_RETRYABLE,
      ),
    ).toEqual({ kind: "REPLAY" });
  });

  it("ignores a differing normalized error code, which is not provider reality", () => {
    // Two workers classifying one timeout slightly differently have not
    // disagreed about what the provider did.
    const decision = decide(
      atBoundary({
        orchestrationState: "RECONCILIATION_PENDING",
        submissionCertainty: "SUBMISSION_UNKNOWN",
      }),
      { kind: "SUBMISSION_UNKNOWN", normalizedErrorCode: code("CONNECTION_RESET") },
    );
    expect(decision).toEqual({ kind: "REPLAY" });
  });
});

describe("conflicting observations fail closed", () => {
  it("refuses a second, different provider reference", () => {
    // Overwriting either would lose the ability to ask the provider about the
    // other — and the platform may owe money against both.
    const decision = decide(
      atBoundary({
        orchestrationState: "PROCESSING",
        submissionCertainty: "ACCEPTED",
        providerPredictionId: "pred_abc",
      }),
      { ...ACCEPTED, providerPredictionId: "pred_other" },
    );
    expect(decision).toEqual({
      kind: "CONFLICT",
      reason: "PROVIDER_REFERENCE_MISMATCH",
    });
  });

  it("refuses an acceptance over recorded uncertainty", () => {
    const decision = decide(
      atBoundary({
        orchestrationState: "RECONCILIATION_PENDING",
        submissionCertainty: "SUBMISSION_UNKNOWN",
      }),
      ACCEPTED,
    );
    expect(decision).toEqual({ kind: "CONFLICT", reason: "CERTAINTY_MISMATCH" });
  });

  it("refuses uncertainty over a recorded acceptance", () => {
    const decision = decide(
      atBoundary({
        orchestrationState: "PROCESSING",
        submissionCertainty: "ACCEPTED",
        providerPredictionId: "pred_abc",
      }),
      UNKNOWN,
    );
    expect(decision).toEqual({ kind: "CONFLICT", reason: "CERTAINTY_MISMATCH" });
  });

  it("refuses a rejection over a recorded acceptance", () => {
    const decision = decide(
      atBoundary({
        orchestrationState: "PROCESSING",
        submissionCertainty: "ACCEPTED",
        providerPredictionId: "pred_abc",
      }),
      REJECTED_TERMINAL,
    );
    expect(decision).toEqual({ kind: "CONFLICT", reason: "CERTAINTY_MISMATCH" });
  });

  it("refuses a retryable rejection over a recorded terminal one", () => {
    const decision = decide(
      atBoundary({
        orchestrationState: "FAILED_TERMINAL",
        submissionCertainty: "DEFINITIVELY_REJECTED",
      }),
      REJECTED_RETRYABLE,
    );
    expect(decision).toEqual({ kind: "CONFLICT", reason: "TERMINAL_STATE_MISMATCH" });
  });

  it("refuses an acceptance whose recorded state that certainty cannot explain", () => {
    // ACCEPTED on a row sitting in RECONCILIATION_PENDING is not two observers
    // disagreeing — it is a corrupt record, and repairing it is not this
    // phase's job.
    const decision = decide(
      atBoundary({
        orchestrationState: "RECONCILIATION_PENDING",
        submissionCertainty: "ACCEPTED",
        providerPredictionId: "pred_abc",
      }),
      ACCEPTED,
    );
    expect(decision).toEqual({ kind: "CONFLICT", reason: "RECORDED_STATE_INCOHERENT" });
  });
});

describe("attempts that are not at the boundary", () => {
  it("refuses an attempt still QUEUED", () => {
    // Nothing was sent. Recording an outcome would manufacture a provider
    // interaction that did not happen.
    expect(decide(atBoundary({ orchestrationState: "QUEUED" }), ACCEPTED)).toEqual({
      kind: "NOT_AT_BOUNDARY",
      reason: "ATTEMPT_STILL_QUEUED",
    });
  });

  it("refuses an attempt cancelled before submission", () => {
    expect(
      decide(atBoundary({ orchestrationState: "CANCELLED_PRE_SUBMISSION" }), ACCEPTED),
    ).toEqual({ kind: "NOT_AT_BOUNDARY", reason: "ATTEMPT_NEVER_ENTERED_BOUNDARY" });
  });

  it("refuses a SUBMITTING row with no boundary timestamp", () => {
    // Every deadline here derives from it. Substituting a guess would put an
    // invented instant into the field that bounds an unresolved charge.
    expect(decide(atBoundary({ submissionBoundaryEnteredAt: null }), UNKNOWN)).toEqual({
      kind: "NOT_AT_BOUNDARY",
      reason: "ATTEMPT_BOUNDARY_TIMESTAMP_MISSING",
    });
  });

  it("refuses a half-written outcome on a SUBMITTING row instead of applying over it", () => {
    // `SUBMITTING + ACCEPTED` is permitted by the database CHECK constraints —
    // only `ACCEPTED` without a reference is forbidden — so a partially applied
    // write is reachable rather than hypothetical. Treating it as a fresh
    // boundary would overwrite one provider reference with another and leave
    // the platform unable to ask about the one it discarded.
    expect(
      decide(
        atBoundary({ submissionCertainty: "ACCEPTED", providerPredictionId: "pred_first" }),
        { ...ACCEPTED, providerPredictionId: "pred_second" },
      ),
    ).toEqual({ kind: "CONFLICT", reason: "CERTAINTY_MISMATCH" });
  });

  it("refuses a SUBMITTING row already carrying uncertainty", () => {
    expect(decide(atBoundary({ submissionCertainty: "SUBMISSION_UNKNOWN" }), UNKNOWN)).toEqual({
      kind: "CONFLICT",
      reason: "CERTAINTY_MISMATCH",
    });
  });

  it("gives every attempt state an answer", () => {
    // A state added to the vocabulary must land somewhere deliberate rather
    // than inheriting whichever branch happened to be last.
    for (const orchestrationState of GENERATION_ATTEMPT_STATES) {
      const decision = decide(atBoundary({ orchestrationState }), ACCEPTED);
      expect(["APPLY", "REPLAY", "CONFLICT", "NOT_AT_BOUNDARY"]).toContain(decision.kind);
    }
  });

  it("never returns an attempt to QUEUED", () => {
    // The invariant the whole submission axis protects: the provider may
    // already hold and bill for this request, so there is no state from which
    // re-POSTing this row is correct.
    for (const observation of [ACCEPTED, REJECTED_TERMINAL, REJECTED_RETRYABLE, UNKNOWN]) {
      const decision = decide(atBoundary(), observation);
      if (decision.kind !== "APPLY") continue;
      expect(decision.write.orchestrationState).not.toBe("QUEUED");
    }
  });
});

describe("the stale-SUBMITTING threshold", () => {
  it("is not stale one millisecond before its boundary", () => {
    const staleAt = staleSubmittingBoundary(BOUNDARY, POLICY);
    const result = isRecoverableStaleSubmitting({
      facts: atBoundary(),
      policy: POLICY,
      now: (staleAt - 1) as EpochMillis,
    });
    expect(result).toEqual({ stale: false, staleAt });
  });

  it("is stale exactly at its boundary", () => {
    // At-or-after, not strictly after. The opposite reading leaves one instant
    // in which nothing may act on the row.
    const staleAt = staleSubmittingBoundary(BOUNDARY, POLICY);
    expect(
      isRecoverableStaleSubmitting({ facts: atBoundary(), policy: POLICY, now: staleAt }),
    ).toEqual({ stale: true });
  });

  it("is stale after its boundary", () => {
    const staleAt = staleSubmittingBoundary(BOUNDARY, POLICY);
    expect(
      isRecoverableStaleSubmitting({
        facts: atBoundary(),
        policy: POLICY,
        now: (staleAt + 60_000) as EpochMillis,
      }),
    ).toEqual({ stale: true });
  });

  it("is never stale without a boundary timestamp", () => {
    expect(
      isRecoverableStaleSubmitting({
        facts: atBoundary({ submissionBoundaryEnteredAt: null }),
        policy: POLICY,
        now: (BOUNDARY + 10 * 24 * 60 * 60 * 1000) as EpochMillis,
      }),
    ).toEqual({ stale: false, staleAt: null });
  });
});

describe("reconciliation policy validation", () => {
  it("pins the ceiling at twenty-four hours in absolute terms", () => {
    // Every other test here compares against the constant, so a ceiling that
    // silently doubled would satisfy all of them while letting an organization
    // carry an unresolved provider charge against its Safety Guard for two days.
    // This is the one assertion that names the number.
    expect(MAX_RECONCILIATION_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(
      validateReconciliationPolicy({
        reconciliationWindowMs: 24 * 60 * 60 * 1000 + 1,
        staleSubmittingAfterMs: 60_000,
      }),
    ).toEqual({ ok: false, reason: "RECONCILIATION_WINDOW_TOO_LONG" });
  });

  it("accepts a window at the ceiling", () => {
    const result = validateReconciliationPolicy({
      reconciliationWindowMs: MAX_RECONCILIATION_WINDOW_MS,
      staleSubmittingAfterMs: 60_000,
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a window beyond 24 hours", () => {
    // An attempt in RECONCILIATION_PENDING holds uncertain provider cost
    // against the Safety Guard for the whole window.
    expect(
      validateReconciliationPolicy({
        reconciliationWindowMs: MAX_RECONCILIATION_WINDOW_MS + 1,
        staleSubmittingAfterMs: 60_000,
      }),
    ).toEqual({ ok: false, reason: "RECONCILIATION_WINDOW_TOO_LONG" });
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses a window of %s", (windowMs) => {
    expect(
      validateReconciliationPolicy({
        reconciliationWindowMs: windowMs,
        staleSubmittingAfterMs: 60_000,
      }),
    ).toEqual({ ok: false, reason: "RECONCILIATION_WINDOW_NOT_POSITIVE" });
  });

  it("refuses a non-positive stale threshold", () => {
    expect(
      validateReconciliationPolicy({
        reconciliationWindowMs: 60_000,
        staleSubmittingAfterMs: 0,
      }),
    ).toEqual({ ok: false, reason: "STALE_THRESHOLD_NOT_POSITIVE" });
  });

  it("refuses a stale threshold longer than the window", () => {
    // It would declare an attempt lost after the deadline it is supposed to be
    // given — uncertainty that expires before it begins.
    expect(
      validateReconciliationPolicy({
        reconciliationWindowMs: 60_000,
        staleSubmittingAfterMs: 60_001,
      }),
    ).toEqual({
      ok: false,
      reason: "STALE_THRESHOLD_NOT_BEFORE_RECONCILIATION_DEADLINE",
    });
  });

  it("refuses a stale threshold exactly equal to the window", () => {
    // Strictly before, not at-or-before. At equality the attempt becomes stale
    // at the very instant its reconciliation deadline arrives, so the
    // uncertainty it enters is already expired — a window that exists only as
    // an instant, which is the same defect as exceeding it.
    expect(
      validateReconciliationPolicy({
        reconciliationWindowMs: 60_000,
        staleSubmittingAfterMs: 60_000,
      }),
    ).toEqual({
      ok: false,
      reason: "STALE_THRESHOLD_NOT_BEFORE_RECONCILIATION_DEADLINE",
    });
  });

  it("accepts a stale threshold one millisecond inside the window", () => {
    expect(
      validateReconciliationPolicy({
        reconciliationWindowMs: 60_000,
        staleSubmittingAfterMs: 59_999,
      }).ok,
    ).toBe(true);
  });

  it("ships no production stale-SUBMITTING default at all", async () => {
    // A plausible-looking constant is how a guess becomes policy: the number
    // gets quoted, relied on, and never revisited. The real value depends on
    // provider latency nobody has measured, so the module must not offer one.
    const windowModule: Record<string, unknown> = await import("./reconciliation-window");
    const offered = Object.keys(windowModule).filter(
      (name) => /STALE/i.test(name) && /DEFAULT/i.test(name),
    );
    expect(offered).toEqual([]);
    expect(windowModule["defaultReconciliationPolicy"]).toBeUndefined();
  });

  it("keeps the ceiling reachable by a valid policy", () => {
    expect(
      validateReconciliationPolicy({
        reconciliationWindowMs: MAX_RECONCILIATION_WINDOW_MS,
        staleSubmittingAfterMs: MAX_RECONCILIATION_WINDOW_MS - 1,
      }).ok,
    ).toBe(true);
  });
});

describe("replay identity is provider reality, not landing state", () => {
  // The correction that matters most in this phase. An accepted attempt whose
  // execution has moved on has not contradicted its acceptance, and demanding a
  // human adjudicate a duplicate delivery of unchanged news is a false alarm
  // that costs more than the duplicate ever would.
  const acceptedStates = [
    "PROCESSING",
    "PROVIDER_SUCCEEDED",
    "OUTPUT_INGESTING",
    "OUTPUT_VERIFIED",
  ] as const;

  it.each(acceptedStates)("replays the same acceptance at %s", (orchestrationState) => {
    expect(
      decide(
        atBoundary({
          orchestrationState,
          submissionCertainty: "ACCEPTED",
          providerPredictionId: "pred_abc",
        }),
        ACCEPTED,
        (BOUNDARY + 9 * 60 * 60 * 1000) as EpochMillis,
      ),
    ).toEqual({ kind: "REPLAY" });
  });

  it.each(acceptedStates)(
    "still conflicts on a different reference at %s",
    (orchestrationState) => {
      // The reference *is* provider reality. Two of them means one names work
      // nobody ordered, at any point in the lifecycle.
      expect(
        decide(
          atBoundary({
            orchestrationState,
            submissionCertainty: "ACCEPTED",
            providerPredictionId: "pred_abc",
          }),
          { ...ACCEPTED, providerPredictionId: "pred_rival" },
        ),
      ).toEqual({ kind: "CONFLICT", reason: "PROVIDER_REFERENCE_MISMATCH" });
    },
  );

  it("replays the same acceptance on an attempt that later failed while running", () => {
    // Failing during execution does not un-accept a submission the provider
    // took and may bill for.
    expect(
      decide(
        atBoundary({
          orchestrationState: "FAILED_TERMINAL",
          submissionCertainty: "ACCEPTED",
          providerPredictionId: "pred_abc",
        }),
        ACCEPTED,
      ),
    ).toEqual({ kind: "REPLAY" });
  });

  it("replays uncertainty after the reconciliation window was exhausted", () => {
    // RECONCILIATION_EXHAUSTED says the window closed while provider reality
    // was still unknown. That is a later fact about how long nobody found out,
    // not a contradiction of the original observation — and a replay must never
    // drag the row back to RECONCILIATION_PENDING.
    expect(
      decide(
        atBoundary({
          orchestrationState: "RECONCILIATION_EXHAUSTED",
          submissionCertainty: "SUBMISSION_UNKNOWN",
          reconciliationStartedAt: (BOUNDARY + 60_000) as EpochMillis,
          reconciliationDeadlineAt: reconciliationDeadlineFor(BOUNDARY, POLICY),
        }),
        UNKNOWN,
        (BOUNDARY + 40 * 60 * 60 * 1000) as EpochMillis,
      ),
    ).toEqual({ kind: "REPLAY" });
  });

  it("does not compare the stored reconciliation start against a fresh one", () => {
    // Bookkeeping about when *this process* learned something is not provider
    // reality. Requiring the replaying worker's freshly computed value to match
    // would make every replay after the first millisecond a conflict.
    expect(
      decide(
        atBoundary({
          orchestrationState: "RECONCILIATION_PENDING",
          submissionCertainty: "SUBMISSION_UNKNOWN",
          reconciliationStartedAt: (BOUNDARY + 60_000) as EpochMillis,
          reconciliationDeadlineAt: reconciliationDeadlineFor(BOUNDARY, POLICY),
        }),
        UNKNOWN,
        (BOUNDARY + 11 * 60 * 60 * 1000) as EpochMillis,
      ),
    ).toEqual({ kind: "REPLAY" });
  });

  it("gives every (certainty, state) pair a deliberate answer", () => {
    // A state or certainty added to either vocabulary must be placed on purpose
    // rather than inheriting whichever branch happened to be last.
    for (const submissionCertainty of SUBMISSION_CERTAINTIES) {
      for (const orchestrationState of GENERATION_ATTEMPT_STATES) {
        const decision = decide(
          atBoundary({ orchestrationState, submissionCertainty, providerPredictionId: null }),
          UNKNOWN,
        );
        expect(["APPLY", "REPLAY", "CONFLICT", "NOT_AT_BOUNDARY"]).toContain(decision.kind);
      }
    }
  });
});

describe("the clock owns every instant this phase stamps", () => {
  const LATER = (BOUNDARY + 7 * 60 * 1000) as EpochMillis;

  it("stamps providerAcceptedAt from the decision clock, not the boundary", () => {
    // No frozen provider contract establishes an authoritative provider-side
    // acceptance instant, and a caller-supplied one would be an unverified
    // claim about when money started being spent.
    const decision = decide(atBoundary(), ACCEPTED, LATER);
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(decision.write.providerAcceptedAt).toBe(LATER);
    expect(decision.write.providerAcceptedAt).not.toBe(BOUNDARY);
  });

  it("ignores a providerAcceptedAt smuggled onto the observation", () => {
    // The type has no such field, so a caller inside this repository cannot
    // supply one without a cast — and a cast is exactly what a caller in a
    // hurry writes. The evaluator must read the clock regardless, because a
    // caller-chosen instant would be an unverified claim about when money
    // started being spent, and could be backdated or future-dated at will.
    const smuggled = {
      ...ACCEPTED,
      providerAcceptedAt: (BOUNDARY - 86_400_000) as EpochMillis,
    } as ProviderSubmissionObservation;
    const decision = decide(atBoundary(), smuggled, LATER);
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(decision.write.providerAcceptedAt).toBe(LATER);
  });

  it("stamps reconciliationStartedAt from the decision clock, not the boundary", () => {
    // When the system first durably concluded it did not know. For a stale
    // attempt that is hours after the boundary, and saying otherwise would
    // backdate operational history.
    const decision = decide(atBoundary(), UNKNOWN, LATER);
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(decision.write.reconciliationStartedAt).toBe(LATER);
    expect(decision.write.reconciliationStartedAt).not.toBe(BOUNDARY);
  });

  it("keeps the deadline boundary-derived however late the clock reads", () => {
    // A delayed worker inherits less remaining time; it never grants itself
    // more. This is what makes the two entry routes agree on the deadline.
    const expected = reconciliationDeadlineFor(BOUNDARY, POLICY);
    for (const now of [BOUNDARY, LATER, (BOUNDARY + 20 * 60 * 60 * 1000) as EpochMillis]) {
      const decision = decide(atBoundary(), UNKNOWN, now);
      if (decision.kind !== "APPLY") throw new Error("expected APPLY");
      expect(decision.write.reconciliationDeadlineAt).toBe(expected);
    }
  });

  it("persists an already-past deadline rather than inventing a fresh one", () => {
    // Whether that uncertainty is exhausted is Phase 2G-2's decision. Extending
    // the deadline to make it look live would take that decision here, and take
    // it wrongly.
    const wayLate = (BOUNDARY + 30 * 60 * 60 * 1000) as EpochMillis;
    const decision = decide(atBoundary(), UNKNOWN, wayLate);
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(decision.write.reconciliationDeadlineAt).toBe(
      reconciliationDeadlineFor(BOUNDARY, POLICY),
    );
    expect(decision.write.reconciliationDeadlineAt).toBeLessThan(wayLate);
  });
});
