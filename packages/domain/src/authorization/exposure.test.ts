import { describe, expect, it } from "vitest";
import {
  GENERATION_ATTEMPT_STATES,
  SUBMISSION_CERTAINTIES,
  type GenerationAttemptState,
  type SubmissionCertainty,
} from "../orchestration/types";
import { yen } from "../pricing/units";
import {
  ALWAYS_COST_EXPOSED_ATTEMPT_STATES,
  COST_BEARING_SUBMISSION_CERTAINTIES,
  classifyProviderCostExposure,
  isPotentiallyCostExposed,
  totalProviderCostExposureYen,
} from "./exposure";

/**
 * What the Safety Guard is allowed to forget.
 *
 * Every test here is really the same question: can provider money that was or
 * may have been spent disappear from the cycle's total? The expensive direction
 * is under-counting — a guard that cannot see spend cannot pause on it — so the
 * classifier is asserted state by state and certainty by certainty rather than
 * spot-checked.
 */

const ALL_PAIRS: readonly (readonly [GenerationAttemptState, SubmissionCertainty])[] =
  GENERATION_ATTEMPT_STATES.flatMap((state) =>
    SUBMISSION_CERTAINTIES.map((certainty) => [state, certainty] as const),
  );

describe("provider cost exposure classification", () => {
  it("counts an unresolved submission as uncertain", () => {
    expect(classifyProviderCostExposure("RECONCILIATION_PENDING", "SUBMISSION_UNKNOWN")).toBe(
      "UNCERTAIN",
    );
  });

  it("still counts an exhausted reconciliation as uncertain", () => {
    // The reconciliation window closing resolves the *customer's* entitlement.
    // It resolves nothing about what the provider charged, and nobody ever
    // found out — so dropping this to zero would let giving up look like a
    // refund, and would understate every cycle in which an incident happened.
    expect(classifyProviderCostExposure("RECONCILIATION_EXHAUSTED", "SUBMISSION_UNKNOWN")).toBe(
      "UNCERTAIN",
    );
  });

  it.each([
    ["OUTPUT_VERIFIED"],
    ["FAILED_RETRYABLE"],
    ["FAILED_TERMINAL"],
  ] as const)("counts an accepted %s conservatively as settled estimate", (state) => {
    // The execution lifecycle ended; the money did not come back. Until an
    // actual-cost ingestion path exists, the immutable planning estimate is the
    // best figure there is, and carrying it is the only honest option.
    expect(classifyProviderCostExposure(state, "ACCEPTED")).toBe("SETTLED_ESTIMATED");
  });

  it("counts nothing for a definitively rejected attempt", () => {
    // The one negative fact strong enough to zero a cost anywhere: the provider
    // refused the submission, so there is nothing to bill.
    expect(classifyProviderCostExposure("FAILED_TERMINAL", "DEFINITIVELY_REJECTED")).toBe(
      "NONE",
    );
    for (const state of GENERATION_ATTEMPT_STATES) {
      expect(classifyProviderCostExposure(state, "DEFINITIVELY_REJECTED")).toBe("NONE");
    }
  });

  it("counts nothing for an attempt cancelled before the boundary", () => {
    expect(classifyProviderCostExposure("CANCELLED_PRE_SUBMISSION", "PRE_SUBMISSION")).toBe(
      "NONE",
    );
    expect(classifyProviderCostExposure("QUEUED", "PRE_SUBMISSION")).toBe("NONE");
  });

  it.each([
    ["SUBMITTING"],
    ["PROCESSING"],
    ["PROVIDER_SUCCEEDED"],
    ["OUTPUT_INGESTING"],
  ] as const)("counts %s as in flight from the moment the boundary commits", (state) => {
    // SUBMITTING counts before any HTTP call is made. An attempt that crashed
    // mid-POST is indistinguishable from one that never sent, and the
    // difference is a charge.
    expect(classifyProviderCostExposure(state, "PRE_SUBMISSION")).toBe("IN_FLIGHT");
    expect(classifyProviderCostExposure(state, "ACCEPTED")).toBe("IN_FLIGHT");
  });

  it("never returns KNOWN_ACTUAL, because nothing persists an actual cost", () => {
    // The category exists so the future ingestion path has somewhere to put its
    // answer. Returning it today would file an estimate under a name that means
    // "what the provider billed".
    for (const [state, certainty] of ALL_PAIRS) {
      expect(classifyProviderCostExposure(state, certainty)).not.toBe("KNOWN_ACTUAL");
    }
  });

  it("gives every state and certainty pair exactly one answer", () => {
    for (const [state, certainty] of ALL_PAIRS) {
      const category = classifyProviderCostExposure(state, certainty);
      expect([
        "KNOWN_ACTUAL",
        "SETTLED_ESTIMATED",
        "UNCERTAIN",
        "IN_FLIGHT",
        "NONE",
      ]).toContain(category);
    }
  });
});

describe("the persistence prefilter", () => {
  it("never excludes anything the classifier would have counted", () => {
    // The query narrows before classifying, so a prefilter that is too tight
    // silently drops exposure that no later code can recover. This is the
    // parity check that keeps the SQL honest against the domain rule.
    for (const [state, certainty] of ALL_PAIRS) {
      if (classifyProviderCostExposure(state, certainty) === "NONE") continue;
      expect(isPotentiallyCostExposed(state, certainty)).toBe(true);
    }
  });

  it("is built from the constants the query mirrors", () => {
    // The SQL cannot call `isPotentiallyCostExposed`, so it reconstructs the
    // predicate from these two exported lists. If the predicate stopped being
    // expressible from them, the query would silently diverge.
    for (const [state, certainty] of ALL_PAIRS) {
      const fromConstants =
        certainty !== "DEFINITIVELY_REJECTED" &&
        (ALWAYS_COST_EXPOSED_ATTEMPT_STATES.includes(state) ||
          COST_BEARING_SUBMISSION_CERTAINTIES.includes(certainty));
      expect(isPotentiallyCostExposed(state, certainty)).toBe(fromConstants);
    }
  });

  it("excludes a definitively rejected attempt outright", () => {
    expect(isPotentiallyCostExposed("SUBMITTING", "DEFINITIVELY_REJECTED")).toBe(false);
  });
});

describe("total exposure", () => {
  it("sums every component, including the candidate", () => {
    // Excluding the candidate is how two concurrent authorizations each look
    // affordable and jointly are not.
    expect(
      totalProviderCostExposureYen({
        knownActualCostYen: yen(1),
        settledEstimatedCostYen: yen(20),
        uncertainCostYen: yen(300),
        inFlightCostYen: yen(4_000),
        nextProjectedCostYen: yen(50_000),
      }),
    ).toBe(54_321);
  });

  it("counts settled estimate as part of the total, not alongside it", () => {
    // The correction this component exists for: an accepted attempt whose
    // execution has finished used to vanish from the guard entirely.
    const withoutSettled = totalProviderCostExposureYen({
      knownActualCostYen: yen(0),
      settledEstimatedCostYen: yen(0),
      uncertainCostYen: yen(0),
      inFlightCostYen: yen(0),
      nextProjectedCostYen: yen(100),
    });
    const withSettled = totalProviderCostExposureYen({
      knownActualCostYen: yen(0),
      settledEstimatedCostYen: yen(9_000),
      uncertainCostYen: yen(0),
      inFlightCostYen: yen(0),
      nextProjectedCostYen: yen(100),
    });
    expect(withSettled - withoutSettled).toBe(9_000);
  });
});
