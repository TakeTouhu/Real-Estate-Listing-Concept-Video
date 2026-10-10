import { createCustomerPlanCatalog, type CustomerPlanKey } from "../pricing/customer-plan-catalog";

/**
 * The plan facts an entitlement period is opened with.
 *
 * Derived from the customer plan catalog and **frozen onto the period** rather
 * than read back from the catalog later: a period that has already started must
 * keep the allowance it started with, whatever a later catalog revision says.
 * The values are not accepted from a caller for the same reason a job's Unit
 * counts are not — a caller-supplied allowance is an allowance nobody approved.
 */
export interface EntitlementPlanSnapshot {
  readonly planKey: CustomerPlanKey;
  readonly baseUnits: number;
  readonly includedHighQualityUnits: number;
  readonly highQualityAddOnAvailable: boolean;
}

export function entitlementSnapshotForPlan(planKey: CustomerPlanKey): EntitlementPlanSnapshot {
  const plan = createCustomerPlanCatalog().find(planKey);
  if (plan === undefined) throw new Error(`No customer plan named ${planKey}`);
  return {
    planKey,
    baseUnits: plan.includedVideoUnits,
    includedHighQualityUnits: plan.includedHighQualityUnits,
    highQualityAddOnAvailable: plan.highQualityAddOnAvailable,
  };
}
