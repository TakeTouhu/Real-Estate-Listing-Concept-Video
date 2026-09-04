import { describe, expect, it } from "vitest";
import {
  allowedAttemptTransitionsFrom,
  canTransitionAttempt,
  canTransitionJob,
  canTransitionReservation,
  canTransitionScene,
  canTransitionSceneRequest,
  isProviderExposedAttemptState,
  isTerminalAttemptState,
  mayArmProviderBoundary,
  PROVIDER_EXPOSED_ATTEMPT_STATES,
  TERMINAL_ATTEMPT_STATES,
} from "./state-machines";
import {
  GENERATION_ATTEMPT_STATES,
  GENERATION_JOB_STATES,
  GENERATION_RESERVATION_STATES,
  GENERATION_SCENE_STATES,
  SCENE_GENERATION_REQUEST_STATES,
} from "./types";

/**
 * The transition tables, asserted move by move.
 *
 * Allowed moves and forbidden moves are both listed as literals. A test that
 * derived its expectations from the table would pass against any table,
 * including one that permits a second provider POST.
 */

describe("the customer video lifecycle", () => {
  it.each([
    ["CREATED", "RESERVING"],
    ["RESERVING", "RESERVED"],
    ["RESERVED", "GENERATING"],
    ["GENERATING", "SCENES_READY"],
    ["SCENES_READY", "COMPOSITION_PENDING"],
    ["COMPOSITION_PENDING", "COMPOSING"],
    ["COMPOSING", "DELIVERABLE_VALIDATING"],
    ["DELIVERABLE_VALIDATING", "DELIVERABLE_READY"],
    ["DELIVERABLE_READY", "REVISING"],
    ["REVISING", "GENERATING"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(canTransitionJob(from, to)).toBe(true);
  });

  it.each([
    // Skipping the reservation would generate before the customer's
    // entitlement was held — a paid call with nothing behind it.
    ["CREATED", "DELIVERABLE_READY"],
    ["CREATED", "GENERATING"],
    ["RESERVED", "DELIVERABLE_READY"],
    ["RESERVING", "GENERATING"],
    // History does not run backwards.
    ["DELIVERABLE_READY", "CREATED"],
    ["DELIVERABLE_READY", "RESERVED"],
    ["SCENES_READY", "GENERATING"],
    // Terminal is terminal.
    ["FAILED_TERMINAL", "GENERATING"],
    ["FAILED_TERMINAL", "CREATED"],
    ["CANCELLED", "GENERATING"],
    ["CANCELLED", "RESERVED"],
  ] as const)("refuses %s -> %s", (from, to) => {
    expect(canTransitionJob(from, to)).toBe(false);
  });

  it("keeps a delivered video delivered", () => {
    // A failed revision must not turn an already-delivered job into a failure:
    // the customer still holds a video that works.
    expect(canTransitionJob("DELIVERABLE_READY", "FAILED_TERMINAL")).toBe(false);
    expect(canTransitionJob("DELIVERABLE_READY", "CANCELLED")).toBe(false);
    expect(canTransitionJob("DELIVERABLE_READY", "REVISING")).toBe(true);
  });

  it("never transitions to itself", () => {
    for (const state of GENERATION_JOB_STATES) {
      expect(canTransitionJob(state, state)).toBe(false);
    }
  });
});

describe("the entitlement hold", () => {
  it.each([
    ["RESERVING", "RESERVED"],
    ["RESERVING", "RELEASED"],
    ["RESERVED", "RECONCILIATION_HOLD"],
    ["RECONCILIATION_HOLD", "RESERVED"],
    ["RESERVED", "CONSUMED"],
    ["RECONCILIATION_HOLD", "CONSUMED"],
    ["RESERVED", "RELEASED"],
    ["RECONCILIATION_HOLD", "RELEASED"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(canTransitionReservation(from, to)).toBe(true);
  });

  it.each([
    // A consumed unit is spent and a released one is returned. Reviving either
    // would let one entitlement be spent twice.
    ["CONSUMED", "RESERVED"],
    ["CONSUMED", "RELEASED"],
    ["RELEASED", "RESERVED"],
    ["RELEASED", "CONSUMED"],
    ["RESERVING", "CONSUMED"],
    ["RESERVING", "RECONCILIATION_HOLD"],
  ] as const)("refuses %s -> %s", (from, to) => {
    expect(canTransitionReservation(from, to)).toBe(false);
  });

  it("makes both terminal states final against every other state", () => {
    // A spent unit cannot be un-spent and a returned one cannot be re-taken.
    for (const to of GENERATION_RESERVATION_STATES) {
      expect(canTransitionReservation("CONSUMED", to)).toBe(false);
      expect(canTransitionReservation("RELEASED", to)).toBe(false);
    }
  });
});

describe("one logical scene", () => {
  it.each([
    ["PENDING", "GENERATING"],
    ["GENERATING", "READY"],
    ["READY", "REVISING"],
    ["REVISING", "READY"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(canTransitionScene(from, to)).toBe(true);
  });

  it.each([
    ["PENDING", "READY"],
    ["READY", "GENERATING"],
    ["FAILED_TERMINAL", "GENERATING"],
    ["CANCELLED", "PENDING"],
    ["READY", "FAILED_TERMINAL"],
  ] as const)("refuses %s -> %s", (from, to) => {
    expect(canTransitionScene(from, to)).toBe(false);
  });

  it("never transitions to itself", () => {
    for (const state of GENERATION_SCENE_STATES) {
      expect(canTransitionScene(state, state)).toBe(false);
    }
  });
});

describe("one customer-visible rendition request", () => {
  it.each([
    ["PENDING", "GENERATING"],
    ["GENERATING", "DELIVERED"],
    ["GENERATING", "FAILED_TERMINAL"],
    ["GENERATING", "CANCELLED"],
    ["PENDING", "CANCELLED"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(canTransitionSceneRequest(from, to)).toBe(true);
  });

  it.each([
    // Delivery is what the regeneration entitlement is counted from. A
    // delivered request that could move again would let one right be spent
    // twice, or un-spent after the fact.
    ["DELIVERED", "GENERATING"],
    ["DELIVERED", "FAILED_TERMINAL"],
    ["DELIVERED", "PENDING"],
    ["FAILED_TERMINAL", "GENERATING"],
    ["CANCELLED", "PENDING"],
    // A system recovery attempt does not restart the customer's request.
    ["GENERATING", "PENDING"],
    ["PENDING", "DELIVERED"],
  ] as const)("refuses %s -> %s", (from, to) => {
    expect(canTransitionSceneRequest(from, to)).toBe(false);
  });

  it("never transitions to itself", () => {
    for (const state of SCENE_GENERATION_REQUEST_STATES) {
      expect(canTransitionSceneRequest(state, state)).toBe(false);
    }
  });
});

describe("one provider attempt", () => {
  it.each([
    ["QUEUED", "SUBMITTING"],
    ["QUEUED", "CANCELLED_PRE_SUBMISSION"],
    ["QUEUED", "FAILED_RETRYABLE"],
    ["QUEUED", "FAILED_TERMINAL"],
    ["SUBMITTING", "PROCESSING"],
    ["SUBMITTING", "FAILED_RETRYABLE"],
    ["SUBMITTING", "FAILED_TERMINAL"],
    ["SUBMITTING", "RECONCILIATION_PENDING"],
    ["PROCESSING", "PROVIDER_SUCCEEDED"],
    ["RECONCILIATION_PENDING", "PROCESSING"],
    ["RECONCILIATION_PENDING", "RECONCILIATION_EXHAUSTED"],
    ["PROVIDER_SUCCEEDED", "OUTPUT_INGESTING"],
    ["OUTPUT_INGESTING", "OUTPUT_VERIFIED"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(canTransitionAttempt(from, to)).toBe(true);
  });

  /**
   * The transitions that would cause a second provider POST for one request.
   *
   * Every one of these is a duplicate charge if it is ever permitted, and the
   * first two are the ones a well-meaning "retry the stuck rows" job would
   * reach for.
   */
  it.each([
    ["SUBMITTING", "QUEUED"],
    ["RECONCILIATION_PENDING", "QUEUED"],
    ["PROCESSING", "QUEUED"],
    ["PROCESSING", "SUBMITTING"],
    ["FAILED_RETRYABLE", "QUEUED"],
    ["FAILED_RETRYABLE", "SUBMITTING"],
    ["FAILED_TERMINAL", "QUEUED"],
    ["RECONCILIATION_EXHAUSTED", "QUEUED"],
    ["RECONCILIATION_EXHAUSTED", "SUBMITTING"],
    ["OUTPUT_VERIFIED", "QUEUED"],
    ["CANCELLED_PRE_SUBMISSION", "QUEUED"],
    ["CANCELLED_PRE_SUBMISSION", "SUBMITTING"],
  ] as const)("refuses %s -> %s, which would re-POST a paid request", (from, to) => {
    expect(canTransitionAttempt(from, to)).toBe(false);
  });

  it("has exactly one state that can reach SUBMITTING", () => {
    // Stated as a property over the whole vocabulary rather than as a list, so
    // adding a state cannot quietly add a second submission entry point.
    const canSubmit = GENERATION_ATTEMPT_STATES.filter((s) =>
      canTransitionAttempt(s, "SUBMITTING"),
    );
    expect(canSubmit).toEqual(["QUEUED"]);
  });

  it("permits no cancellation once the provider may be working", () => {
    for (const from of GENERATION_ATTEMPT_STATES) {
      if (from === "QUEUED") continue;
      expect(canTransitionAttempt(from, "CANCELLED_PRE_SUBMISSION")).toBe(false);
    }
  });

  it("treats its terminal states as final", () => {
    for (const state of TERMINAL_ATTEMPT_STATES) {
      expect(allowedAttemptTransitionsFrom(state)).toEqual([]);
      expect(isTerminalAttemptState(state)).toBe(true);
    }
  });

  it("derives the terminal set from the table rather than restating it", () => {
    // The declared list and the table must agree. If someone adds an edge out
    // of a state named terminal, this fails rather than the list quietly
    // becoming a lie.
    const withoutEdges = GENERATION_ATTEMPT_STATES.filter(
      (s) => allowedAttemptTransitionsFrom(s).length === 0,
    );
    expect([...withoutEdges].sort()).toEqual([...TERMINAL_ATTEMPT_STATES].sort());
  });

  it("counts every state where the provider may already be billing", () => {
    // RECONCILIATION_PENDING is the member that matters: treating "we do not
    // know" as "it did not happen" is how a system pays twice.
    expect(isProviderExposedAttemptState("RECONCILIATION_PENDING")).toBe(true);
    expect(isProviderExposedAttemptState("QUEUED")).toBe(false);
    expect(isProviderExposedAttemptState("CANCELLED_PRE_SUBMISSION")).toBe(false);
    expect(PROVIDER_EXPOSED_ATTEMPT_STATES).not.toContain("QUEUED");
  });

  it("arms a provider call from QUEUED and from nowhere else", () => {
    for (const state of GENERATION_ATTEMPT_STATES) {
      expect(mayArmProviderBoundary(state)).toBe(state === "QUEUED");
    }
  });

  it("never transitions to itself", () => {
    for (const state of GENERATION_ATTEMPT_STATES) {
      expect(canTransitionAttempt(state, state)).toBe(false);
    }
  });
});
