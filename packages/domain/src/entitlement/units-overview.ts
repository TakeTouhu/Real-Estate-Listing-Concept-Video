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

/**
 * What an organization has left to generate with this period (ADR-0066
 * Decision 3): its plan, the period's bounds, its Base Units and how many of
 * them can still fund HQ, and every add-on block with what remains of it.
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

export interface UnitsOverviewAddOnBlock {
  /** Quality-locked for life: Normal funds only Normal, HQ only HQ. */
  readonly quality: GenerationQualityTier;
  readonly remainingUnits: number;
  readonly purchasedAt: Date;
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
    };

export interface UnitsOverviewDeps {
  /** Membership lookup for authorization, and the clock. */
  readonly identity: IdentityServiceDeps;
  readonly subscriptions: Pick<SubscriptionRepository, "findByOrganization">;
  readonly ledger: Pick<UnitEntitlementRepository, "findPeriodAt" | "balance">;
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
): UnitsOverview {
  const blocks = [...balance.blocks]
    .sort((a, b) => a.purchasedAtEpochMs - b.purchasedAtEpochMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((block) => ({
      quality: block.quality,
      remainingUnits: block.remainingUnits,
      purchasedAt: new Date(block.purchasedAtEpochMs),
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
  };
}

export class UnitsOverviewService {
  constructor(private readonly deps: UnitsOverviewDeps) {}

  /**
   * The organization's Units this period, for a holder of `unit.view`.
   *
   * The ledger's period containing now is shown as the ledger has it. Without
   * one, the subscription's current period is shown as it would open: the
   * plan's full allowance, no block. Billing facts need `billing.view` as well.
   *
   * @throws AppError FORBIDDEN for a non-member, or a member without `unit.view`.
   */
  async overview(actorUserId: string, organizationId: string): Promise<UnitsOverview> {
    const auth = await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "unit.view");
    const now = this.deps.identity.clock.now();
    const subscription = await this.deps.subscriptions.findByOrganization(organizationId);
    const billing = subscription !== null && auth.permissions.includes("billing.view") ? billingOf(subscription) : null;

    const period = await this.deps.ledger.findPeriodAt(organizationId, now);
    if (period !== null) {
      const balance = await this.deps.ledger.balance(organizationId, period.id);
      if (balance === null) {
        throw new AppError("INTERNAL_ERROR", "The current Unit period could not be read");
      }
      return fromLedger(period, balance, billing);
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
    };
  }
}
