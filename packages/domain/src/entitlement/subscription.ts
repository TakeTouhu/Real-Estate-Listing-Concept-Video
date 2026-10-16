import type { CustomerPlanKey } from "../pricing/customer-plan-catalog";
import type { UnitEntitlementPeriod, UnitEntitlementRepository } from "./ports";

/**
 * The organization's commercial subscription and its monthly renewal (Phase 6B,
 * ADR-0056).
 *
 * A subscription says which plan an organization is on, through which channel it
 * was sold, and the instant its renewal periods are counted from. It opens no
 * period by itself: `renewEntitlementPeriod` opens the period containing a given
 * instant, on demand, so renewal needs no scheduler.
 */

/**
 * How the subscription was sold. Self-service is Standard and Premium through
 * Stripe; sales-assisted is invoice and bank transfer, and is representable with
 * no Stripe object at all (ADR-0053 Decision 5).
 */
export type SubscriptionChannel = "SELF_SERVICE" | "SALES_ASSISTED";

export interface OrganizationSubscription {
  readonly id: string;
  readonly organizationId: string;
  readonly planKey: CustomerPlanKey;
  readonly channel: SubscriptionChannel;
  /** The start of renewal period 0. Every later period is counted from it. */
  readonly anchorAt: Date;
  /** The commercial record it came from: a Stripe subscription or a contract number. */
  readonly commercialReference: string;
  readonly createdAt: Date;
}

/**
 * A VTaVision operator acting outside the web app, named and with a reason
 * (ADR-0054 Decision 6, ADR-0066). An operator is not a user of any
 * organization, so it is recorded in the audit entry, never as its actor.
 */
export interface OperatorAttribution {
  readonly name: string;
  readonly reason: string;
}

export interface ProvisionSubscriptionInput {
  readonly id: string;
  readonly organizationId: string;
  readonly planKey: CustomerPlanKey;
  readonly channel: SubscriptionChannel;
  readonly anchorAt: Date;
  readonly commercialReference: string;
  /** The operator or billing integration that provisioned it, when a person did. */
  readonly actorUserId: string | null;
  /** The operator who provisioned it by hand, when one did. Audited, not compared on replay. */
  readonly operator?: OperatorAttribution | null;
}

export type ProvisionSubscriptionOutcome =
  | { readonly kind: "PROVISIONED"; readonly subscription: OrganizationSubscription }
  /** The same subscription, replayed with identical facts. Nothing was written. */
  | { readonly kind: "ALREADY_PROVISIONED"; readonly subscription: OrganizationSubscription }
  /** The organization already has a subscription with different facts. */
  | { readonly kind: "CONFLICT" }
  | { readonly kind: "ORGANIZATION_NOT_FOUND" }
  /** Enterprise is sales-assisted only (ADR-0053 Decisions 1A and 3B). */
  | { readonly kind: "CHANNEL_NOT_OFFERED" }
  | { readonly kind: "INVALID_SUBSCRIPTION" };

export interface SubscriptionRepository {
  provision(input: ProvisionSubscriptionInput): Promise<ProvisionSubscriptionOutcome>;
  findByOrganization(organizationId: string): Promise<OrganizationSubscription | null>;
}

/**
 * Whether a provisioning request may be written, before any database work.
 *
 * Every subscription names the commercial record it came from: an entitlement
 * with no commercial record behind it is an allowance nobody sold.
 */
export function provisionRefusal(
  input: ProvisionSubscriptionInput,
): "CHANNEL_NOT_OFFERED" | "INVALID_SUBSCRIPTION" | null {
  if (
    input.id.length === 0 ||
    input.organizationId.length === 0 ||
    input.commercialReference.length === 0 ||
    !isValidInstant(input.anchorAt) ||
    (input.operator != null && (input.operator.name.trim() === "" || input.operator.reason.trim() === ""))
  ) {
    return "INVALID_SUBSCRIPTION";
  }
  if (input.planKey === "enterprise" && input.channel === "SELF_SERVICE") return "CHANNEL_NOT_OFFERED";
  return null;
}

// --- Provisioning from a sales contract ------------------------------------

/**
 * The one subscription an organization can have, named after it, so running
 * the operator command again with the same contract is a replay rather than a
 * second subscription (ADR-0066 Decision 1).
 */
export function salesContractSubscriptionId(organizationId: string): string {
  return `sub_${organizationId}`;
}

export interface SalesContractProvisioning {
  readonly organizationId: string;
  readonly planKey: CustomerPlanKey;
  /** The contract's start: the start of renewal period 0. */
  readonly startsAt: Date;
  /** The executed contract's number. */
  readonly contractReference: string;
  readonly operator: OperatorAttribution;
}

/**
 * Give an organization the plan its sales contract names (ADR-0066 Decision 1).
 *
 * Always `SALES_ASSISTED`: a self-service subscription comes from its payment
 * processor, never from an operator. No organization user is its actor; the
 * operator and the reason are written to the audit entry instead.
 */
export function provisionFromSalesContract(
  subscriptions: Pick<SubscriptionRepository, "provision">,
  input: SalesContractProvisioning,
): Promise<ProvisionSubscriptionOutcome> {
  return subscriptions.provision({
    id: salesContractSubscriptionId(input.organizationId),
    organizationId: input.organizationId,
    planKey: input.planKey,
    channel: "SALES_ASSISTED",
    anchorAt: input.startsAt,
    commercialReference: input.contractReference,
    actorUserId: null,
    operator: input.operator,
  });
}

// --- Monthly periods -------------------------------------------------------

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * The anchor moved `months` calendar months forward in UTC, with the day clamped
 * to the target month's last day and the time of day kept.
 *
 * Always computed **from the anchor**, never from the previous period's end, so
 * clamping never drifts: an anchor on the 31st gives Feb 28 (or 29) and then
 * Mar 31 again, not Mar 28. This is the convention a Stripe monthly subscription
 * with the same billing anchor uses, so a later billing integration can agree
 * with these bounds exactly.
 */
export function addUtcMonthsClamped(anchor: Date, months: number): Date {
  const totalMonths = anchor.getUTCMonth() + months;
  const year = anchor.getUTCFullYear() + Math.floor(totalMonths / 12);
  const month = ((totalMonths % 12) + 12) % 12;
  const day = Math.min(anchor.getUTCDate(), daysInUtcMonth(year, month));
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

export interface RenewalPeriodBounds {
  readonly index: number;
  /** Inclusive. */
  readonly startsAt: Date;
  /** Exclusive, and exactly the next period's start. */
  readonly endsAt: Date;
}

export function renewalPeriodBounds(anchorAt: Date, index: number): RenewalPeriodBounds {
  return {
    index,
    startsAt: addUtcMonthsClamped(anchorAt, index),
    endsAt: addUtcMonthsClamped(anchorAt, index + 1),
  };
}

/** The renewal period containing `at`, or `null` before the anchor. */
export function renewalPeriodAt(anchorAt: Date, at: Date): RenewalPeriodBounds | null {
  if (at.getTime() < anchorAt.getTime()) return null;
  const monthsApart =
    (at.getUTCFullYear() - anchorAt.getUTCFullYear()) * 12 + (at.getUTCMonth() - anchorAt.getUTCMonth());
  // The period starting in `at`'s own month either has started or has not; if
  // not, `at` sits in the one before it, which started in the previous month.
  const candidate = renewalPeriodBounds(anchorAt, monthsApart);
  return candidate.startsAt.getTime() <= at.getTime() ? candidate : renewalPeriodBounds(anchorAt, monthsApart - 1);
}

/** Deterministic, so every concurrent or replayed renewal of one period names the same row. */
export function renewalPeriodIdentity(
  subscription: Pick<OrganizationSubscription, "id">,
  period: RenewalPeriodBounds,
): { readonly id: string; readonly billingCycleKey: string; readonly commercialReference: string } {
  return {
    id: `uep_${subscription.id}_${period.index}`,
    billingCycleKey: period.startsAt.toISOString(),
    commercialReference: `subscription:${subscription.id}:${period.index}`,
  };
}

// --- Renewal ---------------------------------------------------------------

export type RenewEntitlementPeriodOutcome =
  | { readonly kind: "OPENED"; readonly period: UnitEntitlementPeriod }
  /** Another call opened it first, or this is a replay. Nothing was written. */
  | { readonly kind: "ALREADY_OPEN"; readonly period: UnitEntitlementPeriod }
  | { readonly kind: "NO_SUBSCRIPTION" }
  /** `at` is before the subscription's anchor. */
  | { readonly kind: "NOT_STARTED" }
  /**
   * The derived period collides with one this subscription did not open — a
   * period opened by hand, overlapping it. Surfaced, never resolved by choosing.
   */
  | { readonly kind: "PERIOD_CONFLICT" };

export interface RenewalDependencies {
  readonly subscriptions: Pick<SubscriptionRepository, "findByOrganization">;
  readonly ledger: Pick<UnitEntitlementRepository, "openPeriod">;
}

/**
 * Ensure the organization's renewal period containing `at` is open.
 *
 * Idempotent and safe under concurrency: every caller derives the same id, key,
 * bounds and plan for one period, so the ledger answers all but one of them
 * `ALREADY_OPEN`. It opens only the period containing `at` — a month in which
 * nothing asked for a period is never opened afterwards, because unused Units do
 * not carry over and nothing could have reserved against it.
 *
 * The plan snapshot is the subscription's plan at the moment the period opens,
 * and the ledger freezes it there.
 */
export async function renewEntitlementPeriod(
  dependencies: RenewalDependencies,
  organizationId: string,
  at: Date,
): Promise<RenewEntitlementPeriodOutcome> {
  if (!isValidInstant(at)) throw new Error("renewEntitlementPeriod needs a valid instant");
  const subscription = await dependencies.subscriptions.findByOrganization(organizationId);
  if (subscription === null) return { kind: "NO_SUBSCRIPTION" };
  const bounds = renewalPeriodAt(subscription.anchorAt, at);
  if (bounds === null) return { kind: "NOT_STARTED" };

  const identity = renewalPeriodIdentity(subscription, bounds);
  const opened = await dependencies.ledger.openPeriod({
    id: identity.id,
    organizationId: subscription.organizationId,
    planKey: subscription.planKey,
    billingCycleKey: identity.billingCycleKey,
    startsAt: bounds.startsAt,
    endsAt: bounds.endsAt,
    commercialReference: identity.commercialReference,
    actorUserId: null,
  });
  switch (opened.kind) {
    case "OPENED":
    case "ALREADY_OPEN":
      return opened;
    case "CONFLICT":
    case "OVERLAPS_EXISTING_PERIOD":
      return { kind: "PERIOD_CONFLICT" };
    case "INVALID_PERIOD":
      throw new Error("A derived renewal period was refused as invalid");
  }
}

function isValidInstant(value: Date): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}
