import { AppError } from "@app/shared";
import { recordAudit } from "../identity/audit";
import { authorizeOrganization, type AuthContext } from "../identity/authorization";
import type { IdentityServiceDeps } from "../identity/ports";
import type { Permission } from "../identity/roles";
import type { GenerationQualityTier } from "../orchestration/types";
import { createCustomerPlanCatalog, type CustomerPlanKey } from "../pricing/customer-plan-catalog";
import type { Yen } from "../pricing/units";
import type { UnitEntitlementPeriod, UnitEntitlementRepository } from "./ports";
import {
  renewEntitlementPeriod,
  type OrganizationSubscription,
  type SubscriptionChannel,
  type SubscriptionRepository,
} from "./subscription";

/**
 * Buying an additional Unit package (UP-2, ADR-0067).
 *
 * A holder of `billing.manage` approves one package at the price and expiry the
 * confirmation step showed. The purchase, the quality-locked block it buys and
 * their audit entries are written in one transaction, re-checked there against
 * the period's lock: if the price, the period or the approver's permission
 * moved, nothing is bought. The Units are usable at once and the purchase is
 * invoiced afterwards under the contract (ADR-0066 Decision 4).
 *
 * Only invoice-paid organizations buy here: card payment through Stripe is not
 * built, and an Enterprise package goes through sales (ADR-0053 Decision 5A).
 */

export const UNIT_PURCHASE_AUDIT_ACTION = {
  Approved: "unit_purchase.approved",
  /** A member's refused purchase. A non-member is refused unaudited, as any organization access is. */
  Refused: "unit_purchase.refused",
} as const;

/** The longest idempotency key the purchase record stores. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/** One package a plan sells, at its approved price (ADR-0053 Decision 2). */
export interface AddOnPackageOffer {
  readonly quality: GenerationQualityTier;
  readonly units: number;
  readonly priceYenExTax: Yen;
}

/** The package `planKey` sells in `quality`, or `null` where it sells none: HQ on Standard. */
export function addOnPackageOffer(planKey: CustomerPlanKey, quality: GenerationQualityTier): AddOnPackageOffer | null {
  const plan = createCustomerPlanCatalog().find(planKey);
  if (plan === undefined) throw new Error(`No customer plan named ${planKey}`);
  if (quality === "NORMAL") {
    return { quality, units: plan.normalAddOnPackageUnits, priceYenExTax: plan.normalAddOnPackagePriceYenExTax };
  }
  if (plan.highQualityAddOnPackageUnits === null || plan.highQualityAddOnPackagePriceYenExTax === null) return null;
  return {
    quality,
    units: plan.highQualityAddOnPackageUnits,
    priceYenExTax: plan.highQualityAddOnPackagePriceYenExTax,
  };
}

export interface UnitPurchase {
  readonly id: string;
  readonly organizationId: string;
  readonly entitlementPeriodId: string;
  readonly addOnBlockId: string;
  readonly quality: GenerationQualityTier;
  /** Its block's quantity. */
  readonly units: number;
  readonly priceYenExTax: number;
  readonly channel: SubscriptionChannel;
  readonly contractReference: string;
  /** Its period's end, when its Units expire unused. */
  readonly expiresAt: Date;
  readonly idempotencyKey: string;
  readonly approvedByUserId: string;
  readonly approvedAt: Date;
}

/** What the confirmation step showed and the customer approved. */
export interface ApproveUnitPurchaseInput {
  readonly organizationId: string;
  readonly quality: GenerationQualityTier;
  readonly expected: {
    readonly units: number;
    readonly priceYenExTax: number;
    readonly periodEndsAt: Date;
  };
  /** Carried by the confirmation step, so a double submit or a replay buys once. */
  readonly idempotencyKey: string;
}

export type UnitPurchaseRefusal =
  /** The approver does not hold `billing.manage`, or no longer does. */
  | "LACKS_BILLING_MANAGE"
  | "NO_PLAN"
  /** The subscription's first period has not started. */
  | "NOT_STARTED"
  /** Enterprise: an in-app purchase must not change a contract amount (ADR-0053 Decision 5A). */
  | "THROUGH_SALES"
  /** Self-service pays by card, which is not built. */
  | "CARD_PAYMENT_NOT_AVAILABLE"
  /** The plan sells no package in this quality: HQ on Standard. */
  | "NOT_OFFERED"
  /** The package's Units or price are not what the confirmation step showed. */
  | "OFFER_CHANGED"
  /** The current period does not end when the confirmation step said. */
  | "PERIOD_CHANGED"
  /** The key belongs to a different purchase. */
  | "IDEMPOTENCY_KEY_REUSED";

/** What a purchase is checked against, before it is written and again inside its transaction. */
export interface UnitPurchaseFacts {
  readonly subscription: OrganizationSubscription | null;
  /** The period the block joins; `null` before it is opened. */
  readonly period: Pick<UnitEntitlementPeriod, "planKey" | "endsAt"> | null;
  /** The approver's effective permissions, or `null` once it is no longer a member. */
  readonly approverPermissions: readonly Permission[] | null;
}

/**
 * Why this purchase may not be written, or `null` when it may.
 *
 * Pure. The period's frozen plan prices the package once there is a period,
 * because the block joins that period and the ledger refuses an HQ block for a
 * period whose plan sells none.
 */
export function unitPurchaseRefusal(
  input: Pick<ApproveUnitPurchaseInput, "quality" | "expected">,
  facts: UnitPurchaseFacts,
  now: Date,
): UnitPurchaseRefusal | null {
  if (facts.approverPermissions === null || !facts.approverPermissions.includes("billing.manage")) {
    return "LACKS_BILLING_MANAGE";
  }
  const { subscription, period } = facts;
  if (subscription === null) return "NO_PLAN";
  if (now.getTime() < subscription.anchorAt.getTime()) return "NOT_STARTED";
  const planKey = period?.planKey ?? subscription.planKey;
  if (planKey === "enterprise") return "THROUGH_SALES";
  if (subscription.channel !== "SALES_ASSISTED") return "CARD_PAYMENT_NOT_AVAILABLE";
  const offer = addOnPackageOffer(planKey, input.quality);
  if (offer === null) return "NOT_OFFERED";
  if (offer.units !== input.expected.units || offer.priceYenExTax !== input.expected.priceYenExTax) {
    return "OFFER_CHANGED";
  }
  if (period !== null && period.endsAt.getTime() !== input.expected.periodEndsAt.getTime()) return "PERIOD_CHANGED";
  return null;
}

/** Whether `purchase` is this request replayed, by the same approver. */
export function isReplayOf(purchase: UnitPurchase, input: ApproveUnitPurchaseInput, approverUserId: string): boolean {
  return (
    purchase.approvedByUserId === approverUserId &&
    purchase.quality === input.quality &&
    purchase.units === input.expected.units &&
    purchase.priceYenExTax === input.expected.priceYenExTax &&
    purchase.expiresAt.getTime() === input.expected.periodEndsAt.getTime()
  );
}

/** The purchase and its block, as the service asks for them to be written. */
export interface UnitPurchaseRecord {
  readonly id: string;
  readonly addOnBlockId: string;
  readonly organizationId: string;
  readonly entitlementPeriodId: string;
  readonly quality: GenerationQualityTier;
  readonly units: number;
  readonly priceYenExTax: number;
  readonly channel: SubscriptionChannel;
  readonly contractReference: string;
  readonly idempotencyKey: string;
  readonly approvedByUserId: string;
  readonly approvedAt: Date;
}

export type ApproveUnitPurchaseRecordOutcome =
  | { readonly kind: "APPROVED"; readonly purchase: UnitPurchase }
  /** A purchase already holds this key. Nothing was written; the caller decides whether it is a replay. */
  | { readonly kind: "EXISTING"; readonly purchase: UnitPurchase }
  /** The check refused it under the lock. Nothing was written. */
  | { readonly kind: "REFUSED"; readonly reason: UnitPurchaseRefusal }
  | { readonly kind: "PERIOD_NOT_FOUND" };

export interface UnitPurchaseRepository {
  findByIdempotencyKey(organizationId: string, idempotencyKey: string): Promise<UnitPurchase | null>;
  /**
   * Write the purchase, its block and their audit entries in one transaction,
   * under the period's cost-admission lock, if `check` passes on the facts read
   * there: the period, the subscription and the approver's permissions.
   */
  approve(
    record: UnitPurchaseRecord,
    check: (facts: UnitPurchaseFacts) => UnitPurchaseRefusal | null,
  ): Promise<ApproveUnitPurchaseRecordOutcome>;
}

export type UnitPurchaseOutcome =
  | { readonly kind: "APPROVED"; readonly purchase: UnitPurchase }
  /** The same approval, replayed. Nothing was written. */
  | { readonly kind: "ALREADY_APPROVED"; readonly purchase: UnitPurchase }
  /** Nothing was bought; the customer reloads and sees why. */
  | { readonly kind: "REFUSED"; readonly reason: Exclude<UnitPurchaseRefusal, "LACKS_BILLING_MANAGE"> };

export interface UnitPurchaseDeps {
  /** Membership lookup for authorization, the clock, ids and the audit log. */
  readonly identity: IdentityServiceDeps;
  readonly subscriptions: Pick<SubscriptionRepository, "findByOrganization">;
  readonly ledger: Pick<UnitEntitlementRepository, "openPeriod">;
  readonly purchases: UnitPurchaseRepository;
}

export class UnitPurchaseService {
  constructor(private readonly deps: UnitPurchaseDeps) {}

  /**
   * Approve one package, for a holder of `billing.manage`.
   *
   * A replay of the same key returns the purchase it made. The current period
   * is opened if nothing has opened it yet, because the block must join it.
   *
   * @throws AppError VALIDATION_FAILED for an unusable request, FORBIDDEN for a
   *   non-member, or for a member without `billing.manage` (audited).
   */
  async approve(actorUserId: string, input: ApproveUnitPurchaseInput): Promise<UnitPurchaseOutcome> {
    if (
      input.idempotencyKey.length === 0 ||
      input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
      !Number.isSafeInteger(input.expected.units) ||
      !Number.isSafeInteger(input.expected.priceYenExTax) ||
      Number.isNaN(input.expected.periodEndsAt.getTime())
    ) {
      throw new AppError("VALIDATION_FAILED", "The purchase request is not usable");
    }
    const actor = await authorizeOrganization(this.deps.identity, actorUserId, input.organizationId);
    if (!actor.permissions.includes("billing.manage")) return this.refuse(actor, input, "LACKS_BILLING_MANAGE");

    const existing = await this.deps.purchases.findByIdempotencyKey(input.organizationId, input.idempotencyKey);
    if (existing !== null) return this.replay(actor, input, existing);

    const now = this.deps.identity.clock.now();
    const subscription = await this.deps.subscriptions.findByOrganization(input.organizationId);
    if (subscription === null) return this.refuse(actor, input, "NO_PLAN");
    const facts = { subscription, period: null, approverPermissions: actor.permissions };
    const early = unitPurchaseRefusal(input, facts, now);
    if (early !== null) return this.refuse(actor, input, early);

    // The subscription exists and has started, so anything but an open period
    // is the ledger disagreeing with it: surfaced, never bought around.
    const renewed = await renewEntitlementPeriod(this.deps, input.organizationId, now);
    if (renewed.kind !== "OPENED" && renewed.kind !== "ALREADY_OPEN") {
      throw new AppError("INTERNAL_ERROR", "The current Unit period could not be opened", {
        details: { organizationId: input.organizationId },
      });
    }

    const id = this.deps.identity.ids.generate("upur");
    const written = await this.deps.purchases.approve(
      {
        id,
        addOnBlockId: this.deps.identity.ids.generate("uab"),
        organizationId: input.organizationId,
        entitlementPeriodId: renewed.period.id,
        quality: input.quality,
        units: input.expected.units,
        priceYenExTax: input.expected.priceYenExTax,
        channel: subscription.channel,
        contractReference: subscription.commercialReference,
        idempotencyKey: input.idempotencyKey,
        approvedByUserId: actorUserId,
        approvedAt: now,
      },
      (facts) => unitPurchaseRefusal(input, facts, now),
    );
    switch (written.kind) {
      case "APPROVED":
        return { kind: "APPROVED", purchase: written.purchase };
      case "EXISTING":
        return this.replay(actor, input, written.purchase);
      case "REFUSED":
        return this.refuse(actor, input, written.reason);
      case "PERIOD_NOT_FOUND":
        throw new AppError("INTERNAL_ERROR", "The current Unit period could not be read", {
          details: { organizationId: input.organizationId },
        });
    }
  }

  private replay(actor: AuthContext, input: ApproveUnitPurchaseInput, purchase: UnitPurchase) {
    return isReplayOf(purchase, input, actor.userId)
      ? Promise.resolve<UnitPurchaseOutcome>({ kind: "ALREADY_APPROVED", purchase })
      : this.refuse(actor, input, "IDEMPOTENCY_KEY_REUSED");
  }

  private async refuse(
    actor: AuthContext,
    input: ApproveUnitPurchaseInput,
    reason: UnitPurchaseRefusal,
  ): Promise<UnitPurchaseOutcome> {
    await recordAudit(this.deps.identity, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: UNIT_PURCHASE_AUDIT_ACTION.Refused,
      resourceType: "organization",
      resourceId: actor.organizationId,
      metadata: {
        reason,
        actorRole: actor.role,
        quality: input.quality,
        expectedUnits: input.expected.units,
        expectedPriceYenExTax: input.expected.priceYenExTax,
        expectedPeriodEndsAt: input.expected.periodEndsAt.toISOString(),
      },
    });
    if (reason === "LACKS_BILLING_MANAGE") {
      throw new AppError("FORBIDDEN", `Role ${actor.role} may not buy Units here`);
    }
    return { kind: "REFUSED", reason };
  }
}
