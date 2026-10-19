# API Changes — UP-4

This period's purchases on the Units page, and the operator export for
invoicing (ADR-0069). **No schema change, no migration, no new route.**

## Pages

### Changed: `/organizations/{organizationId}/units`

A holder of `billing.view` sees a "Purchases this period" card (ADR-0069
Decision 1). Each line gives the package, its price excluding tax, when it was
approved in Japan time, and who approved it while they are still a member ("a
former member" once they have left). With purchases, the card says VTaVision
invoices each one under the contract, with consumption tax added; without, it
says there were none. Anyone else sees no card.

## Operator command (`apps/ops`)

### Added: `pnpm --filter @app/ops export-unit-purchases`

| Option | Shape |
| --- | --- |
| `--from` | the first instant, included; ISO 8601 with an explicit offset |
| `--to` | the end instant, excluded; after `--from` and at least ten minutes ago by the database's clock |
| `--out` | a file that does not exist yet |
| `--operator` | the operator's name, up to 200 characters |
| `--reason` | why, up to 500 characters |

| Exit code | When |
| --- | --- |
| `0` | the file was written, with a row per invoice-paid purchase approved in the window (or none) |
| `1` | refused: `--out` exists, or the window ended less than ten minutes ago (the command says from when it can run); nothing was read or audited |
| `2` | unusable arguments |

The file: UTF-8 with a byte order mark, RFC 4180 with CRLF line ends, columns
`organization_id`, `organization_name`, `contract_reference`, `purchase_id`,
`approved_at`, `quality`, `units`, `price_yen_ex_tax`, `expires_at` (ADR-0069
Decisions 3 and 4). Each organization listed is audited `unit_purchase.exported`.
The read waits for any purchase still being recorded (ADR-0069 Decision 6).

## Internal API (`@app/domain`)

- `UnitPurchaseRepository.listForPeriod(organizationId, entitlementPeriodId)`:
  a period's purchases, oldest approval first.
- `UnitsOverview` (`ACTIVE`) gains `purchases`: the period's purchases
  (`UnitsOverviewPurchase`: quality, units, price, approval time, approver's name
  or `null`) for a holder of `billing.view`, else `null`.
- `UnitsOverviewDeps` gains `purchases` (`listForPeriod`).
- `UnitPurchaseInvoicingRepository.exportForInvoicing(request)`, returning
  `UnitPurchaseExportOutcome` (`EXPORTED` with the purchases, or `NOT_SETTLED`
  with when the window can be exported), with the types
  `InvoiceableUnitPurchase` and `UnitPurchaseExportRequest`,
  `UNIT_PURCHASE_EXPORT_AUDIT_ACTION` (`unit_purchase.exported`) and
  `UNIT_PURCHASE_EXPORT_SETTLE_MS` (ten minutes).

## Internal API (`@app/database`)

- `createUnitPurchaseInvoicingRepository(prisma)`: the export's read and its
  audit entries in one transaction, after the database's clock says the window
  has settled and under a `SHARE` lock on `unit_purchases`.
- `createUnitPurchaseRepository(prisma)` implements `listForPeriod`.

## Internal API (`apps/ops`)

- `parseExportArguments`, `runExportUnitPurchases`, `unitPurchasesCsv`,
  `textCell`, `jstInstant` (`src/export-unit-purchases.ts`).
- `parseInstant` moved from `src/provision-subscription.ts` to `src/instant.ts`,
  unchanged.
