import { describe, expect, it } from "vitest";
import {
  GENERATION_RESERVATION_STATES,
  SCENE_GENERATION_REQUEST_KINDS,
  type GenerationReservationState,
  type SceneGenerationRequestKind,
} from "../orchestration/types";
import { ENTITLEMENT_ANOMALIES } from "../submission/entitlement-anomaly";
import { classifyReconciliationEntitlement, reservationActionFor } from "./entitlement";

/**
 * What happens to a customer's unit when uncertainty ends — and what is said
 * about bookkeeping that does not add up.
 *
 * The whole matrix, both request kinds against every reservation state, because
 * the two rules that govern it are deliberately not the same rule: the *action*
 * is keyed on reservation state alone, while the *classification* needs the
 * request kind to tell a correct `CONSUMED` from an anomalous one.
 */

const CONCLUSIONS = [
  "ACCEPTED",
  "REJECTED_RETRYABLE",
  "REJECTED_TERMINAL",
  "EXHAUSTED",
] as const;

/** Every reservation state, from the exported list for the same reason. */
const STATES: readonly GenerationReservationState[] = GENERATION_RESERVATION_STATES;

/**
 * Every request kind there is.
 *
 * Taken from the exported list rather than written out, so a kind added later
 * is classified by this matrix instead of quietly skipping it. `SYSTEM_RECOVERY`
 * is an *attempt* origin, not a request kind — a recovery attempt hangs off the
 * same logical request and inherits its entitlement story.
 */
const KINDS: readonly SceneGenerationRequestKind[] = SCENE_GENERATION_REQUEST_KINDS;

describe("only a suspended hold ever moves", () => {
  it.each([
    ["ACCEPTED", "RESTORE"],
    ["REJECTED_RETRYABLE", "RESTORE"],
    ["REJECTED_TERMINAL", "RELEASE"],
    ["EXHAUSTED", "RELEASE"],
  ] as const)("%s moves a RECONCILIATION_HOLD to %s", (conclusion, action) => {
    expect(reservationActionFor({
      reservationState: "RECONCILIATION_HOLD",
      conclusion,
      otherPendingUnknownAttemptsInJob: 0,
    })).toBe(
      action,
    );
  });

  it.each(STATES.filter((s) => s !== "RECONCILIATION_HOLD"))(
    "leaves a %s reservation alone under every conclusion",
    (reservationState) => {
      for (const conclusion of CONCLUSIONS) {
        expect(reservationActionFor({ reservationState, conclusion, otherPendingUnknownAttemptsInJob: 0 })).toBe("NONE");
      }
    },
  );

  it("leaves a missing reservation alone under every conclusion", () => {
    for (const conclusion of CONCLUSIONS) {
      expect(reservationActionFor({ reservationState: null, conclusion, otherPendingUnknownAttemptsInJob: 0 })).toBe("NONE");
    }
  });

  it("keeps a retryable rejection actually retryable", () => {
    // Releasing here would hand the unit back and leave a future
    // SYSTEM_RECOVERY attempt with nothing to stand on — the customer's request
    // would become quietly unfinishable while looking healthy.
    expect(
      reservationActionFor({
        otherPendingUnknownAttemptsInJob: 0,
        reservationState: "RECONCILIATION_HOLD",
        conclusion: "REJECTED_RETRYABLE",
      }),
    ).toBe("RESTORE");
    expect(
      reservationActionFor({
        otherPendingUnknownAttemptsInJob: 0,
        reservationState: "RECONCILIATION_HOLD",
        conclusion: "REJECTED_TERMINAL",
      }),
    ).toBe("RELEASE");
  });

  it("makes the customer whole when the platform gives up", () => {
    // The provider-side cost stays uncertain; the customer's entitlement does
    // not. They are not charged for a question nobody could answer.
    expect(
      reservationActionFor({
        otherPendingUnknownAttemptsInJob: 0,
        reservationState: "RECONCILIATION_HOLD",
        conclusion: "EXHAUSTED",
      }),
    ).toBe("RELEASE");
  });
});

describe("a Job-scoped hold waits for its last unknown attempt", () => {
  /**
   * One reservation, many scenes. Several attempts in the same Job can be
   * durably unknown behind a single suspended hold, so the first conclusion to
   * arrive must not lift a Job-level suspension the Job has not earned.
   */

  it.each([
    ["ACCEPTED", "ACCEPTED"],
    ["a retryable rejection", "REJECTED_RETRYABLE"],
  ] as const)("keeps the hold on %s while a sibling is still unknown", (_l, conclusion) => {
    expect(
      reservationActionFor({
        reservationState: "RECONCILIATION_HOLD",
        conclusion,
        otherPendingUnknownAttemptsInJob: 1,
      }),
    ).toBe("KEEP_HOLD");
  });

  it.each([1, 2, 7])("keeps the hold for %i remaining unknown siblings", (remaining) => {
    expect(
      reservationActionFor({
        reservationState: "RECONCILIATION_HOLD",
        conclusion: "ACCEPTED",
        otherPendingUnknownAttemptsInJob: remaining,
      }),
    ).toBe("KEEP_HOLD");
  });

  it.each([
    ["ACCEPTED", "ACCEPTED"],
    ["a retryable rejection", "REJECTED_RETRYABLE"],
  ] as const)("restores on %s once it is the last unknown attempt", (_l, conclusion) => {
    expect(
      reservationActionFor({
        reservationState: "RECONCILIATION_HOLD",
        conclusion,
        otherPendingUnknownAttemptsInJob: 0,
      }),
    ).toBe("RESTORE");
  });

  it.each([
    ["a terminal rejection", "REJECTED_TERMINAL"],
    ["exhaustion", "EXHAUSTED"],
  ] as const)("releases on %s even while a sibling is still unknown", (_l, conclusion) => {
    // Deliberately asymmetric. Releasing is how the customer stops being charged
    // for a question nobody could answer; making that wait on an unrelated
    // sibling would hold their money hostage to it. And the asymmetry is safe
    // one-way: RELEASED is terminal, so a sibling's later conclusion can never
    // resurrect it.
    expect(
      reservationActionFor({
        reservationState: "RECONCILIATION_HOLD",
        conclusion,
        otherPendingUnknownAttemptsInJob: 3,
      }),
    ).toBe("RELEASE");
  });

  it("never returns KEEP_HOLD for a reservation that is not a suspended hold", () => {
    // KEEP_HOLD says "the hold is right where it should be". A CONSUMED or
    // RELEASED reservation is not a hold at all, and labelling it one would tell
    // an operator a suspension exists that does not.
    for (const reservationState of STATES.filter((s) => s !== "RECONCILIATION_HOLD")) {
      for (const conclusion of CONCLUSIONS) {
        expect(
          reservationActionFor({
            reservationState,
            conclusion,
            otherPendingUnknownAttemptsInJob: 5,
          }),
        ).toBe("NONE");
      }
    }
    for (const conclusion of CONCLUSIONS) {
      expect(
        reservationActionFor({
          reservationState: null,
          conclusion,
          otherPendingUnknownAttemptsInJob: 5,
        }),
      ).toBe("NONE");
    }
  });

  it("still never asks for a consumption, whatever the sibling count", () => {
    const actions = new Set<string>();
    for (const remaining of [0, 1, 4]) {
      for (const reservationState of [...STATES, null]) {
        for (const conclusion of CONCLUSIONS) {
          actions.add(
            reservationActionFor({
              reservationState,
              conclusion,
              otherPendingUnknownAttemptsInJob: remaining,
            }),
          );
        }
      }
    }
    expect([...actions].sort()).toEqual(["KEEP_HOLD", "NONE", "RELEASE", "RESTORE"]);
  });
});

describe("a post-delivery regeneration never touches a unit", () => {
  it.each(CONCLUSIONS)("stays CONSUMED under %s", (conclusion) => {
    // The regeneration right is sold with the original video and exercised
    // after delivery, when the unit is already spent. Restoring it would hand
    // the customer a unit they already used; consuming it would charge twice.
    expect(reservationActionFor({
      reservationState: "CONSUMED",
      conclusion,
      otherPendingUnknownAttemptsInJob: 0,
    })).toBe("NONE");
    expect(
      classifyReconciliationEntitlement({
        requestKind: "USER_REGENERATION",
        reservationState: "CONSUMED",
      }),
    ).toBe("NONE");
  });
});

describe("classification never refuses, only labels", () => {
  it("calls a suspended hold healthy — it is what this phase put there", () => {
    for (const requestKind of KINDS) {
      expect(
        classifyReconciliationEntitlement({
          requestKind,
          reservationState: "RECONCILIATION_HOLD",
        }),
      ).toBe("NONE");
    }
  });

  it("reports a missing reservation", () => {
    expect(
      classifyReconciliationEntitlement({ requestKind: "INITIAL", reservationState: null }),
    ).toBe("RESERVATION_MISSING");
  });

  it("reports a spent unit under an INITIAL request", () => {
    expect(
      classifyReconciliationEntitlement({
        requestKind: "INITIAL",
        reservationState: "CONSUMED",
      }),
    ).toBe("INITIAL_RESERVATION_ALREADY_CONSUMED");
  });

  it("reports a released reservation", () => {
    expect(
      classifyReconciliationEntitlement({
        requestKind: "INITIAL",
        reservationState: "RELEASED",
      }),
    ).toBe("RESERVATION_RELEASED");
  });

  it("reports a reservation still being taken", () => {
    expect(
      classifyReconciliationEntitlement({
        requestKind: "INITIAL",
        reservationState: "RESERVING",
      }),
    ).toBe("RESERVATION_RESERVING");
  });

  it("reports a RESERVED hold as inconsistent for a reconciling attempt", () => {
    // Not wrong to act on, but not right either: something restored this hold
    // without going through a reconciliation conclusion. Recorded rather than
    // silently released, because guessing a destructive transition on
    // bookkeeping that already disagrees with itself makes two problems.
    for (const requestKind of KINDS) {
      expect(
        classifyReconciliationEntitlement({ requestKind, reservationState: "RESERVED" }),
      ).toBe("RESERVATION_STATE_INCONSISTENT");
    }
  });

  it("uses only the Phase 2G-1 vocabulary, inventing no second set of strings", () => {
    // Two vocabularies for one concept would force an operator querying
    // entitlement anomalies to know which phase wrote each row.
    const seen = new Set<string>();
    for (const requestKind of KINDS) {
      for (const reservationState of [...STATES, null]) {
        seen.add(classifyReconciliationEntitlement({ requestKind, reservationState }));
      }
    }
    for (const label of seen) {
      expect(ENTITLEMENT_ANOMALIES as readonly string[]).toContain(label);
    }
  });

  it("produces a label for every reachable pairing", () => {
    for (const requestKind of KINDS) {
      for (const reservationState of [...STATES, null]) {
        expect(
          typeof classifyReconciliationEntitlement({ requestKind, reservationState }),
        ).toBe("string");
      }
    }
  });
});
