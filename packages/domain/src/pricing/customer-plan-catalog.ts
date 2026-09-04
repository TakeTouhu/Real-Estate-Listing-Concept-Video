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
}

/** Every plan is a 12-month contract; payment cadence is a later billing concern. */
export const CONTRACT_MONTHS = 12;

/** Annual prepayment discount: 5%, so the customer pays 95%. */
export const ANNUAL_PREPAYMENT_DISCOUNT_BPS: Bps = bps(500);

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
  },
  {
    key: "premium",
    monthlyPriceYenExTax: yen(119_800),
    includedUsers: 10,
    includedVideoUnits: 40,
    includedHighQualityUnits: 5,
    highQualityAddOnAvailable: true,
  },
  {
    key: "enterprise",
    monthlyPriceYenExTax: yen(298_000),
    includedUsers: 30,
    includedVideoUnits: 100,
    includedHighQualityUnits: 10,
    highQualityAddOnAvailable: true,
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
