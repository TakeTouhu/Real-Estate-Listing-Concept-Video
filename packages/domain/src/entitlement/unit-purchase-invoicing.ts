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
}

export interface UnitPurchaseExportRequest {
  /** Inclusive. */
  readonly from: Date;
  /** Exclusive, so consecutive windows neither overlap nor leave a gap. */
  readonly to: Date;
  readonly operator: { readonly name: string; readonly reason: string };
}

export interface UnitPurchaseInvoicingRepository {
  /**
   * The invoice-paid purchases approved in `[from, to)`, by organization, then
   * contract, then approval, and one audit entry per organization listed, in
   * one transaction. A card-paid purchase is never listed: its payment
   * processor charges it, and invoicing it too would bill it twice.
   */
  exportForInvoicing(request: UnitPurchaseExportRequest): Promise<readonly InvoiceableUnitPurchase[]>;
}
