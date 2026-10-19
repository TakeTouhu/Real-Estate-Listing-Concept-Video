import type { GenerationQualityTier, GenerationReservationState } from "../orchestration/types";
import { allocationSettlement } from "./allocation";

/**
 * Cancelling a mistaken Unit purchase (UP-5, ADR-0070).
 *
 * The product owner's rule: a purchase made by mistake, by the customer or by
 * VTaVision, is cancelled by an operator who judges each case. Its unused Units
 * are withdrawn, Units already used stay used, and the purchase is not
 * invoiced, used Units included. A cancellation covers the whole purchase, once,
 * and cannot be undone.
 *
 * Withdrawing is the ledger's rule, not a write to the block: a block whose
 * purchase is cancelled funds no new reservation (`allocation.ts`). Generations
 * it already funded settle as they would have, and Units a failed one releases
 * are not returned. The cancellation is written under the period's
 * cost-admission lock, so each reservation is ordered against it: one admitted
 * before it is counted as in flight, and one admitted after it is refused the
 * block.
 */

export const UNIT_PURCHASE_CANCELLED_AUDIT_ACTION = "unit_purchase.cancelled";

/** The longest operator name and reason a cancellation stores, by CHECK in migration 28. */
export const UNIT_PURCHASE_CANCELLATION_LIMITS = { operator: 200, reason: 500 } as const;

/** How a purchase's Units stand, from the allocations its block funded. */
export interface UnitPurchaseUsage {
  /** Spent on delivered videos. Kept, and not invoiced once cancelled. */
  readonly consumed: number;
  /** Held by generations still running. They settle as they would have. */
  readonly inFlight: number;
  /** Neither: what a cancellation withdraws. */
  readonly unused: number;
}

/**
 * The usage of a block of `quantity` Units, from its allocations' reservations.
 *
 * A released allocation used nothing. Once the block is withdrawn, what was
 * released after the cancellation is counted as unused, which is what it is:
 * withdrawn.
 */
export function unitPurchaseUsage(
  quantity: number,
  allocations: readonly { readonly quantity: number; readonly reservationState: GenerationReservationState }[],
): UnitPurchaseUsage {
  let consumed = 0;
  let inFlight = 0;
  for (const allocation of allocations) {
    const settlement = allocationSettlement(allocation.reservationState);
    if (settlement === "CONSUMED") consumed += allocation.quantity;
    else if (settlement === "HELD") inFlight += allocation.quantity;
  }
  return { consumed, inFlight, unused: quantity - consumed - inFlight };
}

export interface UnitPurchaseCancellation {
  readonly operatorName: string;
  readonly reason: string;
  /** The database's clock when the cancelling transaction started. */
  readonly cancelledAt: Date;
}

/** A purchase as an operator cancelling it needs to see it. */
export interface CancellableUnitPurchase {
  readonly purchaseId: string;
  readonly organizationId: string;
  /** The organization's name now, as its members set it. Untrusted text. */
  readonly organizationName: string;
  readonly quality: GenerationQualityTier;
  readonly units: number;
  /** The price it was approved at, excluding tax. */
  readonly priceYenExTax: number;
  /** Whether it is invoiced (`SALES_ASSISTED`) or charged by a payment processor. */
  readonly invoicePaid: boolean;
  readonly contractReference: string;
  readonly approvedAt: Date;
  /** Its period's end, when its unused Units expire anyway. */
  readonly expiresAt: Date;
  /** As the read found it: for a cancellation, as it was cancelled. */
  readonly usage: UnitPurchaseUsage;
  readonly cancellation: UnitPurchaseCancellation | null;
}

/** A cancelled purchase. */
export type CancelledUnitPurchase = CancellableUnitPurchase & { readonly cancellation: UnitPurchaseCancellation };

export interface CancelUnitPurchaseRequest {
  readonly purchaseId: string;
  readonly operator: { readonly name: string; readonly reason: string };
}

export type CancelUnitPurchaseOutcome =
  /** Cancelled now, with its usage at that moment. */
  | { readonly kind: "CANCELLED"; readonly purchase: CancelledUnitPurchase }
  /** It was cancelled before. Nothing was written. */
  | { readonly kind: "ALREADY_CANCELLED"; readonly purchase: CancelledUnitPurchase }
  /**
   * Its payment processor charged it, so not invoicing it would refund nothing.
   * None exists while card payment is not built. Nothing was written.
   */
  | { readonly kind: "CARD_PAID"; readonly purchase: CancellableUnitPurchase }
  | { readonly kind: "NOT_FOUND" };

export interface UnitPurchaseCancellationRepository {
  /** The purchase as a cancellation would find it now, or `null`. Reads only. */
  find(purchaseId: string): Promise<CancellableUnitPurchase | null>;
  /**
   * Cancel the purchase and audit it in one transaction, under its period's
   * cost-admission lock, reading its usage there.
   */
  cancel(request: CancelUnitPurchaseRequest): Promise<CancelUnitPurchaseOutcome>;
}
