import type { PeriodEntitlementBalance } from "../entitlement/allocation";
import type { UnitEntitlementPeriod, UnitEntitlementRepository } from "../entitlement/ports";
import type { OrganizationSubscription, SubscriptionRepository } from "../entitlement/subscription";
import type { UnitPurchase, UnitPurchaseRepository } from "../entitlement/unit-purchase";

/**
 * The read side of subscriptions and the Unit ledger, in memory, for the Units
 * overview (ADR-0066), and the purchases it lists (ADR-0069). Facts are set
 * directly; a period without a balance set reads as untouched: its whole
 * allowance and no block.
 */
export class InMemoryUnitsReader
  implements
    Pick<SubscriptionRepository, "findByOrganization">,
    Pick<UnitEntitlementRepository, "findPeriodAt" | "balance">,
    Pick<UnitPurchaseRepository, "listForPeriod">
{
  readonly subscriptions = new Map<string, OrganizationSubscription>();
  readonly periods: UnitEntitlementPeriod[] = [];
  readonly balances = new Map<string, PeriodEntitlementBalance>();
  readonly purchases: UnitPurchase[] = [];

  async listForPeriod(organizationId: string, entitlementPeriodId: string): Promise<readonly UnitPurchase[]> {
    return this.purchases
      .filter((p) => p.organizationId === organizationId && p.entitlementPeriodId === entitlementPeriodId)
      .sort((a, b) => a.approvedAt.getTime() - b.approvedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async findByOrganization(organizationId: string): Promise<OrganizationSubscription | null> {
    return this.subscriptions.get(organizationId) ?? null;
  }

  async findPeriodAt(organizationId: string, at: Date): Promise<UnitEntitlementPeriod | null> {
    const time = at.getTime();
    return (
      this.periods.find(
        (period) =>
          period.organizationId === organizationId &&
          period.startsAt.getTime() <= time &&
          time < period.endsAt.getTime(),
      ) ?? null
    );
  }

  async balance(organizationId: string, entitlementPeriodId: string): Promise<PeriodEntitlementBalance | null> {
    const period = this.periods.find((p) => p.id === entitlementPeriodId && p.organizationId === organizationId);
    if (period === undefined) return null;
    return (
      this.balances.get(entitlementPeriodId) ?? {
        baseRemainingUnits: period.baseUnits,
        includedHighQualityRemainingUnits: period.includedHighQualityUnits,
        blocks: [],
      }
    );
  }
}
