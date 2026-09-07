import { describe, expect, it } from "vitest";
import { GENERATION_ATTEMPT_STATES } from "../orchestration/types";
import { epochMillisFromDate, type EpochMillis } from "../pricing/units";
import type { ProviderSubmissionObservation } from "./observation";
import {
  decideSubmissionOutcome,
  isRecoverableStaleSubmitting,
  type AttemptSubmissionFacts,
} from "./outcome";
import {
  MAX_RECONCILIATION_WINDOW_MS,
  defaultReconciliationPolicy,
  reconciliationDeadlineFor,
  staleSubmittingBoundary,
  validateReconciliationPolicy,
} from "./reconciliation-window";

/**
 * What the durable record should say, decided without a database.
 *
 * The expensive mistakes in this phase are all decisions rather than writes:
 * treating a replay as new news, treating conflicting news as a replay, or
 * moving a deadline because someone asked twice. All three are reachable here
 * from plain objects.
 */

const BOUNDARY = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));
const POLICY = defaultReconciliationPolicy();

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
  providerAcceptedAt: epochMillisFromDate(new Date("2026-09-10T00:00:05.000Z")),
};
const REJECTED_TERMINAL: ProviderSubmissionObservation = {
  kind: "DEFINITIVELY_REJECTED",
  retryable: false,
  normalizedErrorCode: "INVALID_REQUEST",
};
const REJECTED_RETRYABLE: ProviderSubmissionObservation = {
  kind: "DEFINITIVELY_REJECTED",
  retryable: true,
  normalizedErrorCode: "RATE_LIMITED",
};
const UNKNOWN: ProviderSubmissionObservation = {
  kind: "SUBMISSION_UNKNOWN",
  normalizedErrorCode: "TIMEOUT",
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

  it("anchors both reconciliation timestamps to the submission boundary", () => {
    // Not to `now`. Decided hours later, the deadline is identical — which is
    // what makes the direct and stale-recovery paths agree.
    const late = (BOUNDARY + 6 * 60 * 60 * 1000) as EpochMillis;
    const early = decide(atBoundary(), UNKNOWN, BOUNDARY);
    const later = decide(atBoundary(), UNKNOWN, late);
    if (early.kind !== "APPLY" || later.kind !== "APPLY") throw new Error("expected APPLY");
    expect(early.write.reconciliationStartedAt).toBe(BOUNDARY);
    expect(early.write.reconciliationDeadlineAt).toBe(
      reconciliationDeadlineFor(BOUNDARY, POLICY),
    );
    expect(later.write).toEqual(early.write);
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
      providerAcceptedAt: BOUNDARY,
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
      { kind: "SUBMISSION_UNKNOWN", normalizedErrorCode: "CONNECTION_RESET" },
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

  it("refuses a replay that would drag an advanced attempt backwards", () => {
    // The attempt was accepted and has moved past PROCESSING. Re-applying the
    // acceptance would rewrite a later execution state as an earlier one.
    const decision = decide(
      atBoundary({
        orchestrationState: "OUTPUT_VERIFIED",
        submissionCertainty: "ACCEPTED",
        providerPredictionId: "pred_abc",
      }),
      ACCEPTED,
    );
    expect(decision).toEqual({ kind: "CONFLICT", reason: "TERMINAL_STATE_MISMATCH" });
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
    ).toEqual({ ok: false, reason: "STALE_THRESHOLD_EXCEEDS_WINDOW" });
  });

  it("ships a default that is itself valid and within the ceiling", () => {
    const policy = defaultReconciliationPolicy();
    expect(validateReconciliationPolicy(policy).ok).toBe(true);
    expect(policy.reconciliationWindowMs).toBeLessThanOrEqual(MAX_RECONCILIATION_WINDOW_MS);
    expect(policy.staleSubmittingAfterMs).toBeLessThan(policy.reconciliationWindowMs);
  });
});
