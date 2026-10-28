import { deepFreeze } from "@app/shared";
import { bps, yen, type Bps, type Yen } from "./units";

/**
 * The customer plan catalog.
 *
 * Deliberately a different catalog from the model catalog, and deliberately
 * carrying no provider fact. A customer plan is a commercial promise; a
 * provider price is a cost. Putting them in one object would mean a vendor
 * changing its rate card could silently move what a customer is charged or
 * entitled to, which is exactly the coupling this phase exists to prevent.
 *
 * Every amount is **tax-exclusive**. The field names say so rather than leaving
 * it to a comment, because "¥49,800" that silently meant one thing to pricing
 * and another to an invoice is the expensive kind of ambiguity. Consumption tax
 * is not calculated in this phase.
 */

export type CustomerPlanKey = "standard" | "premium" | "enterprise";

export interface CustomerPlan {
  readonly key: CustomerPlanKey;
  readonly monthlyPriceYenExTax: Yen;
  readonly includedUsers: number;
  /** The whole entitlement. High-quality usage is drawn from this, not added to it. */
  readonly includedVideoUnits: number;
  /** A ceiling *within* `includedVideoUnits`, never an additional pool. */
  readonly includedHighQualityUnits: number;
  readonly highQualityAddOnAvailable: boolean;
  /** Units in one Normal add-on package (ADR-0053 Decision 2). */
  readonly normalAddOnPackageUnits: number;
  /** Units in one HQ add-on package, or `null` where the plan sells none. */
  readonly highQualityAddOnPackageUnits: number | null;
  /**
   * The approved price of one Normal package (ADR-0053 Decision 2). The price
   * authority: a purchase is charged this, and records it. A test pins it to the
   * package price formula.
   */
  readonly normalAddOnPackagePriceYenExTax: Yen;
  /** The approved price of one HQ package, or `null` where the plan sells none. */
  readonly highQualityAddOnPackagePriceYenExTax: Yen | null;
  /**
   * How many customer video Jobs may run at once (ADR-0052 Decision 7). It
   * counts jobs, not the provider requests inside them, and HQ shares it. A job
   * beyond it waits, its Units reserved, rather than being refused.
   */
  readonly concurrentJobs: number;
}

/*
 * There is deliberately no contract-term or annual-prepayment constant here.
 *
 * This catalog once declared every plan a 12-month contract with a standard 5%
 * annual-prepayment discount. ADR-0053 Decision 1A replaced that: Standard and
 * Premium are one-month, monthly-renewing subscriptions with no minimum term, no
 * annual-prepayment product and no standard discount, and Enterprise terms and
 * discounts are individually agreed. A platform-wide term or discount would
 * restate a commercial promise nobody makes, so neither is represented.
 */

/** Identical on every plan, and it buys a seat — never generation entitlement. */
export const ADDITIONAL_USER_PRICE_YEN_EX_TAX_PER_MONTH: Yen = yen(3_000);

/** Add-on multipliers over the plan-derived calculation base. */
export const NORMAL_ADD_ON_MULTIPLIER_BPS: Bps = bps(12_000);
export const HIGH_QUALITY_ADD_ON_MULTIPLIER_BPS: Bps = bps(15_000);

const PLANS: readonly CustomerPlan[] = deepFreeze([
  {
    key: "standard",
    monthlyPriceYenExTax: yen(49_800),
    includedUsers: 3,
    includedVideoUnits: 15,
    includedHighQualityUnits: 1,
    // Standard may *use* its one high-quality unit but may not buy more.
    highQualityAddOnAvailable: false,
    normalAddOnPackageUnits: 5,
    highQualityAddOnPackageUnits: null,
    normalAddOnPackagePriceYenExTax: yen(19_900),
    highQualityAddOnPackagePriceYenExTax: null,
    concurrentJobs: 1,
  },
  {
    key: "premium",
    monthlyPriceYenExTax: yen(119_800),
    includedUsers: 10,
    includedVideoUnits: 40,
    includedHighQualityUnits: 5,
    highQualityAddOnAvailable: true,
    normalAddOnPackageUnits: 10,
    highQualityAddOnPackageUnits: 2,
    normalAddOnPackagePriceYenExTax: yen(35_900),
    highQualityAddOnPackagePriceYenExTax: yen(9_000),
    concurrentJobs: 3,
  },
  {
    key: "enterprise",
    monthlyPriceYenExTax: yen(298_000),
    includedUsers: 30,
    includedVideoUnits: 100,
    includedHighQualityUnits: 10,
    highQualityAddOnAvailable: true,
    normalAddOnPackageUnits: 25,
    highQualityAddOnPackageUnits: 5,
    normalAddOnPackagePriceYenExTax: yen(89_400),
    highQualityAddOnPackagePriceYenExTax: yen(22_400),
    concurrentJobs: 5,
  },
] as const);

export interface CustomerPlanCatalog {
  find(key: CustomerPlanKey): CustomerPlan | undefined;
  all(): readonly CustomerPlan[];
}

/**
 * The catalog reads from one frozen table and hands out the frozen entries by
 * reference. It does not copy: a copy would be mutable again, and two callers
 * holding different objects for one plan is how catalogs drift.
 */
export function createCustomerPlanCatalog(): CustomerPlanCatalog {
  return {
    find: (key) => PLANS.find((plan) => plan.key === key),
    all: () => PLANS,
  };
}
