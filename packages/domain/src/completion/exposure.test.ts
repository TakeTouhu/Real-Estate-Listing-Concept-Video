import { describe, expect, it } from "vitest";
import { classifyProviderCostExposure } from "../authorization/exposure";
import { isCoherentAttemptRecord } from "../orchestration/certainty";
import { canTransitionAttempt } from "../orchestration/state-machines";
import { epochMillisFromDate } from "../pricing/units";
import { decideProviderCompletion, type CompletingAttemptFacts } from "./decide";
import type { ProviderCompletionObservation } from "./observation";

/**
 * What this phase's conclusions tell the Safety Guard about money — and the one
 * claim it must never make.
 *
 * The whole distinction 2H-1 exists to keep is between a provider that *refused*
 * a submission and a provider that *accepted* one and then failed to render it.
 * The first bills nothing. The second has already run a paid GPU job. If a
 * post-acceptance execution failure were recorded as `DEFINITIVELY_REJECTED`, or
 * classified as zero cost, the guard would forget a charge the platform owes —
 * and it would forget it in exactly the incident where cost matters most.
 */

const ACCEPTED_AT = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));

const FACTS: CompletingAttemptFacts = {
  attemptId: "sgen_exposure",
  orchestrationState: "PROCESSING",
  submissionCertainty: "ACCEPTED",
  stateVersion: 1,
  providerPredictionId: "pred_accepted",
  providerAcceptedAt: ACCEPTED_AT,
  outputStorageKey: null,
  outputSha256: null,
  outputSizeBytes: null,
  outputVerifiedAt: null,
};

function landingFor(observation: ProviderCompletionObservation) {
  const decision = decideProviderCompletion({ facts: FACTS, observation });
  if (decision.kind !== "APPLY") throw new Error(`expected APPLY, got ${decision.kind}`);
  return decision.write.orchestrationState;
}

describe("the post-acceptance lifecycle stays cost-bearing throughout", () => {
  it.each([
    ["PROCESSING", "IN_FLIGHT"],
    ["PROVIDER_SUCCEEDED", "IN_FLIGHT"],
    ["OUTPUT_INGESTING", "IN_FLIGHT"],
    ["OUTPUT_VERIFIED", "SETTLED_ESTIMATED"],
    ["FAILED_RETRYABLE", "SETTLED_ESTIMATED"],
    ["FAILED_TERMINAL", "SETTLED_ESTIMATED"],
  ] as const)("classifies %s + ACCEPTED as %s", (state, category) => {
    expect(classifyProviderCostExposure(state, "ACCEPTED")).toBe(category);
  });

  it("never classifies any state this phase reaches as costing nothing", () => {
    // The expensive direction is under-counting: a guard that cannot see spend
    // cannot pause on it.
    for (const state of [
      "PROCESSING",
      "PROVIDER_SUCCEEDED",
      "OUTPUT_INGESTING",
      "OUTPUT_VERIFIED",
      "FAILED_RETRYABLE",
      "FAILED_TERMINAL",
    ] as const) {
      expect(classifyProviderCostExposure(state, "ACCEPTED")).not.toBe("NONE");
    }
  });
});

describe("a provider failure after acceptance is not a rejection", () => {
  it.each([
    ["retryable", { kind: "FAILED", retryable: true, diagnosticCode: null }, "FAILED_RETRYABLE"],
    ["terminal", { kind: "FAILED", retryable: false, diagnosticCode: null }, "FAILED_TERMINAL"],
  ] as const)("lands a %s failure on %s and keeps it cost-bearing", (_l, observation, state) => {
    // Driven through the real evaluator and the real classifier, so moving the
    // landing state breaks the guard's arithmetic loudly rather than silently.
    expect(landingFor(observation)).toBe(state);
    expect(classifyProviderCostExposure(state, "ACCEPTED")).toBe("SETTLED_ESTIMATED");
  });

  it("would cost nothing only if the certainty were rewritten — which it is not", () => {
    // The counterfactual, stated as a test. `DEFINITIVELY_REJECTED` is the one
    // certainty that zeroes cost, and this phase never writes it: the write
    // shape has no certainty field at all.
    expect(classifyProviderCostExposure("FAILED_TERMINAL", "DEFINITIVELY_REJECTED")).toBe("NONE");
    expect(classifyProviderCostExposure("FAILED_TERMINAL", "ACCEPTED")).toBe("SETTLED_ESTIMATED");

    const decision = decideProviderCompletion({
      facts: FACTS,
      observation: { kind: "FAILED", retryable: false, diagnosticCode: null },
    });
    if (decision.kind !== "APPLY") throw new Error("expected APPLY");
    expect(Object.keys(decision.write)).toEqual(["orchestrationState"]);
  });
});

describe("the frozen classifications this phase must not disturb", () => {
  it("keeps an exhausted reconciliation uncertain", () => {
    expect(classifyProviderCostExposure("RECONCILIATION_EXHAUSTED", "SUBMISSION_UNKNOWN")).toBe(
      "UNCERTAIN",
    );
  });

  it("keeps a definitive rejection at zero everywhere", () => {
    for (const state of ["FAILED_RETRYABLE", "FAILED_TERMINAL", "PROCESSING"] as const) {
      expect(classifyProviderCostExposure(state, "DEFINITIVELY_REJECTED")).toBe("NONE");
    }
  });
});

describe("this phase's transitions are the committed state machine's", () => {
  it.each([
    ["PROCESSING", "PROVIDER_SUCCEEDED"],
    ["PROCESSING", "FAILED_RETRYABLE"],
    ["PROCESSING", "FAILED_TERMINAL"],
    ["PROVIDER_SUCCEEDED", "OUTPUT_INGESTING"],
    ["OUTPUT_INGESTING", "OUTPUT_VERIFIED"],
  ] as const)("%s → %s is a permitted edge", (from, to) => {
    // The repository does not carry a second private transition table. If the
    // domain ever stops permitting one of these, this fails rather than the
    // persistence quietly teaching itself a transition nobody approved.
    expect(canTransitionAttempt(from, to)).toBe(true);
  });

  it("adds no outgoing edge from OUTPUT_VERIFIED", () => {
    for (const to of [
      "PROCESSING",
      "PROVIDER_SUCCEEDED",
      "OUTPUT_INGESTING",
      "FAILED_RETRYABLE",
      "FAILED_TERMINAL",
    ] as const) {
      expect(canTransitionAttempt("OUTPUT_VERIFIED", to)).toBe(false);
    }
  });

  it("produces only landings the coherence rule permits", () => {
    for (const state of [
      "PROVIDER_SUCCEEDED",
      "OUTPUT_INGESTING",
      "OUTPUT_VERIFIED",
      "FAILED_RETRYABLE",
      "FAILED_TERMINAL",
    ] as const) {
      expect(
        isCoherentAttemptRecord({
          certainty: "ACCEPTED",
          state,
          providerPredictionId: "pred_accepted",
        }),
      ).toBe(true);
    }
  });
});
