import type { CustomerPlanKey } from "../pricing/customer-plan-catalog";
import type { GenerationQualityTier } from "../orchestration/types";
import type { PeriodEntitlementBalance, UnitEntitlementSourceType } from "./allocation";

/**
 * One organization's Unit entitlement for one renewal period.
 *
 * Immutable once opened. The plan snapshot is frozen here, the period's bounds
 * decide which reservations it funds, and nothing it held carries into the next
 * period: a new period starts with its own Base Units and holds no block bought
 * for another.
 */
export interface UnitEntitlementPeriod {
  readonly id: string;
  readonly organizationId: string;
  /** The key the reservation and the cost-admission lock name. Unique per organization. */
  readonly billingCycleKey: string;
  readonly planKey: CustomerPlanKey;
  readonly baseUnits: number;
  readonly includedHighQualityUnits: number;
  readonly highQualityAddOnAvailable: boolean;
  /** Inclusive. */
  readonly startsAt: Date;
  /** Exclusive. */
  readonly endsAt: Date;
  /** The commercial record that opened it — a subscription period or a contract. Never required to be Stripe. */
  readonly commercialReference: string | null;
  readonly createdAt: Date;
}

/** One purchased block of additional Units, quality-locked for life. */
export interface UnitAddOnBlock {
  readonly id: string;
  readonly organizationId: string;
  readonly entitlementPeriodId: string;
  readonly quality: GenerationQualityTier;
  readonly quantity: number;
  /** The purchase or order identity. Unique per organization, so a replayed grant cannot double-credit. */
  readonly commercialReference: string;
  /** The FIFO key. */
  readonly purchasedAt: Date;
  readonly createdAt: Date;
}

/** One frozen allocation of a reservation. Never updated, never reselected. */
export interface GenerationReservationAllocation {
  readonly id: string;
  readonly reservationId: string;
  readonly organizationId: string;
  readonly entitlementPeriodId: string;
  /** 1-based, in the order the eligibility-first plan drew it. */
  readonly ordinal: number;
  readonly sourceType: UnitEntitlementSourceType;
  readonly addOnBlockId: string | null;
  readonly quality: GenerationQualityTier;
  readonly quantity: number;
  readonly createdAt: Date;
}

export interface OpenEntitlementPeriodInput {
  readonly id: string;
  readonly organizationId: string;
  readonly planKey: CustomerPlanKey;
  readonly billingCycleKey: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly commercialReference: string | null;
  /** The person who caused it, when one did. A renewal has none. */
  readonly actorUserId: string | null;
}

export type OpenEntitlementPeriodOutcome =
  | { readonly kind: "OPENED"; readonly period: UnitEntitlementPeriod }
  /** The same period, replayed with identical facts. Nothing was written. */
  | { readonly kind: "ALREADY_OPEN"; readonly period: UnitEntitlementPeriod }
  /** The billing-cycle key is taken by a period with different facts. */
  | { readonly kind: "CONFLICT" }
  /** It would overlap another period of the same organization. */
  | { readonly kind: "OVERLAPS_EXISTING_PERIOD" }
  | { readonly kind: "INVALID_PERIOD" };

export interface GrantAddOnBlockInput {
  readonly id: string;
  readonly organizationId: string;
  readonly entitlementPeriodId: string;
  readonly quality: GenerationQualityTier;
  readonly quantity: number;
  readonly commercialReference: string;
  readonly purchasedAt: Date;
  /** The `billing.manage` holder who approved the purchase, when known. */
  readonly actorUserId: string | null;
}

export type GrantAddOnBlockOutcome =
  | { readonly kind: "GRANTED"; readonly block: UnitAddOnBlock }
  /** The same purchase, replayed with identical facts. Nothing was written. */
  | { readonly kind: "ALREADY_GRANTED"; readonly block: UnitAddOnBlock }
  /** The commercial reference is taken by a block with different facts. */
  | { readonly kind: "CONFLICT" }
  | { readonly kind: "PERIOD_NOT_FOUND" }
  /** An HQ block on a plan that sells none — Standard. */
  | { readonly kind: "HIGH_QUALITY_ADD_ON_NOT_AVAILABLE" }
  | { readonly kind: "INVALID_BLOCK" };

/**
 * The Unit entitlement ledger's write and read surface.
 *
 * Opening a period and granting a block are the inputs a later billing layer
 * supplies; nothing here takes a payment, calls Stripe or decides a price.
 * Reservations draw on the ledger through `GenerationReservationRepository.reserve`
 * — they are not created here.
 */
export interface UnitEntitlementRepository {
  openPeriod(input: OpenEntitlementPeriodInput): Promise<OpenEntitlementPeriodOutcome>;
  grantAddOnBlock(input: GrantAddOnBlockInput): Promise<GrantAddOnBlockOutcome>;
  findPeriodAt(organizationId: string, at: Date): Promise<UnitEntitlementPeriod | null>;
  /** What remains of a period, or `null` when it is not this organization's. */
  balance(organizationId: string, entitlementPeriodId: string): Promise<PeriodEntitlementBalance | null>;
  /** A reservation's frozen allocations, in ordinal order; empty when it is not this organization's. */
  allocationsForReservation(
    organizationId: string,
    reservationId: string,
  ): Promise<readonly GenerationReservationAllocation[]>;
}
