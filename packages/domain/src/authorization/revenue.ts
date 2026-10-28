import {
  createCustomerPlanCatalog,
  type CustomerPlanCatalog,
  type CustomerPlanKey,
} from "../pricing/customer-plan-catalog";
import { yen, type Yen } from "../pricing/units";
import type { BillingCycleRevenueReader } from "./ports";

/**
 * A reader that knows no revenue at all.
 *
 * It returns `null` for every cycle. Written when Phase 4C-3B-2E persisted no
 * subscription, no plan assignment and no invoice, it was the only reader until
 * GS-5b (ADR-0091); it remains for compositions and tests that must fail closed
 * whatever the database holds.
 *
 * When nothing else was known, the alternatives were all worse. Assuming
 * Standard would hard-pause an Enterprise customer at a quarter of their real
 * threshold. Deriving a plan from seat count or usage would invent a commercial
 * fact from operational data. Defaulting to zero would make every threshold the
 * absolute floor and make the guard's arithmetic meaningless while looking like
 * it worked. `null` fails the gate closed.
 */
export function createUnavailableBillingCycleRevenueReader(): BillingCycleRevenueReader {
  return {
    async revenueYen() {
      return null;
    },
  };
}

/** What one billing cycle's revenue is computed from: its period's facts. */
export interface BillingCycleRevenueFacts {
  /** The plan the period was opened on, frozen at opening. */
  readonly planKey: CustomerPlanKey;
  /** Every Unit purchase approved on the period, cancelled or not. */
  readonly purchases: readonly {
    readonly priceYenExTax: Yen;
    readonly cancelled: boolean;
  }[];
}

/**
 * A billing cycle's revenue, as the product owner decided on 2026-10-27
 * (ADR-0091): the plan's monthly price plus the period's Unit purchases, both
 * tax-exclusive.
 *
 * - A cancelled purchase counts nothing: it is withdrawn and not invoiced
 *   (ADR-0070).
 * - Seats and storage blocks are not counted.
 * - Enterprise is `null`, unknown, until its contracted price is recorded:
 *   its catalog price is a list price, not what any customer agreed to pay.
 *
 * `null` fails the gate closed, as for a plan the catalog does not know.
 */
export function billingCycleRevenueYen(
  facts: BillingCycleRevenueFacts,
  plans: CustomerPlanCatalog = createCustomerPlanCatalog(),
): Yen | null {
  if (facts.planKey === "enterprise") return null;
  const plan = plans.find(facts.planKey);
  if (plan === undefined) return null;
  let total: number = plan.monthlyPriceYenExTax;
  for (const purchase of facts.purchases) {
    if (!purchase.cancelled) total += purchase.priceYenExTax;
  }
  // Throws past a safe integer rather than rounding a revenue figure.
  return yen(total);
}
