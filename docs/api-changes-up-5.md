# API Changes — UP-5

Cancelling a mistaken Unit purchase (ADR-0070). **One migration (28), no new
route.**

## Schema

### Added: `unit_purchase_cancellations`

| Column | Shape |
| --- | --- |
| `purchaseId` | primary key; with `organizationId`, a foreign key to `unit_purchases` (`id`, `organizationId`), `ON DELETE RESTRICT` |
| `organizationId` | the purchase's organization |
| `fault` | `UnitPurchaseCancellationFault`: whose mistake the operator judged it, `VTAVISION` or `CUSTOMER` |
| `operatorName` | 1 to 200 characters, by CHECK |
| `reason` | 1 to 500 characters, by CHECK |
| `cancelledAt` | the database's clock when the cancelling transaction started |

### Added: enum `UnitPurchaseCancellationFault`

`VTAVISION` or `CUSTOMER`.

### Changed: `unit_purchases`

A unique index on (`id`, `organizationId`), for the composite key above. No
column or row changes.

## Pages

### Changed: `/organizations/{organizationId}/units`

- An add-on block whose purchase was cancelled reads "withdrawn, purchase
  cancelled" instead of what is left, and counts 0 towards what is left of its
  quality.
- For a holder of `billing.view`, a cancelled purchase's line adds "cancelled
  by VTaVision on" its date and "not invoiced", and the card says a cancelled
  purchase is not invoiced and its unused Units are withdrawn.

### Changed: `POST /api/organizations/{organizationId}/unit-purchases`

A confirmation sent again for a purchase cancelled since buys nothing, as any
replay does, and is sent back to `/organizations/{organizationId}/units/buy`
with the message that VTaVision cancelled the purchase, which is not invoiced,
instead of to the Units page with `purchased=1`.

## Operator commands (`apps/ops`)

### Added: `pnpm --filter @app/ops cancel-unit-purchase`

| Option | Shape |
| --- | --- |
| `--purchase` | the purchase id, up to 100 characters |
| `--fault` | `vtavision` or `customer`: whose mistake it was. The customer's is cancelled only within 10 hours of the approval with no Unit delivered or still generating |
| `--operator` | the operator's name, up to 200 characters |
| `--reason` | why, up to 500 characters |
| `--confirm` | a flag: without it, the purchase is only shown and nothing is written |

| Exit code | When |
| --- | --- |
| `0` | shown (without `--confirm`), cancelled, or already cancelled |
| `1` | refused: no such purchase, a card-paid one, or the customer's mistake past its 10 hours or with a Unit used; nothing was written |
| `2` | unusable arguments |

A cancellation is audited `unit_purchase.cancelled` on the purchase, with whose
mistake it was. A refusal writes nothing.

### Changed: `pnpm --filter @app/ops export-unit-purchases`

- Two columns at the end of the file: `cancelled_at` (Japan time, or empty)
  and `to_invoice_yen_ex_tax` (the price excluding tax, or 0 once cancelled).
- The command's total counts what is to be invoiced, and says how many
  cancelled purchases it left out.
- Each `unit_purchase.exported` audit entry adds `cancelled` and
  `toInvoiceYenExTax`.

## Internal API (`@app/domain`)

- `AddOnBlockGrant` and `AddOnBlockBalance` gain `withdrawn`;
  `periodEntitlementBalance` gives a withdrawn block 0 remaining, so
  `planUnitAllocation` never draws on it.
- `UnitPurchase` gains `cancelledAt`; `InvoiceableUnitPurchase` gains
  `cancelledAt`, and `yenToInvoiceExTax(purchase)` says what to invoice for it.
- `UnitsOverviewAddOnBlock` gains `withdrawn`; `UnitsOverviewPurchase` gains
  `cancelledAt`.
- New: `UnitPurchaseCancellationRepository` (`find`, `cancel`),
  `CancelUnitPurchaseOutcome` (`CANCELLED`, `ALREADY_CANCELLED`, `CARD_PAID`,
  `REFUND_WINDOW_PASSED`, `UNITS_USED`, `NOT_FOUND`), `CancelUnitPurchaseRequest`
  (with `fault`), `CancellableUnitPurchase` (with `readAt`, the database's
  clock as read), `CancelledUnitPurchase`, `UnitPurchaseCancellation` (with
  `fault`), `UnitPurchaseUsage` and `unitPurchaseUsage`,
  `UNIT_PURCHASE_CANCELLED_AUDIT_ACTION` (`unit_purchase.cancelled`) and
  `UNIT_PURCHASE_CANCELLATION_LIMITS`.
- New: `UnitPurchaseCancellationFault`, `CustomerMistakeRefusal`,
  `cancellationRefusal(fault, purchase)`, `CUSTOMER_MISTAKE_REFUND_WINDOW_MS`
  (10 hours) and `customerMistakeRefundDeadline(approvedAt)`.

## Internal API (`@app/database`)

- `createUnitPurchaseCancellationRepository(prisma)`: the cancellation and its
  audit entry in one transaction, under the period's cost-admission lock,
  refusing the customer's mistake on the usage and clock read there.
- `loadPeriodBalance` reads whether each block's purchase is cancelled.
- The purchase and invoicing repositories read each purchase's cancellation.

## Internal API (`apps/ops`)

- `parseCancelArguments`, `runCancelUnitPurchase`, `describePurchase`
  (`src/cancel-unit-purchase.ts`).
- `QUALITY_NAMES` is exported from `src/export-unit-purchases.ts`.
