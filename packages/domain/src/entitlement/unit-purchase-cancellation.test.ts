import { describe, expect, it } from "vitest";
import { unitPurchaseUsage } from "./unit-purchase-cancellation";
import { yenToInvoiceExTax } from "./unit-purchase-invoicing";

/**
 * How a cancelled purchase is counted (UP-5, ADR-0070): its Units by how their
 * reservations stand, and nothing to invoice once it is cancelled.
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
