import type { PeriodEntitlementBalance } from "../entitlement/allocation";
import { entitlementSnapshotForPlan } from "../entitlement/plan-entitlement";
import type {
  OpenEntitlementPeriodInput,
  OpenEntitlementPeriodOutcome,
  UnitAddOnBlock,
  UnitEntitlementPeriod,
  UnitEntitlementRepository,
} from "../entitlement/ports";
import type {
  ApproveUnitPurchaseRecordOutcome,
  UnitPurchase,
  UnitPurchaseFacts,
  UnitPurchaseRecord,
  UnitPurchaseRefusal,
  UnitPurchaseRepository,
} from "../entitlement/unit-purchase";
import { effectivePermissionsOf } from "../identity/authorization";
import type { IdentityServiceDeps } from "../identity/ports";
import type { InMemoryUnitsReader } from "./in-memory-units";

/**
 * Unit purchases and the period opening they need, in memory, over the periods,
 * subscriptions and purchases of an {@link InMemoryUnitsReader} (ADR-0067). The approver's
 * permissions are read from the identity repositories when a purchase is
 * written, as the database reads them inside its transaction. Audit entries of a
 * written purchase are the database's; its tests cover them.
 */
export class InMemoryUnitPurchases
  implements UnitPurchaseRepository, Pick<UnitEntitlementRepository, "openPeriod" | "findPeriodAt" | "balance">
{
  readonly blocks: UnitAddOnBlock[] = [];

  constructor(
    private readonly reader: InMemoryUnitsReader,
    private readonly identity: Pick<IdentityServiceDeps, "repos">,
  ) {}

  /** The reader's, so the overview lists what was bought here. */
  get purchases(): UnitPurchase[] {
    return this.reader.purchases;
  }

  listForPeriod(organizationId: string, entitlementPeriodId: string): Promise<readonly UnitPurchase[]> {
    return this.reader.listForPeriod(organizationId, entitlementPeriodId);
  }

  async openPeriod(input: OpenEntitlementPeriodInput): Promise<OpenEntitlementPeriodOutcome> {
    const periods = this.reader.periods.filter((period) => period.organizationId === input.organizationId);
    const sameKey = periods.find((period) => period.billingCycleKey === input.billingCycleKey);
    if (sameKey !== undefined) {
      return sameKey.id === input.id && sameKey.startsAt.getTime() === input.startsAt.getTime()
        ? { kind: "ALREADY_OPEN", period: sameKey }
        : { kind: "CONFLICT" };
    }
    if (periods.some((period) => period.startsAt < input.endsAt && period.endsAt > input.startsAt)) {
      return { kind: "OVERLAPS_EXISTING_PERIOD" };
    }
    const snapshot = entitlementSnapshotForPlan(input.planKey);
    const period = {
      id: input.id,
      organizationId: input.organizationId,
      billingCycleKey: input.billingCycleKey,
      planKey: snapshot.planKey,
      baseUnits: snapshot.baseUnits,
      includedHighQualityUnits: snapshot.includedHighQualityUnits,
      highQualityAddOnAvailable: snapshot.highQualityAddOnAvailable,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      commercialReference: input.commercialReference,
      createdAt: input.startsAt,
    };
    this.reader.periods.push(period);
    return { kind: "OPENED", period };
  }

  findPeriodAt(organizationId: string, at: Date): Promise<UnitEntitlementPeriod | null> {
    return this.reader.findPeriodAt(organizationId, at);
  }

  balance(organizationId: string, entitlementPeriodId: string): Promise<PeriodEntitlementBalance | null> {
    return this.reader.balance(organizationId, entitlementPeriodId);
  }

  async findByIdempotencyKey(organizationId: string, idempotencyKey: string): Promise<UnitPurchase | null> {
    return (
      this.purchases.find((p) => p.organizationId === organizationId && p.idempotencyKey === idempotencyKey) ?? null
    );
  }

  async approve(
    record: UnitPurchaseRecord,
    check: (facts: UnitPurchaseFacts) => UnitPurchaseRefusal | null,
  ): Promise<ApproveUnitPurchaseRecordOutcome> {
    const period = this.reader.periods.find(
      (p) => p.id === record.entitlementPeriodId && p.organizationId === record.organizationId,
    );
    if (period === undefined) return { kind: "PERIOD_NOT_FOUND" };
    const existing = await this.findByIdempotencyKey(record.organizationId, record.idempotencyKey);
    if (existing !== null) return { kind: "EXISTING", purchase: existing };

    const membership = await this.identity.repos.memberships.find(record.organizationId, record.approvedByUserId);
    const refusal = check({
      period,
      subscription: this.reader.subscriptions.get(record.organizationId) ?? null,
      approverPermissions: membership === null ? null : await effectivePermissionsOf(this.identity, membership),
    });
    if (refusal !== null) return { kind: "REFUSED", reason: refusal };

    this.blocks.push({
      id: record.addOnBlockId,
      organizationId: record.organizationId,
      entitlementPeriodId: period.id,
      quality: record.quality,
      quantity: record.units,
      commercialReference: `unit-purchase:${record.id}`,
      purchasedAt: record.approvedAt,
      createdAt: record.approvedAt,
    });
    const purchase: UnitPurchase = {
      id: record.id,
      organizationId: record.organizationId,
      entitlementPeriodId: period.id,
      addOnBlockId: record.addOnBlockId,
      quality: record.quality,
      units: record.units,
      priceYenExTax: record.priceYenExTax,
      channel: record.channel,
      contractReference: record.contractReference,
      expiresAt: period.endsAt,
      idempotencyKey: record.idempotencyKey,
      approvedByUserId: record.approvedByUserId,
      approvedAt: record.approvedAt,
      cancelledAt: null,
    };
    this.purchases.push(purchase);
    return { kind: "APPROVED", purchase };
  }
}
