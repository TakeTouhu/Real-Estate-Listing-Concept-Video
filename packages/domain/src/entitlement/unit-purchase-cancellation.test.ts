import { describe, expect, it } from "vitest";
import {
  CUSTOMER_MISTAKE_REFUND_WINDOW_MS,
  cancellationRefusal,
  customerMistakeRefundDeadline,
  unitPurchaseUsage,
} from "./unit-purchase-cancellation";
import { yenToInvoiceExTax } from "./unit-purchase-invoicing";

/**
 * How a cancelled purchase is counted (UP-5, ADR-0070): its Units by how their
 * reservations stand, nothing to invoice once it is cancelled, and when the
 * customer's own mistake can be refunded at all.
 */

describe("a purchase's usage", () => {
  it("counts delivered, still-running and unused Units from its block's allocations", () => {
    expect(
      unitPurchaseUsage(10, [
        { quantity: 2, reservationState: "CONSUMED" },
        { quantity: 1, reservationState: "CONSUMED" },
        { quantity: 3, reservationState: "RESERVED" },
        { quantity: 1, reservationState: "RECONCILIATION_HOLD" },
        { quantity: 2, reservationState: "RELEASED" },
      ]),
    ).toEqual({ consumed: 3, inFlight: 4, unused: 3 });
  });

  it.each(["RESERVING", "RESERVED", "RECONCILIATION_HOLD"] as const)("counts a %s reservation as in flight", (state) => {
    expect(unitPurchaseUsage(2, [{ quantity: 1, reservationState: state }])).toEqual({
      consumed: 0,
      inFlight: 1,
      unused: 1,
    });
  });

  it("counts a block nothing drew on as wholly unused", () => {
    expect(unitPurchaseUsage(10, [])).toEqual({ consumed: 0, inFlight: 0, unused: 10 });
  });

  it("counts a released allocation as never used", () => {
    expect(unitPurchaseUsage(2, [{ quantity: 2, reservationState: "RELEASED" }])).toEqual({
      consumed: 0,
      inFlight: 0,
      unused: 2,
    });
  });
});

describe("what to invoice", () => {
  it("is the approved price, excluding tax, until the purchase is cancelled, and nothing after", () => {
    expect(yenToInvoiceExTax({ priceYenExTax: 35_900, cancelledAt: null })).toBe(35_900);
    expect(yenToInvoiceExTax({ priceYenExTax: 35_900, cancelledAt: new Date("2026-10-20T00:00:00.000Z") })).toBe(0);
  });
});

describe("whose mistake it was", () => {
  const approvedAt = new Date("2026-10-19T01:00:00.000Z");
  const unused = { consumed: 0, inFlight: 0, unused: 10 };
  const at = (ms: number) => ({ approvedAt, usage: unused, readAt: new Date(approvedAt.getTime() + ms) });

  it("gives the customer 10 hours from the approval", () => {
    expect(CUSTOMER_MISTAKE_REFUND_WINDOW_MS).toBe(36_000_000);
    expect(customerMistakeRefundDeadline(approvedAt)).toEqual(new Date("2026-10-19T11:00:00.000Z"));
  });

  it("refunds the customer's mistake up to and at exactly 10 hours, with none of its Units used", () => {
    for (const ms of [0, 1, CUSTOMER_MISTAKE_REFUND_WINDOW_MS - 1, CUSTOMER_MISTAKE_REFUND_WINDOW_MS]) {
      expect(cancellationRefusal("CUSTOMER", at(ms))).toBeNull();
    }
  });

  it("refuses the customer's mistake a millisecond after the 10 hours", () => {
    expect(cancellationRefusal("CUSTOMER", at(CUSTOMER_MISTAKE_REFUND_WINDOW_MS + 1))).toBe("REFUND_WINDOW_PASSED");
  });

  it.each([
    ["delivered", { consumed: 1, inFlight: 0, unused: 9 }],
    ["still generating", { consumed: 0, inFlight: 1, unused: 9 }],
  ])("refuses the customer's mistake once one Unit is %s", (_, usage) => {
    expect(cancellationRefusal("CUSTOMER", { ...at(60_000), usage })).toBe("UNITS_USED");
  });

  it("says the window passed first when both apply", () => {
    const late = { ...at(CUSTOMER_MISTAKE_REFUND_WINDOW_MS + 1), usage: { consumed: 10, inFlight: 0, unused: 0 } };
    expect(cancellationRefusal("CUSTOMER", late)).toBe("REFUND_WINDOW_PASSED");
  });

  it("never refuses VTaVision's own mistake, however late and however used", () => {
    const late = { ...at(30 * 86_400_000), usage: { consumed: 6, inFlight: 4, unused: 0 } };
    expect(cancellationRefusal("VTAVISION", late)).toBeNull();
  });
});
