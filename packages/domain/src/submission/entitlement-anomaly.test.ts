import { describe, expect, it } from "vitest";
import {
  GENERATION_RESERVATION_STATES,
  SCENE_GENERATION_REQUEST_KINDS,
} from "../orchestration/types";
import { ENTITLEMENT_ANOMALIES, classifyEntitlementAnomaly } from "./entitlement-anomaly";

/**
 * After the paid boundary an inconsistent reservation must never stop the
 * outcome being written — but "must not block" was being implemented as "must
 * not mention", so money spent against bookkeeping that did not add up left no
 * trace. This classifier is the half that makes the anomaly sayable.
 */

describe("classifying entitlement bookkeeping", () => {
  it("calls a held reservation normal for either request kind", () => {
    for (const requestKind of SCENE_GENERATION_REQUEST_KINDS) {
      expect(classifyEntitlementAnomaly({ requestKind, reservationState: "RESERVED" })).toBe(
        "NONE",
      );
    }
  });

  it("calls a CONSUMED reservation normal for a user regeneration", () => {
    // Sold with the original video and exercised after it has been delivered,
    // by which time the unit is spent by design.
    expect(
      classifyEntitlementAnomaly({
        requestKind: "USER_REGENERATION",
        reservationState: "CONSUMED",
      }),
    ).toBe("NONE");
  });

  it("flags a CONSUMED reservation under an INITIAL request", () => {
    // An initial request has no story that explains a spent unit: its own unit
    // should still be held, and a consumed one means the first video was
    // already paid out for this job.
    expect(
      classifyEntitlementAnomaly({ requestKind: "INITIAL", reservationState: "CONSUMED" }),
    ).toBe("INITIAL_RESERVATION_ALREADY_CONSUMED");
  });

  it("flags a missing reservation", () => {
    for (const requestKind of SCENE_GENERATION_REQUEST_KINDS) {
      expect(classifyEntitlementAnomaly({ requestKind, reservationState: null })).toBe(
        "RESERVATION_MISSING",
      );
    }
  });

  it("flags a released reservation", () => {
    expect(
      classifyEntitlementAnomaly({ requestKind: "INITIAL", reservationState: "RELEASED" }),
    ).toBe("RESERVATION_RELEASED");
  });

  it("flags a reservation still being taken", () => {
    // The boundary was crossed before reserving finished, which should be
    // impossible and is worth someone knowing about.
    expect(
      classifyEntitlementAnomaly({ requestKind: "INITIAL", reservationState: "RESERVING" }),
    ).toBe("RESERVATION_RESERVING");
  });

  it("treats an existing reconciliation hold as normal", () => {
    // Put there by an earlier uncertainty entry on the same job. Expected on a
    // sibling attempt rather than anomalous.
    for (const requestKind of SCENE_GENERATION_REQUEST_KINDS) {
      expect(
        classifyEntitlementAnomaly({ requestKind, reservationState: "RECONCILIATION_HOLD" }),
      ).toBe("NONE");
    }
  });

  it("answers every (request kind, reservation state) pair from the closed set", () => {
    for (const requestKind of SCENE_GENERATION_REQUEST_KINDS) {
      for (const reservationState of [...GENERATION_RESERVATION_STATES, null]) {
        const anomaly = classifyEntitlementAnomaly({ requestKind, reservationState });
        expect(ENTITLEMENT_ANOMALIES).toContain(anomaly);
      }
    }
  });

  it("never returns free text", () => {
    // The value goes into transition metadata, which is dumped into tickets.
    for (const anomaly of ENTITLEMENT_ANOMALIES) {
      expect(anomaly).toMatch(/^[A-Z][A-Z_]*$/);
    }
  });
});
