import type { GenerationQualityTier } from "../orchestration/types";

/**
 * Listing invoice-paid Unit purchases for invoicing (UP-4, ADR-0069).
 *
 * An operator lists the purchases approved in a window, per organization and
 * contract, so VTaVision can invoice them: consumption tax is added on the
 * invoice. Reading them across organizations is an operator's privilege, so
 * every organization listed gets an audit entry naming the operator and why,
 * written in the same transaction as the read.
 */

export const UNIT_PURCHASE_EXPORT_AUDIT_ACTION = "unit_purchase.exported";

/**
 * How long after its end, by the database's clock, a window can be exported
 * (ADR-0069 Decision 6). An approval fixes its time when its request starts and
 * records the purchase later in that request, so one approved just before
 * `--to` may still be committing. Each transaction an approval runs waits at
 * most 2 seconds for a connection and is closed after 5, so ten minutes leaves
 * none still to come.
 */
export const UNIT_PURCHASE_EXPORT_SETTLE_MS = 10 * 60 * 1000;

/** One invoice-paid purchase, as an invoice needs it. */
export interface InvoiceableUnitPurchase {
  readonly purchaseId: string;
  readonly organizationId: string;
  /** The organization's name now, as its members set it. Untrusted text. */
  readonly organizationName: string;
  /** The contract it is invoiced under, as the subscription said when it was approved. */
  readonly contractReference: string;
  readonly quality: GenerationQualityTier;
  readonly units: number;
  /** The price it was approved at, excluding tax. */
  readonly priceYenExTax: number;
  readonly approvedAt: Date;
  /** Its period's end, when its Units expire unused. */
  readonly expiresAt: Date;
  /**
   * When an operator cancelled it (UP-5, ADR-0070), or `null`. A cancelled
   * purchase is listed so a past export can be reconciled, and is not invoiced.
   */
  readonly cancelledAt: Date | null;
}

/** What to invoice for `purchase`, excluding tax: nothing once it is cancelled. */
export function yenToInvoiceExTax(purchase: Pick<InvoiceableUnitPurchase, "priceYenExTax" | "cancelledAt">): number {
  return purchase.cancelledAt === null ? purchase.priceYenExTax : 0;
}

export interface UnitPurchaseExportRequest {
  /** Inclusive. */
  readonly from: Date;
  /** Exclusive, so consecutive windows neither overlap nor leave a gap. */
  readonly to: Date;
  readonly operator: { readonly name: string; readonly reason: string };
}

export type UnitPurchaseExportOutcome =
  | { readonly kind: "EXPORTED"; readonly purchases: readonly InvoiceableUnitPurchase[] }
  /** The window ended less than the settle time ago. Nothing was read or audited. */
  | { readonly kind: "NOT_SETTLED"; readonly settlesAt: Date };

export interface UnitPurchaseInvoicingRepository {
  /**
   * The invoice-paid purchases approved in `[from, to)`, by organization, then
   * contract, then approval, and one audit entry per organization listed, in
   * one transaction. A card-paid purchase is never listed: its payment
   * processor charges it, and invoicing it too would bill it twice. A window
   * that has not settled is refused.
   */
  exportForInvoicing(request: UnitPurchaseExportRequest): Promise<UnitPurchaseExportOutcome>;
}
