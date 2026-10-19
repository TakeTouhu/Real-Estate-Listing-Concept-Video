import { AppError } from "@app/shared";
import { authorizeOrganization } from "../identity/authorization";
import type { IdentityServiceDeps } from "../identity/ports";
import type { GenerationQualityTier } from "../orchestration/types";
import { createCustomerPlanCatalog, type CustomerPlanKey } from "../pricing/customer-plan-catalog";
import type { Yen } from "../pricing/units";
import type { PeriodEntitlementBalance } from "./allocation";
import { entitlementSnapshotForPlan } from "./plan-entitlement";
import type { UnitEntitlementPeriod, UnitEntitlementRepository } from "./ports";
import {
  renewalPeriodAt,
  type OrganizationSubscription,
  type SubscriptionChannel,
  type SubscriptionRepository,
} from "./subscription";
import type { UnitPurchaseRepository } from "./unit-purchase";

/**
 * What an organization has left to generate with this period (ADR-0066
 * Decision 3): its plan, the period's bounds, its Base Units and how many of
 * them can still fund HQ, every add-on block with what remains of it, and, for
 * a holder of `billing.view`, the packages bought into the period (ADR-0069).
 *
 * **Read only.** A period nobody has used yet is not opened to be shown: what it
 * would hold is derived from the subscription exactly as opening it would
 * freeze it, so viewing the page writes nothing.
 */

/** Billing facts, shown only to a holder of `billing.view`. */
export interface UnitsOverviewBilling {
  readonly channel: SubscriptionChannel;
  readonly monthlyPriceYenExTax: Yen;
}

/** A package bought this period, shown only to a holder of `billing.view` (UP-4, ADR-0069). */
export interface UnitsOverviewPurchase {
  readonly quality: GenerationQualityTier;
  readonly units: number;
  /** The price it was approved at, excluding tax. */
  readonly priceYenExTax: number;
  readonly approvedAt: Date;
  /** The approver's name while it is still a member; `null` once it has left. */
  readonly approvedBy: string | null;
  /** When VTaVision cancelled it, so it is not invoiced (UP-5, ADR-0070); `null` otherwise. */
  readonly cancelledAt: Date | null;
}

export interface UnitsOverviewAddOnBlock {
  /** Quality-locked for life: Normal funds only Normal, HQ only HQ. */
  readonly quality: GenerationQualityTier;
  /** 0 once withdrawn. */
  readonly remainingUnits: number;
  readonly purchasedAt: Date;
  /** Whether its purchase was cancelled, so it funds nothing new (UP-5, ADR-0070). */
  readonly withdrawn: boolean;
}

export type UnitsOverview =
  /** No subscription and no period: nothing to generate with. */
  | { readonly kind: "NO_PLAN" }
  /** The subscription's first period has not started yet. */
  | {
      readonly kind: "NOT_STARTED";
      readonly planKey: CustomerPlanKey;
      readonly startsAt: Date;
      readonly billing: UnitsOverviewBilling | null;
    }
  | {
      readonly kind: "ACTIVE";
      readonly planKey: CustomerPlanKey;
      /** Inclusive start, exclusive end. Every Unit below expires at `endsAt`. */
      readonly period: { readonly startsAt: Date; readonly endsAt: Date };
      /** Base Units fund Normal or HQ; nothing carries over. */
      readonly baseUnits: { readonly included: number; readonly remaining: number };
      readonly highQuality: {
        /** The plan's HQ ceiling, inside the Base Units, never extra. */
        readonly includedCeiling: number;
        readonly ceilingRemaining: number;
        /** Base Units that can still fund HQ: bounded by both the Base Units and the ceiling. */
        readonly fundableFromBase: number;
      };
      /** Whether the plan sells HQ packages at all. Standard does not. */
      readonly highQualityAddOnAvailable: boolean;
      /** Oldest first, the order they are spent in within each quality. */
      readonly addOnBlocks: readonly UnitsOverviewAddOnBlock[];
      readonly normalAddOnRemaining: number;
      readonly highQualityAddOnRemaining: number;
      readonly billing: UnitsOverviewBilling | null;
      /** This period's purchases, oldest first, for a holder of `billing.view`; `null` for anyone else. */
      readonly purchases: readonly UnitsOverviewPurchase[] | null;
      /** Whether the viewer holds `billing.manage`, and so may buy additional Units (UP-3). */
      readonly mayBuyUnits: boolean;
    };

export interface UnitsOverviewDeps {
  /** Membership lookup for authorization and approvers' names, and the clock. */
  readonly identity: IdentityServiceDeps;
  readonly subscriptions: Pick<SubscriptionRepository, "findByOrganization">;
  readonly ledger: Pick<UnitEntitlementRepository, "findPeriodAt" | "balance">;
  readonly purchases: Pick<UnitPurchaseRepository, "listForPeriod">;
}

function billingOf(subscription: OrganizationSubscription): UnitsOverviewBilling {
  const plan = createCustomerPlanCatalog().find(subscription.planKey);
  if (plan === undefined) throw new Error(`No customer plan named ${subscription.planKey}`);
  return { channel: subscription.channel, monthlyPriceYenExTax: plan.monthlyPriceYenExTax };
}

function fromLedger(
  period: UnitEntitlementPeriod,
  balance: PeriodEntitlementBalance,
  billing: UnitsOverviewBilling | null,
  purchases: readonly UnitsOverviewPurchase[] | null,
  mayBuyUnits: boolean,
): UnitsOverview {
  const blocks = [...balance.blocks]
    .sort((a, b) => a.purchasedAtEpochMs - b.purchasedAtEpochMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((block) => ({
      quality: block.quality,
      remainingUnits: block.remainingUnits,
      purchasedAt: new Date(block.purchasedAtEpochMs),
      withdrawn: block.withdrawn,
    }));
  const remainingOf = (quality: GenerationQualityTier) =>
    blocks.filter((block) => block.quality === quality).reduce((sum, block) => sum + block.remainingUnits, 0);
  return {
    kind: "ACTIVE",
    planKey: period.planKey,
    period: { startsAt: period.startsAt, endsAt: period.endsAt },
    baseUnits: { included: period.baseUnits, remaining: balance.baseRemainingUnits },
    highQuality: {
      includedCeiling: period.includedHighQualityUnits,
      ceilingRemaining: balance.includedHighQualityRemainingUnits,
      fundableFromBase: Math.min(balance.baseRemainingUnits, balance.includedHighQualityRemainingUnits),
    },
    highQualityAddOnAvailable: period.highQualityAddOnAvailable,
    addOnBlocks: blocks,
    normalAddOnRemaining: remainingOf("NORMAL"),
    highQualityAddOnRemaining: remainingOf("HIGH_QUALITY"),
    billing,
    purchases,
    mayBuyUnits,
  };
}

export class UnitsOverviewService {
  constructor(private readonly deps: UnitsOverviewDeps) {}

  /** The period's purchases as a holder of `billing.view` sees them, each approver named once. */
  private async purchasesOf(organizationId: string, periodId: string): Promise<UnitsOverviewPurchase[]> {
    const purchases = await this.deps.purchases.listForPeriod(organizationId, periodId);
    const { repos } = this.deps.identity;
    const names = new Map<string, string | null>();
    for (const { approvedByUserId: userId } of purchases) {
      if (names.has(userId)) continue;
      const member = await repos.memberships.find(organizationId, userId);
      names.set(userId, member === null ? null : ((await repos.users.findById(userId))?.name ?? null));
    }
    return purchases.map((purchase) => ({
      quality: purchase.quality,
      units: purchase.units,
      priceYenExTax: purchase.priceYenExTax,
      approvedAt: purchase.approvedAt,
      approvedBy: names.get(purchase.approvedByUserId) ?? null,
      cancelledAt: purchase.cancelledAt,
    }));
  }

  /**
   * The organization's Units this period, for a holder of `unit.view`.
   *
   * The ledger's period containing now is shown as the ledger has it. Without
   * one, the subscription's current period is shown as it would open: the
   * plan's full allowance, no block. Billing facts and the period's purchases
   * need `billing.view` as well.
   *
   * @throws AppError FORBIDDEN for a non-member, or a member without `unit.view`.
   */
  async overview(actorUserId: string, organizationId: string): Promise<UnitsOverview> {
    const auth = await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "unit.view");
    const now = this.deps.identity.clock.now();
    const subscription = await this.deps.subscriptions.findByOrganization(organizationId);
    const mayViewBilling = auth.permissions.includes("billing.view");
    const billing = subscription !== null && mayViewBilling ? billingOf(subscription) : null;
    const mayBuyUnits = auth.permissions.includes("billing.manage");

    const period = await this.deps.ledger.findPeriodAt(organizationId, now);
    if (period !== null) {
      const balance = await this.deps.ledger.balance(organizationId, period.id);
      if (balance === null) {
        throw new AppError("INTERNAL_ERROR", "The current Unit period could not be read");
      }
      const purchases = mayViewBilling ? await this.purchasesOf(organizationId, period.id) : null;
      return fromLedger(period, balance, billing, purchases, mayBuyUnits);
    }

    if (subscription === null) return { kind: "NO_PLAN" };
    const bounds = renewalPeriodAt(subscription.anchorAt, now);
    if (bounds === null) {
      return { kind: "NOT_STARTED", planKey: subscription.planKey, startsAt: subscription.anchorAt, billing };
    }
    const snapshot = entitlementSnapshotForPlan(subscription.planKey);
    return {
      kind: "ACTIVE",
      planKey: subscription.planKey,
      period: { startsAt: bounds.startsAt, endsAt: bounds.endsAt },
      baseUnits: { included: snapshot.baseUnits, remaining: snapshot.baseUnits },
      highQuality: {
        includedCeiling: snapshot.includedHighQualityUnits,
        ceilingRemaining: snapshot.includedHighQualityUnits,
        fundableFromBase: Math.min(snapshot.baseUnits, snapshot.includedHighQualityUnits),
      },
      highQualityAddOnAvailable: snapshot.highQualityAddOnAvailable,
      addOnBlocks: [],
      normalAddOnRemaining: 0,
      highQualityAddOnRemaining: 0,
      billing,
      // A purchase opens its period, so a period nobody has opened has none.
      purchases: mayViewBilling ? [] : null,
      mayBuyUnits,
    };
  }
}
