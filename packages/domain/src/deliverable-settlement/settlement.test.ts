import { describe, expect, it } from "vitest";
import {
  DeliverableSettlementDefect,
  isDeliverableFailureSettled,
  settleFailedDeliverable,
} from "./settlement";
import { GENERATION_JOB_STATES, GENERATION_RESERVATION_STATES } from "../orchestration/types";

/**
 * How a failed deliverable cycle settles (ADR-0082), asserted as literals.
 */

describe("settleFailedDeliverable", () => {
  it.each([["RESERVED"], ["RECONCILIATION_HOLD"]] as const)(
    "releases an initial generation's Unit from %s and fails the job",
    (reservationState) => {
      expect(
        settleFailedDeliverable({ currentDeliverableVersionId: null, reservationState }),
      ).toEqual({ kind: "RELEASE", jobState: "FAILED_TERMINAL", releaseFrom: reservationState });
    },
  );

  it("rolls a replacement back to the video the customer already holds", () => {
    expect(
      settleFailedDeliverable({ currentDeliverableVersionId: "gdv_1", reservationState: "CONSUMED" }),
    ).toEqual({ kind: "ROLL_BACK", jobState: "DELIVERABLE_READY" });
  });

  it.each([[null], ["RESERVING"], ["CONSUMED"], ["RELEASED"]] as const)(
    "refuses an initial generation whose Unit is %s",
    (reservationState) => {
      expect(() =>
        settleFailedDeliverable({ currentDeliverableVersionId: null, reservationState }),
      ).toThrow(DeliverableSettlementDefect);
    },
  );

  it.each([[null], ["RESERVING"], ["RESERVED"], ["RECONCILIATION_HOLD"], ["RELEASED"]] as const)(
    "refuses a replacement whose earlier delivery's Unit is %s",
    (reservationState) => {
      expect(() =>
        settleFailedDeliverable({ currentDeliverableVersionId: "gdv_1", reservationState }),
      ).toThrow(
        expect.objectContaining({
          code: "RESERVATION_NOT_SETTLEABLE",
          message: "A failed deliverable's reservation is not in a state its job can settle",
        }),
      );
    },
  );

  it("answers exactly the two settlements, or the defect, whatever it is handed", () => {
    // The whole table: the three legitimate rows settle, and every other pair
    // is the defect. No answer consumes a Unit or names a third job state.
    const settled: unknown[] = [];
    for (const reservationState of [...GENERATION_RESERVATION_STATES, null]) {
      for (const pointer of [null, "gdv_1"]) {
        let answer: unknown;
        try {
          answer = settleFailedDeliverable({ currentDeliverableVersionId: pointer, reservationState });
        } catch (error) {
          expect(error).toBeInstanceOf(DeliverableSettlementDefect);
          expect((error as DeliverableSettlementDefect).code).toBe("RESERVATION_NOT_SETTLEABLE");
          continue;
        }
        settled.push({ pointer, reservationState, answer });
      }
    }
    expect(settled).toEqual([
      {
        pointer: null,
        reservationState: "RESERVED",
        answer: { kind: "RELEASE", jobState: "FAILED_TERMINAL", releaseFrom: "RESERVED" },
      },
      {
        pointer: null,
        reservationState: "RECONCILIATION_HOLD",
        answer: { kind: "RELEASE", jobState: "FAILED_TERMINAL", releaseFrom: "RECONCILIATION_HOLD" },
      },
      {
        pointer: "gdv_1",
        reservationState: "CONSUMED",
        answer: { kind: "ROLL_BACK", jobState: "DELIVERABLE_READY" },
      },
    ]);
  });
});

describe("isDeliverableFailureSettled", () => {
  const initial = {
    failedIn: "DELIVERABLE_VALIDATING",
    currentDeliverableVersionId: null,
    failedVersionIsNewest: true,
  } as const;

  it("holds an initial generation settled only when failed and released", () => {
    expect(
      isDeliverableFailureSettled({
        ...initial,
        jobState: "FAILED_TERMINAL",
        reservationState: "RELEASED",
      }),
    ).toBe(true);
    for (const jobState of GENERATION_JOB_STATES) {
      for (const reservationState of [...GENERATION_RESERVATION_STATES, null]) {
        if (jobState === "FAILED_TERMINAL" && reservationState === "RELEASED") continue;
        expect(isDeliverableFailureSettled({ ...initial, jobState, reservationState })).toBe(false);
      }
    }
  });

  const replacement = {
    currentDeliverableVersionId: "gdv_1",
    reservationState: "CONSUMED",
  } as const;

  it.each([["COMPOSING"], ["DELIVERABLE_VALIDATING"]] as const)(
    "holds a replacement unsettled while the job still sits in %s on that version",
    (failedIn) => {
      expect(
        isDeliverableFailureSettled({
          ...replacement,
          failedIn,
          jobState: failedIn,
          failedVersionIsNewest: true,
        }),
      ).toBe(false);
    },
  );

  it.each([[null], ["RESERVING"], ["RESERVED"], ["RECONCILIATION_HOLD"], ["RELEASED"]] as const)(
    "holds a replacement unsettled whose Unit is %s, wherever the job went",
    (reservationState) => {
      expect(
        isDeliverableFailureSettled({
          ...replacement,
          reservationState,
          failedIn: "COMPOSING",
          jobState: "DELIVERABLE_READY",
          failedVersionIsNewest: true,
        }),
      ).toBe(false);
    },
  );

  it("holds a replacement settled once the job left that cycle", () => {
    expect(
      isDeliverableFailureSettled({
        ...replacement,
        failedIn: "COMPOSING",
        jobState: "DELIVERABLE_READY",
        failedVersionIsNewest: true,
      }),
    ).toBe(true);
    // A later revision of the same job is composing a newer version now.
    expect(
      isDeliverableFailureSettled({
        ...replacement,
        failedIn: "COMPOSING",
        jobState: "COMPOSING",
        failedVersionIsNewest: false,
      }),
    ).toBe(true);
  });
});

describe("DeliverableSettlementDefect", () => {
  it.each([
    ["SETTLEMENT_INCOMPLETE", "A failed deliverable's terminal record exists without its settlement"],
    [
      "SETTLEMENT_LOST_UNDER_LOCK",
      "A failed deliverable's settlement write matched no row while holding that row's lock",
    ],
  ] as const)("says what %s means", (code, message) => {
    const defect = new DeliverableSettlementDefect(code);
    expect(defect.code).toBe(code);
    expect(defect.message).toBe(message);
    expect(defect.name).toBe("DeliverableSettlementDefect");
  });
});
