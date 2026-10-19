# API Changes — UP-2

The Unit purchase record and its one-transaction approval (ADR-0067). **No HTTP
route, page or command is added or changed.** Nothing in any application calls
what is added here; the purchase screen and route are UP-3.

## Schema

### Added: `unit_purchases` (migration 27)

One row per approved purchase of an additional Unit package. See ADR-0067
Decision 2 and `docs/migration-notes.md`.

## Internal API (`@app/domain`)

- **Catalog.** `CustomerPlan.normalAddOnPackagePriceYenExTax` and
  `CustomerPlan.highQualityAddOnPackagePriceYenExTax` (`null` where the plan
  sells none): the approved package prices of ADR-0053 Decision 2.
- `addOnPackageOffer(planKey, quality)`: the package a plan sells in a quality,
  with its Units and price, or `null` (HQ on Standard).
- `UnitPurchaseService.approve(actorUserId, input)`:

  | Input | Meaning |
  | --- | --- |
  | `organizationId` | the organization buying |
  | `quality` | `NORMAL` or `HIGH_QUALITY` |
  | `expected.units`, `expected.priceYenExTax`, `expected.periodEndsAt` | what the confirmation step showed |
  | `idempotencyKey` | carried by the confirmation step; 1 to 200 characters |

  | Outcome | Meaning |
  | --- | --- |
  | `APPROVED` | bought: the purchase, its block and their audit entries were written |
  | `ALREADY_APPROVED` | the same approval replayed; nothing was written |
  | `REFUSED` | nothing bought, audited; `reason` is `NO_PLAN`, `NOT_STARTED`, `THROUGH_SALES`, `CARD_PAYMENT_NOT_AVAILABLE`, `NOT_OFFERED`, `OFFER_CHANGED`, `PERIOD_CHANGED` or `IDEMPOTENCY_KEY_REUSED` |

  It throws `VALIDATION_FAILED` for an unusable request, `FORBIDDEN` for a
  non-member (unaudited) or a member without `billing.manage` (audited), and
  `INTERNAL_ERROR` when the ledger cannot open or find the current period.
- `unitPurchaseRefusal`, `isReplayOf`, `UNIT_PURCHASE_AUDIT_ACTION`
  (`unit_purchase.approved`, `unit_purchase.refused`), `MAX_IDEMPOTENCY_KEY_LENGTH`,
  and the types `UnitPurchase`, `UnitPurchaseRecord`, `UnitPurchaseFacts`,
  `UnitPurchaseRefusal`, `UnitPurchaseRepository`.
- `InMemoryUnitPurchases` in `@app/domain/testing`.

## Internal API (`@app/database`)

- `createUnitPurchaseRepository(prisma)`: `findByIdempotencyKey` and the
  one-transaction `approve`.

## Audit entries

| Action | Written | Metadata |
| --- | --- | --- |
| `unit_purchase.approved` | with the purchase, in its transaction | `approverRole`, `entitlementPeriodId`, `addOnBlockId`, `quality`, `units`, `priceYenExTax`, `channel`, `contractReference`, `expiresAt` |
| `entitlement.add_on_block_granted` | with the purchase's block, as for any grant | unchanged since Phase 6A |
| `unit_purchase.refused` | for a member's refused purchase | `reason`, `actorRole`, `quality`, `expectedUnits`, `expectedPriceYenExTax`, `expectedPeriodEndsAt` |
