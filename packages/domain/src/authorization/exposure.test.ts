import { describe, expect, it } from "vitest";
import { GENERATION_ATTEMPT_STATES } from "../orchestration/types";
import { yen } from "../pricing/units";
import {
  COST_EXPOSED_ATTEMPT_STATES,
  IN_FLIGHT_COST_ATTEMPT_STATES,
  KNOWN_ACTUAL_COST_ATTEMPT_STATES,
  UNCERTAIN_COST_ATTEMPT_STATES,
  totalProviderCostExposureYen,
} from "./exposure";

describe("provider-cost exposure state sets", () => {
  it("never counts one attempt in two categories", () => {
    // The double-count this separation exists to prevent. An attempt in
    // RECONCILIATION_PENDING is uncertain, not in-flight; listing it in both
    // would inflate every organization's exposure by exactly the amount most
    // likely to hard-pause them.
    const all = [
      ...KNOWN_ACTUAL_COST_ATTEMPT_STATES,
      ...UNCERTAIN_COST_ATTEMPT_STATES,
      ...IN_FLIGHT_COST_ATTEMPT_STATES,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it("is the union of the two non-empty categories", () => {
    expect([...COST_EXPOSED_ATTEMPT_STATES].sort()).toEqual(
      [...UNCERTAIN_COST_ATTEMPT_STATES, ...IN_FLIGHT_COST_ATTEMPT_STATES].sort(),
    );
  });

  it("names only states that exist in the vocabulary", () => {
    for (const state of COST_EXPOSED_ATTEMPT_STATES) {
      expect(GENERATION_ATTEMPT_STATES).toContain(state);
    }
  });

  it("counts SUBMITTING from the boundary commit, before any call", () => {
    // An attempt that crashed mid-POST is indistinguishable from one that never
    // sent, and the difference is a charge. The conservative direction is the
    // only safe one.
    expect(IN_FLIGHT_COST_ATTEMPT_STATES).toContain("SUBMITTING");
  });

  it("carries unresolved acceptance as exposure", () => {
    expect(UNCERTAIN_COST_ATTEMPT_STATES).toContain("RECONCILIATION_PENDING");
  });

  it("releases exposure only for states whose cost lifecycle has finished", () => {
    // A terminal or never-sent attempt is not open exposure. Holding it forever
    // would pause an organization with no path to release.
    for (const state of [
      "QUEUED",
      "OUTPUT_VERIFIED",
      "FAILED_RETRYABLE",
      "FAILED_TERMINAL",
      "CANCELLED_PRE_SUBMISSION",
      "RECONCILIATION_EXHAUSTED",
    ] as const) {
      expect(COST_EXPOSED_ATTEMPT_STATES).not.toContain(state);
    }
  });

  it("has no known-actual-cost source yet, and says so structurally", () => {
    // Nothing persists what a provider actually billed. An empty set is the
    // honest state; deriving "actual" from the planning estimate would put a
    // projection into the field a margin review reads as fact.
    expect(KNOWN_ACTUAL_COST_ATTEMPT_STATES).toHaveLength(0);
  });

  it("sums every component", () => {
    expect(
      totalProviderCostExposureYen({
        knownActualCostYen: yen(1),
        uncertainCostYen: yen(20),
        inFlightCostYen: yen(300),
        nextProjectedCostYen: yen(4_000),
      }),
    ).toBe(4_321);
  });
});
