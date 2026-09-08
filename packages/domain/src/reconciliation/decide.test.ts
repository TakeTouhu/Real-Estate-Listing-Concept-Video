import { describe, expect, it } from "vitest";
import { epochMillis, epochMillisFromDate, type EpochMillis } from "../pricing/units";
import type { GenerationReservationState } from "../orchestration/types";
import {
  parseSubmissionDiagnosticCode,
  type SubmissionDiagnosticCode,
} from "../submission/diagnostic-code";
import {
  decideReconciliationExhaustion,
  decideReconciliationResolution,
  type ReconcilingAttemptFacts,
} from "./decide";
import type { ReconciliationResolutionObservation } from "./observation";

/**
 * The three conclusions an uncertain attempt may reach, and every way of
 * reaching none of them.
 *
 * Pure input, pure output. The instant is a value here, so the millisecond on
 * either side of a deadline is an ordinary test rather than something that has
 * to be raced.
 */

const BOUNDARY = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));
const STARTED = epochMillis(BOUNDARY + 1_500);
const DEADLINE = epochMillis(BOUNDARY + 24 * 60 * 60 * 1000);
const INSIDE = epochMillis(DEADLINE - 1);
const AFTER = epochMillis(DEADLINE + 1);

/** Codes exist only by passing the safe-code boundary. */
function code(raw: string): SubmissionDiagnosticCode {
  const parsed = parseSubmissionDiagnosticCode(raw);
  if (!parsed.ok || parsed.code === null) throw new Error(`fixture: ${raw}`);
  return parsed.code;
}

const TIMEOUT = code("TIMEOUT");

function uncertain(
  overrides: Partial<ReconcilingAttemptFacts> = {},
): ReconcilingAttemptFacts {
  return {
    attemptId: "sgen_rec",
    orchestrationState: "RECONCILIATION_PENDING",
    submissionCertainty: "SUBMISSION_UNKNOWN",
    stateVersion: 7,
    submissionBoundaryEnteredAt: BOUNDARY,
    providerPredictionId: null,
    reconciliationStartedAt: STARTED,
    reconciliationDeadlineAt: DEADLINE,
    reconciliationResolvedAt: null,
    ...overrides,
  };
}

const ACCEPTED: ReconciliationResolutionObservation = {
  kind: "ACCEPTED",
  providerPredictionId: "pred_found",
};
const REJECTED_RETRYABLE: ReconciliationResolutionObservation = {
  kind: "DEFINITIVELY_REJECTED",
  retryable: true,
  diagnosticCode: TIMEOUT,
};
const REJECTED_TERMINAL: ReconciliationResolutionObservation = {
  kind: "DEFINITIVELY_REJECTED",
  retryable: false,
  diagnosticCode: null,
};

function resolve(
  facts: ReconcilingAttemptFacts,
  observation: ReconciliationResolutionObservation,
  now: EpochMillis,
  reservationState: GenerationReservationState | null = "RECONCILIATION_HOLD",
) {
  return decideReconciliationResolution({ facts, observation, reservationState, now });
}

function exhaust(
  facts: ReconcilingAttemptFacts,
  now: EpochMillis,
  reservationState: GenerationReservationState | null = "RECONCILIATION_HOLD",
) {
  return decideReconciliationExhaustion({ facts, reservationState, now });
}

describe("resolving to acceptance", () => {
  it("moves to PROCESSING + ACCEPTED and records the provider's reference", () => {
    const decision = resolve(uncertain(), ACCEPTED, INSIDE);
    expect(decision).toEqual({
      kind: "APPLY",
      write: {
        orchestrationState: "PROCESSING",
        submissionCertainty: "ACCEPTED",
        providerPredictionId: "pred_found",
        providerAcceptedAt: INSIDE,
        reconciliationResolvedAt: INSIDE,
        reservationAction: "RESTORE",
      },
    });
  });

  it("stamps acceptance and resolution from the one instant it was given", () => {
    // Not two clock reads. A record whose acceptance and resolution instants
    // differ would imply the platform learned of an acceptance it had already
    // recorded — there is no provider-supplied timestamp in this phase.
    const decision = resolve(uncertain(), ACCEPTED, INSIDE);
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(decision.write.providerAcceptedAt).toBe(decision.write.reconciliationResolvedAt);
  });

  it("writes no field that would rewrite how the attempt became uncertain", () => {
    // The write shape is the whole permission set: three history timestamps and
    // `normalizedErrorCode` are absent from it, so no branch can touch them.
    const decision = resolve(uncertain(), ACCEPTED, INSIDE);
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    const keys = Object.keys(decision.write);
    for (const forbidden of [
      "submissionBoundaryEnteredAt",
      "reconciliationStartedAt",
      "reconciliationDeadlineAt",
      "normalizedErrorCode",
      "stateVersion",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("resolving to definitive rejection", () => {
  it("sends a retryable rejection to FAILED_RETRYABLE", () => {
    const decision = resolve(uncertain(), REJECTED_RETRYABLE, INSIDE);
    expect(decision).toMatchObject({
      kind: "APPLY",
      write: {
        orchestrationState: "FAILED_RETRYABLE",
        submissionCertainty: "DEFINITIVELY_REJECTED",
        reservationAction: "RESTORE",
      },
    });
  });

  it("sends a non-retryable rejection to FAILED_TERMINAL", () => {
    const decision = resolve(uncertain(), REJECTED_TERMINAL, INSIDE);
    expect(decision).toMatchObject({
      kind: "APPLY",
      write: {
        orchestrationState: "FAILED_TERMINAL",
        submissionCertainty: "DEFINITIVELY_REJECTED",
        reservationAction: "RELEASE",
      },
    });
  });

  it("leaves the provider reference and acceptance instant null", () => {
    // Nothing was accepted. A reference here would make a rejected attempt look
    // like one the provider is working on, and cost accounting reads that field.
    for (const observation of [REJECTED_RETRYABLE, REJECTED_TERMINAL]) {
      const decision = resolve(uncertain(), observation, INSIDE);
      if (decision.kind !== "APPLY") throw new Error("expected APPLY");
      expect(decision.write.providerPredictionId).toBeNull();
      expect(decision.write.providerAcceptedAt).toBeNull();
    }
  });

  it("stamps the resolution instant it was given", () => {
    const decision = resolve(uncertain(), REJECTED_TERMINAL, INSIDE);
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(decision.write.reconciliationResolvedAt).toBe(INSIDE);
  });
});

describe("the deadline is a hard boundary", () => {
  it("may still apply one millisecond before it", () => {
    expect(resolve(uncertain(), ACCEPTED, INSIDE).kind).toBe("APPLY");
  });

  it("is expired exactly at it", () => {
    // Equality belongs to exhaustion. The other reading leaves one instant in
    // which both the resolver and the exhauster believe they own the row.
    expect(resolve(uncertain(), ACCEPTED, DEADLINE)).toEqual({ kind: "DEADLINE_EXPIRED" });
  });

  it("is expired after it", () => {
    expect(resolve(uncertain(), ACCEPTED, AFTER)).toEqual({ kind: "DEADLINE_EXPIRED" });
  });

  it("expires a rejection just as it expires an acceptance", () => {
    expect(resolve(uncertain(), REJECTED_TERMINAL, DEADLINE)).toEqual({
      kind: "DEADLINE_EXPIRED",
    });
  });

  it("judges against the deadline on the row, not one derived from the start", () => {
    // A row whose stored deadline is far past the window its start would imply.
    // Recomputing from configuration would let an operator move a bound that
    // attempts already in flight were admitted under.
    const stretched = uncertain({
      reconciliationDeadlineAt: epochMillis(STARTED + 90 * 24 * 60 * 60 * 1000),
    });
    expect(resolve(stretched, ACCEPTED, AFTER).kind).toBe("APPLY");
  });

  it("writes nothing at all on an expired window", () => {
    const decision = resolve(uncertain(), ACCEPTED, AFTER);
    expect(Object.keys(decision)).toEqual(["kind"]);
  });
});

describe("preconditions — a row that is not reconciling is not resolved", () => {
  it("refuses an attempt that never became uncertain", () => {
    expect(
      resolve(
        uncertain({ orchestrationState: "SUBMITTING", submissionCertainty: "PRE_SUBMISSION" }),
        ACCEPTED,
        INSIDE,
      ),
    ).toEqual({ kind: "NOT_RECONCILING", reason: "ATTEMPT_NEVER_BECAME_UNCERTAIN" });
  });

  it("refuses a row already carrying a provider reference", () => {
    // Uncertainty means nothing named the work. A reference already present is
    // a half-written record, not a base to resolve on top of.
    expect(
      resolve(uncertain({ providerPredictionId: "pred_half" }), ACCEPTED, INSIDE),
    ).toEqual({ kind: "NOT_RECONCILING", reason: "PROVIDER_REFERENCE_ALREADY_PRESENT" });
  });

  it.each([
    ["submissionBoundaryEnteredAt"],
    ["reconciliationStartedAt"],
    ["reconciliationDeadlineAt"],
  ] as const)("fails closed when %s is missing", (field) => {
    // No substitute is invented. A deadline guessed here is a bound nobody
    // agreed to, applied to a customer's money.
    expect(resolve(uncertain({ [field]: null }), ACCEPTED, INSIDE)).toEqual({
      kind: "NOT_RECONCILING",
      reason: "RECONCILIATION_METADATA_MISSING",
    });
  });
});

describe("replay — the same conclusion, delivered twice", () => {
  const resolved = uncertain({
    orchestrationState: "PROCESSING",
    submissionCertainty: "ACCEPTED",
    providerPredictionId: "pred_found",
    reconciliationResolvedAt: INSIDE,
  });

  it("replays an acceptance already on file", () => {
    expect(resolve(resolved, ACCEPTED, INSIDE)).toEqual({ kind: "REPLAY" });
  });

  it("still replays after the attempt has moved on downstream", () => {
    // Identity is provider reality — accepted, under this reference — not where
    // the attempt has since travelled. An `OUTPUT_VERIFIED` attempt has not
    // contradicted its own acceptance.
    for (const state of [
      "PROVIDER_SUCCEEDED",
      "OUTPUT_INGESTING",
      "OUTPUT_VERIFIED",
    ] as const) {
      expect(resolve({ ...resolved, orchestrationState: state }, ACCEPTED, INSIDE)).toEqual({
        kind: "REPLAY",
      });
    }
  });

  it("replays a duplicate delivery long after the deadline", () => {
    // The record is a true statement about the past and stays true. Answering
    // DEADLINE_EXPIRED a day later would make a duplicate look like a failure
    // and invite the caller to retry something already done.
    expect(resolve(resolved, ACCEPTED, epochMillis(DEADLINE + 86_400_000))).toEqual({
      kind: "REPLAY",
    });
  });

  it("does not require the replaying caller's instant to match the stored one", () => {
    expect(resolve({ ...resolved, reconciliationResolvedAt: BOUNDARY }, ACCEPTED, AFTER)).toEqual(
      { kind: "REPLAY" },
    );
  });

  it("replays a retryable rejection already on file", () => {
    expect(
      resolve(
        uncertain({
          orchestrationState: "FAILED_RETRYABLE",
          submissionCertainty: "DEFINITIVELY_REJECTED",
          reconciliationResolvedAt: INSIDE,
        }),
        REJECTED_RETRYABLE,
        AFTER,
      ),
    ).toEqual({ kind: "REPLAY" });
  });

  it("replays a rejection whose diagnostic differs but whose reality does not", () => {
    // The diagnostic is a note about why, kept in event metadata. What is
    // durable about a rejection is that it was one and whether it may be
    // retried — and both agree here.
    expect(
      resolve(
        uncertain({
          orchestrationState: "FAILED_RETRYABLE",
          submissionCertainty: "DEFINITIVELY_REJECTED",
          reconciliationResolvedAt: INSIDE,
        }),
        { kind: "DEFINITIVELY_REJECTED", retryable: true, diagnosticCode: null },
        INSIDE,
      ),
    ).toEqual({ kind: "REPLAY" });
  });
});

describe("conflict — two observers who cannot both be right", () => {
  it("refuses a different provider reference", () => {
    expect(
      resolve(
        uncertain({
          orchestrationState: "PROCESSING",
          submissionCertainty: "ACCEPTED",
          providerPredictionId: "pred_found",
        }),
        { kind: "ACCEPTED", providerPredictionId: "pred_other" },
        INSIDE,
      ),
    ).toEqual({ kind: "CONFLICT", reason: "PROVIDER_REFERENCE_MISMATCH" });
  });

  it("refuses a rejection over a recorded acceptance", () => {
    expect(
      resolve(
        uncertain({
          orchestrationState: "PROCESSING",
          submissionCertainty: "ACCEPTED",
          providerPredictionId: "pred_found",
        }),
        REJECTED_TERMINAL,
        INSIDE,
      ),
    ).toEqual({ kind: "CONFLICT", reason: "CERTAINTY_MISMATCH" });
  });

  it("refuses an acceptance over a recorded rejection", () => {
    expect(
      resolve(
        uncertain({
          orchestrationState: "FAILED_TERMINAL",
          submissionCertainty: "DEFINITIVELY_REJECTED",
        }),
        ACCEPTED,
        INSIDE,
      ),
    ).toEqual({ kind: "CONFLICT", reason: "CERTAINTY_MISMATCH" });
  });

  it("refuses a retryable rejection over a recorded terminal one", () => {
    // The disagreement is about the customer's remaining entitlement: one says
    // the unit is restored for a recovery attempt, the other says it is gone.
    expect(
      resolve(
        uncertain({
          orchestrationState: "FAILED_TERMINAL",
          submissionCertainty: "DEFINITIVELY_REJECTED",
        }),
        REJECTED_RETRYABLE,
        INSIDE,
      ),
    ).toEqual({ kind: "CONFLICT", reason: "TERMINAL_STATE_MISMATCH" });
  });

  it("refuses a terminal rejection over a recorded retryable one", () => {
    expect(
      resolve(
        uncertain({
          orchestrationState: "FAILED_RETRYABLE",
          submissionCertainty: "DEFINITIVELY_REJECTED",
        }),
        REJECTED_TERMINAL,
        INSIDE,
      ),
    ).toEqual({ kind: "CONFLICT", reason: "TERMINAL_STATE_MISMATCH" });
  });

  it("refuses a record whose certainty its state cannot account for", () => {
    // ACCEPTED on file, but the state says the attempt is still at the
    // submission boundary. Nothing here can tell which half is the lie.
    expect(
      resolve(
        uncertain({
          orchestrationState: "SUBMITTING",
          submissionCertainty: "ACCEPTED",
          providerPredictionId: "pred_found",
        }),
        ACCEPTED,
        INSIDE,
      ),
    ).toEqual({ kind: "CONFLICT", reason: "RECORDED_STATE_INCOHERENT" });
  });
});

describe("a malformed observation is refused before anything else is considered", () => {
  it.each(["", "   ", "\t\n"])(
    "refuses a blank provider reference %p",
    (blank) => {
      expect(resolve(uncertain(), { kind: "ACCEPTED", providerPredictionId: blank }, INSIDE)).toEqual(
        { kind: "MALFORMED_OBSERVATION" },
      );
    },
  );

  it.each([
    "https://provider.example/pred?token=SECRET",
    "Bearer secret-token",
    "Provider returned 429: too many requests",
    "a sunlit living room, cinematic",
  ])("refuses hostile text %p smuggled in as a diagnostic", (hostile) => {
    expect(
      resolve(
        uncertain(),
        {
          kind: "DEFINITIVELY_REJECTED",
          retryable: false,
          diagnosticCode: hostile as SubmissionDiagnosticCode,
        },
        INSIDE,
      ),
    ).toEqual({ kind: "MALFORMED_OBSERVATION" });
  });

  it("refuses it even on a row that is already resolved", () => {
    // Ordered first deliberately: a caller must not learn whether its unusable
    // evidence would have replayed, conflicted or been too late.
    expect(
      resolve(
        uncertain({
          orchestrationState: "PROCESSING",
          submissionCertainty: "ACCEPTED",
          providerPredictionId: "pred_found",
        }),
        { kind: "ACCEPTED", providerPredictionId: "  " },
        INSIDE,
      ),
    ).toEqual({ kind: "MALFORMED_OBSERVATION" });
  });
});

describe("an exhausted attempt is closed, not reopened", () => {
  const closed = uncertain({ orchestrationState: "RECONCILIATION_EXHAUSTED" });

  it.each([
    ["an acceptance", ACCEPTED],
    ["a retryable rejection", REJECTED_RETRYABLE],
    ["a terminal rejection", REJECTED_TERMINAL],
  ] as const)("refuses late evidence: %s", (_label, observation) => {
    expect(resolve(closed, observation, AFTER)).toEqual({ kind: "RECONCILIATION_CLOSED" });
  });

  it("refuses it even when the evidence arrives before the deadline", () => {
    // Exhaustion is terminal because the platform already told the customer it
    // had stopped waiting, not because time ran out for the messenger.
    expect(resolve(closed, ACCEPTED, INSIDE)).toEqual({ kind: "RECONCILIATION_CLOSED" });
  });
});

describe("exhaustion", () => {
  it("is not due one millisecond before the deadline", () => {
    expect(exhaust(uncertain(), INSIDE)).toEqual({ kind: "NOT_DUE", dueAt: DEADLINE });
  });

  it("is due exactly at the deadline", () => {
    expect(exhaust(uncertain(), DEADLINE).kind).toBe("APPLY");
  });

  it("is due after the deadline", () => {
    expect(exhaust(uncertain(), AFTER).kind).toBe("APPLY");
  });

  it("mutates nothing when it is not due", () => {
    const decision = exhaust(uncertain(), INSIDE);
    expect(Object.keys(decision).sort()).toEqual(["dueAt", "kind"]);
  });

  it("closes the attempt while leaving the question unanswered", () => {
    expect(exhaust(uncertain(), DEADLINE)).toEqual({
      kind: "APPLY",
      write: {
        orchestrationState: "RECONCILIATION_EXHAUSTED",
        submissionCertainty: "SUBMISSION_UNKNOWN",
        providerPredictionId: null,
        providerAcceptedAt: null,
        reconciliationResolvedAt: null,
        reservationAction: "RELEASE",
      },
    });
  });

  it("stamps no resolution instant", () => {
    // The single most important negative in this phase. A timestamp in that
    // field is what an auditor reads to find out when certainty was regained;
    // it never was, and the event's own timestamp records when we gave up.
    const decision = exhaust(uncertain(), AFTER);
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(decision.write.reconciliationResolvedAt).toBeNull();
  });

  it("reports an already-exhausted attempt without deciding again", () => {
    expect(exhaust(uncertain({ orchestrationState: "RECONCILIATION_EXHAUSTED" }), AFTER)).toEqual({
      kind: "ALREADY_EXHAUSTED",
    });
  });

  it("refuses to exhaust an attempt that reached certainty first", () => {
    expect(
      exhaust(
        uncertain({
          orchestrationState: "PROCESSING",
          submissionCertainty: "ACCEPTED",
          providerPredictionId: "pred_found",
        }),
        AFTER,
      ),
    ).toEqual({ kind: "NOT_RECONCILING", reason: "ATTEMPT_NEVER_BECAME_UNCERTAIN" });
  });

  it("fails closed on a row with no deadline rather than inventing one", () => {
    expect(exhaust(uncertain({ reconciliationDeadlineAt: null }), AFTER)).toEqual({
      kind: "NOT_RECONCILING",
      reason: "RECONCILIATION_METADATA_MISSING",
    });
  });

  it("does not extend the window it reads", () => {
    const decision = exhaust(uncertain(), DEADLINE);
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(Object.keys(decision.write)).not.toContain("reconciliationDeadlineAt");
  });
});

describe("the reservation action follows the conclusion", () => {
  it.each([
    ["acceptance", ACCEPTED, "RESTORE"],
    ["a retryable rejection", REJECTED_RETRYABLE, "RESTORE"],
    ["a terminal rejection", REJECTED_TERMINAL, "RELEASE"],
  ] as const)("moves a suspended hold on %s", (_label, observation, action) => {
    const decision = resolve(uncertain(), observation, INSIDE, "RECONCILIATION_HOLD");
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(decision.write.reservationAction).toBe(action);
  });

  it("releases a suspended hold on exhaustion", () => {
    const decision = exhaust(uncertain(), AFTER, "RECONCILIATION_HOLD");
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(decision.write.reservationAction).toBe("RELEASE");
  });

  it.each(["CONSUMED", "RELEASED", "RESERVED", "RESERVING"] as const)(
    "touches nothing when the reservation is %s",
    (state) => {
      for (const observation of [ACCEPTED, REJECTED_RETRYABLE, REJECTED_TERMINAL]) {
        const decision = resolve(uncertain(), observation, INSIDE, state);
        if (decision.kind !== "APPLY") throw new Error("expected APPLY");
        expect(decision.write.reservationAction).toBe("NONE");
      }
      const exhausted = exhaust(uncertain(), AFTER, state);
      if (exhausted.kind !== "APPLY") throw new Error("expected APPLY");
      expect(exhausted.write.reservationAction).toBe("NONE");
    },
  );

  it("touches nothing when there is no reservation at all", () => {
    const decision = resolve(uncertain(), ACCEPTED, INSIDE, null);
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(decision.write.reservationAction).toBe("NONE");
  });

  it("never asks for a consumption", () => {
    // No conclusion in this phase spends a customer's unit. Charging happens
    // when a video is delivered, and nothing here delivers one.
    const actions = new Set<string>();
    for (const state of [
      "RECONCILIATION_HOLD",
      "CONSUMED",
      "RELEASED",
      "RESERVED",
      "RESERVING",
      null,
    ] as const) {
      for (const observation of [ACCEPTED, REJECTED_RETRYABLE, REJECTED_TERMINAL]) {
        const d = resolve(uncertain(), observation, INSIDE, state);
        if (d.kind === "APPLY") actions.add(d.write.reservationAction);
      }
      const e = exhaust(uncertain(), AFTER, state);
      if (e.kind === "APPLY") actions.add(e.write.reservationAction);
    }
    expect([...actions].sort()).toEqual(["NONE", "RELEASE", "RESTORE"]);
  });
});
