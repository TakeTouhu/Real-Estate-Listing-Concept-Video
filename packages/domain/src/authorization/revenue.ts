import type { BillingCycleRevenueReader } from "./ports";

/**
 * The billing-cycle revenue reader that exists today: none.
 *
 * It returns `null`, and that is the accurate answer rather than a placeholder
 * to be tidied later. Phase 4C-3B-2E persists no subscription, no plan
 * assignment and no invoice, so there is no authoritative figure for what an
 * organization pays in a billing cycle.
 *
 * The alternatives were all worse. Assuming Standard would hard-pause an
 * Enterprise customer at a quarter of their real threshold. Deriving a plan
 * from seat count or usage would invent a commercial fact from operational
 * data. Defaulting to zero would make every threshold the absolute floor and
 * make the guard's arithmetic meaningless while looking like it worked.
 *
 * `null` fails the gate closed. That is deliberately conspicuous: the paid gate
 * cannot authorize anything at all until the billing layer supplies this, which
 * is exactly the state a dormant phase should be in, and it appears in the
 * completion report as a named activation prerequisite rather than as a
 * surprise on the day someone enables a provider.
 */
export function createUnavailableBillingCycleRevenueReader(): BillingCycleRevenueReader {
  return {
    async revenueYen() {
      return null;
    },
  };
}
