# ADR-0067 — The Unit purchase record, and approving a purchase in one transaction

Status: Accepted (UP-2, the second of four Unit purchase pull requests).
Implements: ADR-0053 Decisions 1, 2, 3, 5 and 5A (the purchase of an additional
Unit package by an invoice-paid organization), and ADR-0066 Decision 4 (the
product owner's purchase-timing decision and its defaults).
Builds on: ADR-0055 (the Unit ledger and its cost-admission lock), ADR-0056
(the subscription and on-demand renewal), ADR-0058 / ADR-0061 (effective
permissions) and ADR-0066 (plan provisioning).

## Context

After UP-1 an organization can have a plan and see its Units, but nothing
buys a package. The ledger can grant a quality-locked block (Phase 6A,
`grantAddOnBlock`), but a grant is not a purchase: it records no price, no
approver and no contract, and it commits apart from anything that would.

The contract asks for four things a grant alone does not give
(ADR-0053 Decision 2, the approved proposal):

1. **Customer approval** by a `billing.manage` holder, audited.
2. **The approved price**, recorded on the purchase, excluding tax.
3. **Nothing bought twice** by a double click or a replay.
4. **Nothing bought on stale facts**: if the price, the period or the approver's
   permission moved since the confirmation step, nothing is bought.

---

## Decision 1 — The approved prices are the catalog's price authority

`CustomerPlan` gains `normalAddOnPackagePriceYenExTax` and
`highQualityAddOnPackagePriceYenExTax` (`null` where the plan sells none), the
ADR-0053 Decision 2 table exactly:

| Plan | Normal package | HQ package |
| --- | --- | --- |
| Standard | +5 Units, ¥19,900 | none |
| Premium | +10 Units, ¥35,900 | +2 Units, ¥9,000 |
| Enterprise | +25 Units, ¥89,400 | +5 Units, ¥22,400 |

A purchase is charged the catalog's price and records it. A test pins every
price to the package price formula (`addOnPackagePrice`, the ×1.20 / ×1.50 rule
rounded once to the nearest ¥100), so the two cannot drift. The formula's
profitability floor depends on a provider cost, and no provider route is
verified or activated (ADR-0054 Decision 7). The approved table is what the
product owner approved, so the price authority is the table, not a floor
computed at run time.

## Decision 2 — The purchase record (migration 27)

`unit_purchases` holds one row per approved purchase:

| Column | Meaning |
| --- | --- |
| `entitlementPeriodId` | the period its Units belong to and expire with |
| `addOnBlockId` | the block it bought; **unique**, so one block is bought once |
| `quality` | Normal or HQ |
| `priceYenExTax` | the price it was approved at, excluding tax; `> 0` |
| `channel` | how it is paid, as the subscription said when it was approved |
| `contractReference` | the contract it is invoiced under, as the subscription said |
| `idempotencyKey` | carried by the confirmation step; unique per organization, 1 to 200 characters |
| `approvedByUserId` | the `billing.manage` holder who approved it |
| `approvedAt` | when; also the block's FIFO instant |

- **The block's Units are not repeated.** A composite foreign key
  `(addOnBlockId, entitlementPeriodId, quality)` ties the purchase to a block of
  its own period and its own quality, and the period's composite key
  `(entitlementPeriodId, organizationId)` keeps both in the purchase's
  organization. The block holds the quantity.
- **Evidence outlives casual deletion.** The organization, the period and the
  block are `RESTRICT`. `approvedByUserId` is not a foreign key, as no actor
  column is: billing evidence outlives the user.
- Additive only: no existing table, column or row changes.

## Decision 3 — Approving a purchase

`UnitPurchaseService.approve(actor, request)` takes what the confirmation step
showed: the quality, the Units, the price and the period's end, and an
idempotency key.

1. **An unusable request** (an empty or over-long key, fractional Units or
   price, an invalid date) is refused as `VALIDATION_FAILED`, unaudited.
2. **Authorization.** A non-member is refused `FORBIDDEN` unaudited, as any
   organization access is. A member without `billing.manage` is refused
   `FORBIDDEN` and audited (`unit_purchase.refused`, reason
   `LACKS_BILLING_MANAGE`).
3. **A replay** of a key already used returns that purchase
   (`ALREADY_APPROVED`) when it is the same approver, quality, Units, price and
   expiry, even after its period has ended. A key reused for anything else is
   refused (`IDEMPOTENCY_KEY_REUSED`).
4. **The plan.** Refused, audited, opening nothing:
   - `NO_PLAN`: the organization has no subscription;
   - `NOT_STARTED`: its first period has not begun;
   - `THROUGH_SALES`: Enterprise, whose packages go through sales (ADR-0053
     Decision 5A, ADR-0066 Decision 4, item 3);
   - `CARD_PAYMENT_NOT_AVAILABLE`: a self-service plan, which pays by card, and
     card payment is not built;
   - `NOT_OFFERED`: HQ on Standard;
   - `OFFER_CHANGED`: the Units or the price differ from the catalog's.
5. **The period.** The current renewal period is opened if nothing has opened
   it yet (`renewEntitlementPeriod`), because the block must join it. Opening a
   period is idempotent and changes nothing a customer can see (ADR-0066
   Decision 3). If the ledger cannot open it, the purchase fails with
   `INTERNAL_ERROR` and nothing is bought.
6. **The write** (Decision 4). Its refusals are audited like the others; a
   period whose end is not the one shown is `PERIOD_CHANGED`.

One package per approval; buying more means buying again under a new key
(ADR-0066 Decision 4, item 2). There is no cut-off near the end of a period: the
expiry is shown before approval instead (item 4).

## Decision 4 — One transaction, re-checked under the period's lock

`UnitPurchaseRepository.approve(record, check)` runs one transaction:

```text
cost-admission advisory lock (the period's)
  -> the key: a purchase already holding it is returned, nothing written
  -> the approver's membership FOR SHARE, its grants and its groups' permissions
  -> the subscription
  -> check(facts): the domain's decision on what was read here
  -> the block and its entitlement.add_on_block_granted audit entry
  -> the purchase
  -> its unit_purchase.approved audit entry
```

- **The same lock as a grant and a reservation.** Purchases into one period are
  ordered against each other and against reservations drawing on it, so two
  submits of one key into one period are ordered, and the second finds the
  first. Into two periods they take different locks and collide on the key's
  unique index; the loser re-reads the winner and answers as the ordered case
  would.
- **The check is the domain's** (`unitPurchaseRefusal`), the same function the
  service runs before the write. Inside the transaction it sees the period's
  frozen plan, which prices the package because the block joins that period;
  the subscription as it is now; and the approver's effective permissions as
  they are now (`null` once it is no longer a member).
- **The approver's membership is share-locked**, so a role change or removal
  either commits first and is seen here or waits for this transaction. An
  individual grant revoked or a group permission removed while the purchase
  runs is seen if it committed before the permissions were read; otherwise the
  purchase is ordered before it. Either way the approver held `billing.manage`
  at one instant inside the transaction.
- **One block-insert path.** A direct grant and a purchase insert through one
  helper, so every block carries the same audit entry.
- **All or nothing.** Any failure after the block is inserted, including the
  database refusing the purchase row, rolls the block and both audit entries
  back.

## Decision 5 — Dormant until UP-3

No application builds `UnitPurchaseService` or `createUnitPurchaseRepository`;
a shape test holds that. The purchase screen, its confirmation step and the
route are UP-3. The approver must have passed MFA, as every `billing.manage`
holder must at sign-in (ADR-0065 Decision 15); UP-3's route runs only for such
a session.

---

## Not decided or built here

- **The purchase screen, the confirmation step and the route** (UP-3).
- **The purchase list and the operator's invoicing CSV** (UP-4).
- **Stripe card payment** for self-service: it needs the failed-payment decision
  and the product owner's go-ahead for live charges.
- **Rate limiting**, which covers billing too.

Paid Provider Activation, production Provider credentials, production paid AI
calls, production scheduler activation and live Stripe charges remain BLOCKED.
Nothing here touches them.

## Consequences

- Every purchased block has a purchase record naming its price, its approver
  and its contract, and an audit trail of two entries.
- A purchase can only add Units. It cannot convert, extend or move a block, and
  a block cannot be bought twice.
- An invoice can be built from `unit_purchases` alone (UP-4), with the contract
  and the price as they were when the customer approved.
