# API Changes — UP-3

The Unit purchase screen, its confirmation step and its route (ADR-0068). The
first customer-facing route that changes what an organization is charged. **No
schema change and no migration.**

## Pages

### Added: `/organizations/{organizationId}/units/buy`

The purchase screen, for a holder of `billing.manage` (ADR-0068 Decisions 1
and 2). Anyone else is told they cannot buy Units for the organization.

| Query | Shows |
| --- | --- |
| none | what the plan sells: its packages and the date they expire, or why none can be bought here (including a period in the ledger the plan's renewal did not open) |
| `package=NORMAL` or `package=HIGH_QUALITY` | the confirmation step for that package, with one approval button (Decision 3); a package the plan does not sell is refused on the screen |
| `error=…` | the message a refused or failed purchase came back with |

### Changed: `/organizations/{organizationId}/units`

- A holder of `billing.manage` sees a "Buy additional Units" link on the
  Additional Units card.
- `?purchased=1`, where a purchase lands, says it is approved, its Units are
  ready and VTaVision will invoice it.

## Routes

### Added: `POST /api/organizations/{organizationId}/unit-purchases`

A form post (`application/x-www-form-urlencoded`) from the confirmation step
(ADR-0068 Decision 4).

| Field | Shape |
| --- | --- |
| `quality` | `NORMAL` or `HIGH_QUALITY` |
| `units` | whole Units, no leading zero |
| `priceYenExTax` | whole yen excluding tax, no leading zero |
| `periodEndsAt` | the period's end as the step wrote it (ISO 8601, UTC, milliseconds) |
| `idempotencyKey` | the step's key, 1 to 200 characters |

| Response | When |
| --- | --- |
| `403` JSON error, `FORBIDDEN` | the `Origin` header is missing or names another host; nothing is read |
| `303` → `/login` | not signed in |
| `303` → `/organizations/{id}/units?purchased=1` | approved, or the same approval replayed |
| `303` → `/organizations/{id}/units/buy?error=…` | the form is unusable, the purchase was refused, the user may not buy, or it could not be confirmed |
| `500` | anything other than an application error |

## Internal API (`@app/domain`)

- `UnitPurchaseService.offers(actorUserId, organizationId)`: what the purchase
  screen offers, decided with the check a purchase is written under; reads only.

  | Outcome | Meaning |
  | --- | --- |
  | `NO_PLAN` | no subscription |
  | `NOT_STARTED` | `startsAt`: the plan's anchor |
  | `THROUGH_SALES` | Enterprise: `packages`, bought through the representative |
  | `CARD_PAYMENT_NOT_AVAILABLE` | a self-service plan |
  | `PERIOD_CONFLICT` | the ledger holds a period now that the plan's renewal did not open; approving would buy none |
  | `AVAILABLE` | `packages`, `periodEndsAt` and `contractReference` |

  It throws `FORBIDDEN` for a non-member or a member without `billing.manage`,
  unaudited.
- `UnitPurchaseDeps.ledger` now also needs `findPeriodAt`.
- `isRenewalPeriod(period, subscription, bounds)`: whether a period is the one
  `renewEntitlementPeriod` opens for those bounds.
- `UnitsOverview` (`ACTIVE`) gains `mayBuyUnits`: whether the viewer holds
  `billing.manage`.
- The type `UnitPurchaseOffers`.

## Internal API (`apps/web`)

- `getUnitPurchaseService()` (`@/lib/unit-purchases`): the service over the
  database.
- `isSameOriginPost(request)` (`@/lib/same-origin`).
- `readUnitPurchaseForm`, `refusalMessage`, `failureMessage`, `NOT_USABLE`
  (`@/lib/unit-purchase-form`).
- `packageName(offer)` (`@/lib/units-view`).

## Audit entries

No new action. The route's approvals and refusals are written by
`UnitPurchaseService.approve` as in UP-2 (`unit_purchase.approved`,
`unit_purchase.refused`, `entitlement.add_on_block_granted`). Viewing the screen
is not audited.
