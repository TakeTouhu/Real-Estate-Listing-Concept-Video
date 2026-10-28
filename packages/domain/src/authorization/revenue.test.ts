import { describe, expect, it } from "vitest";
import { createCustomerPlanCatalog, type CustomerPlanCatalog } from "../pricing/customer-plan-catalog";
import { yen } from "../pricing/units";
import { billingCycleRevenueYen, createUnavailableBillingCycleRevenueReader } from "./revenue";

const bought = (price: number, cancelled = false) => ({ priceYenExTax: yen(price), cancelled });

describe("a billing cycle's revenue (ADR-0091)", () => {
  it("is the plan's monthly price, tax-exclusive, when nothing was bought", () => {
    expect(billingCycleRevenueYen({ planKey: "standard", purchases: [] })).toBe(49_800);
    expect(billingCycleRevenueYen({ planKey: "premium", purchases: [] })).toBe(119_800);
  });

  it("adds every Unit purchase approved on the period", () => {
    expect(billingCycleRevenueYen({ planKey: "standard", purchases: [bought(19_900), bought(19_900)] })).toBe(
      49_800 + 19_900 * 2,
    );
    expect(billingCycleRevenueYen({ planKey: "premium", purchases: [bought(35_900), bought(9_000)] })).toBe(
      119_800 + 35_900 + 9_000,
    );
  });

  it("counts a cancelled purchase as nothing, whatever its price", () => {
    expect(
      billingCycleRevenueYen({ planKey: "standard", purchases: [bought(19_900, true), bought(19_900)] }),
    ).toBe(49_800 + 19_900);
    expect(billingCycleRevenueYen({ planKey: "premium", purchases: [bought(35_900, true)] })).toBe(119_800);
  });

  it("is unknown for Enterprise, whose catalog price is no customer's contracted price", () => {
    expect(billingCycleRevenueYen({ planKey: "enterprise", purchases: [] })).toBeNull();
    expect(billingCycleRevenueYen({ planKey: "enterprise", purchases: [bought(89_400)] })).toBeNull();
  });

  it("is unknown for a plan the catalog does not hold", () => {
    const production = createCustomerPlanCatalog();
    const withoutPremium: CustomerPlanCatalog = {
      find: (key) => (key === "premium" ? undefined : production.find(key)),
      all: () => production.all().filter((plan) => plan.key !== "premium"),
    };
    expect(billingCycleRevenueYen({ planKey: "premium", purchases: [] }, withoutPremium)).toBeNull();
    expect(billingCycleRevenueYen({ planKey: "standard", purchases: [] }, withoutPremium)).toBe(49_800);
  });

  it("refuses a total past a safe integer rather than rounding it", () => {
    expect(() =>
      billingCycleRevenueYen({ planKey: "standard", purchases: [bought(Number.MAX_SAFE_INTEGER)] }),
    ).toThrow();
  });
});

describe("the reader that knows no revenue", () => {
  it("answers unknown for every cycle", async () => {
    const reader = createUnavailableBillingCycleRevenueReader();
    expect(await reader.revenueYen({ organizationId: "org_a", billingCycleKey: "2026-09" })).toBeNull();
  });
});
