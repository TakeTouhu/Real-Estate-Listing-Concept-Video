import { describe, expect, it } from "vitest";
import { classifyProviderCostExposure } from "../authorization/exposure";
import { isCoherentAttemptRecord } from "../orchestration/certainty";
import { epochMillis, epochMillisFromDate } from "../pricing/units";
import {
  decideReconciliationExhaustion,
  decideReconciliationResolution,
  type ReconcilingAttemptFacts,
  type ReconciliationWrite,
} from "./decide";
import type { ReconciliationResolutionObservation } from "./observation";

/**
 * What each conclusion tells the Safety Guard about money.
 *
 * Deliberately coupled to the *decision*, not to a hand-written pair of
 * strings: the writes are produced by the real evaluators and handed to the real
 * classifier. Change where a rejection lands and this fails, which is the point
 * — the exposure category is a consequence of the landing state, and a phase
 * that quietly moved one would move the guard's arithmetic with it.
 *
 * The expensive direction is under-counting. A guard that cannot see spend
 * cannot pause on it, so the two branches that must *not* read as zero are
 * asserted as loudly as the one that must.
 */

const BOUNDARY = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));
const DEADLINE = epochMillis(BOUNDARY + 24 * 60 * 60 * 1000);
const INSIDE = epochMillis(DEADLINE - 1);
const AFTER = epochMillis(DEADLINE + 1);

const FACTS: ReconcilingAttemptFacts = {
  attemptId: "sgen_exposure",
  orchestrationState: "RECONCILIATION_PENDING",
  submissionCertainty: "SUBMISSION_UNKNOWN",
  stateVersion: 1,
  submissionBoundaryEnteredAt: BOUNDARY,
  providerPredictionId: null,
  reconciliationStartedAt: epochMillis(BOUNDARY + 1_000),
  reconciliationDeadlineAt: DEADLINE,
  reconciliationResolvedAt: null,
};

function writeForResolution(
  observation: ReconciliationResolutionObservation,
): ReconciliationWrite {
  const decision = decideReconciliationResolution({
    facts: FACTS,
    observation,
    reservationState: "RECONCILIATION_HOLD",
    now: INSIDE,
  });
  if (decision.kind !== "APPLY") throw new Error(`expected APPLY, got ${decision.kind}`);
  return decision.write;
}

function writeForExhaustion(): ReconciliationWrite {
  const decision = decideReconciliationExhaustion({
    facts: FACTS,
    reservationState: "RECONCILIATION_HOLD",
    now: AFTER,
  });
  if (decision.kind !== "APPLY") throw new Error(`expected APPLY, got ${decision.kind}`);
  return decision.write;
}

const LANDINGS = [
  [
    "a resolved acceptance",
    writeForResolution({ kind: "ACCEPTED", providerPredictionId: "pred_found" }),
    "IN_FLIGHT",
  ],
  [
    "a retryable rejection",
    writeForResolution({
      kind: "DEFINITIVELY_REJECTED",
      retryable: true,
      diagnosticCode: null,
    }),
    "NONE",
  ],
  [
    "a terminal rejection",
    writeForResolution({
      kind: "DEFINITIVELY_REJECTED",
      retryable: false,
      diagnosticCode: null,
    }),
    "NONE",
  ],
  ["an exhausted window", writeForExhaustion(), "UNCERTAIN"],
] as const;

describe("each conclusion's cost exposure", () => {
  it.each(LANDINGS)("classifies %s as %s", (_label, write, category) => {
    expect(
      classifyProviderCostExposure(write.orchestrationState, write.submissionCertainty),
    ).toBe(category);
  });

  it("keeps a resolved acceptance visible as spend the platform is committed to", () => {
    // The work is running under a reference the provider gave us. Anything but
    // in-flight here would let an accepted attempt cost money the guard cannot
    // see until the bill arrives.
    const write = writeForResolution({ kind: "ACCEPTED", providerPredictionId: "pred_found" });
    expect(write.orchestrationState).toBe("PROCESSING");
    expect(write.submissionCertainty).toBe("ACCEPTED");
    expect(
      classifyProviderCostExposure(write.orchestrationState, write.submissionCertainty),
    ).toBe("IN_FLIGHT");
  });

  it("zeroes a definitive rejection, the one negative strong enough to do it", () => {
    // The provider refused the submission. Nothing was started, so there is
    // nothing to bill — and this is the *only* conclusion in the phase that may
    // remove exposure from a cycle.
    for (const retryable of [true, false]) {
      const write = writeForResolution({
        kind: "DEFINITIVELY_REJECTED",
        retryable,
        diagnosticCode: null,
      });
      expect(
        classifyProviderCostExposure(write.orchestrationState, write.submissionCertainty),
      ).toBe("NONE");
    }
  });

  it("refuses to let giving up look like a refund", () => {
    // Exhaustion resolves the customer's entitlement and nothing at all about
    // what the provider charged. Dropping this to NONE would understate every
    // cycle in which an incident happened — precisely the cycles that matter.
    const write = writeForExhaustion();
    expect(write.submissionCertainty).toBe("SUBMISSION_UNKNOWN");
    expect(
      classifyProviderCostExposure(write.orchestrationState, write.submissionCertainty),
    ).toBe("UNCERTAIN");
  });

  it("leaves uncertain spend uncertain rather than settling it", () => {
    // Not SETTLED_ESTIMATED either. That category means the execution finished
    // and the estimate stands; here nobody knows whether anything ran.
    const write = writeForExhaustion();
    const category = classifyProviderCostExposure(
      write.orchestrationState,
      write.submissionCertainty,
    );
    expect(category).not.toBe("NONE");
    expect(category).not.toBe("SETTLED_ESTIMATED");
    expect(category).not.toBe("KNOWN_ACTUAL");
  });

  it("produces only landings the coherence rule already permits", () => {
    // The database CHECK enforces the same pairing. A conclusion this phase can
    // reach but the record cannot hold would be a runtime constraint error
    // discovered in production rather than a compile-time or test failure.
    for (const [, write] of LANDINGS) {
      expect(
        isCoherentAttemptRecord({
          certainty: write.submissionCertainty,
          state: write.orchestrationState,
          providerPredictionId: write.providerPredictionId,
        }),
      ).toBe(true);
    }
  });

  it("lands on four distinct states across the three conclusions", () => {
    // Three conclusions, four destinations: rejection forks on retryability,
    // and that fork is what decides the customer's remaining entitlement.
    expect(new Set(LANDINGS.map(([, write]) => write.orchestrationState))).toEqual(
      new Set(["PROCESSING", "FAILED_RETRYABLE", "FAILED_TERMINAL", "RECONCILIATION_EXHAUSTED"]),
    );
  });
});
