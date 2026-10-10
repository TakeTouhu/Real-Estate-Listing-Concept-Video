# ADR-0055 — The Unit entitlement ledger

Status: Accepted (Phase 6A)
Implements: ADR-0053 Decisions 1, 2 and 3, and the CTO's multi-Unit funding
decision (Option A, recorded in `docs/decisions/TODO.md`).
Extends: ADR-0051 (Transaction G), whose consume now spends a frozen allocation
set.

## Context

Before Phase 6A a reservation copied its job's Unit counts and a billing-cycle
key **supplied by its caller**, and nothing compared it with any allowance.
There was no entitlement period, no add-on block and no record of which
entitlement a reservation drew on, so overspending was not refused anywhere and a
billing dispute could not be answered from persistence.

A job costs 1–3 Units (1–30 s → 1, 31–60 s → 2, 61–90 s → 3), so one
reservation can need more Units than any single source has left. The CTO decided
that a reservation may span sources (Option A).

---

## Decision 1 — Three tables, and no balance column

| Table | Holds |
| --- | --- |
| `unit_entitlement_periods` | one organization's entitlement for one renewal period: the plan snapshot (Base Units, included HQ ceiling, whether HQ add-ons are sold), `[startsAt, endsAt)`, the billing-cycle key, a commercial reference |
| `unit_add_on_blocks` | one purchased package: period, quality, quantity, purchase reference, purchase time |
| `generation_reservation_allocations` | one frozen slice of a reservation's funding: Base or one named block, quality, quantity, draw order |

**What remains is derived, never stored.** A period's remaining Base Units are its
snapshot minus the Base allocations of reservations that still occupy
entitlement; the included HQ ceiling's remainder is the snapshot minus the HQ
Base allocations; a block's remainder is its quantity minus its allocations. An
allocation occupies entitlement while its reservation is `RESERVING`, `RESERVED`,
`RECONCILIATION_HOLD` or `CONSUMED`, and stops when it is `RELEASED`.

The consequence is the property the ledger exists for: **consume and release
settle every allocation of a reservation exactly once, in the commit that moves
the reservation**, because that compare-and-set is the only thing that changes
whether the allocations occupy entitlement. A replayed consume or release that
loses its compare-and-set changes no balance. A stored counter beside the
reservation would be a second fact, written by four different transactions
(Transaction G, Transaction H, reconciliation and the generic transition), and
it could disagree.

The arithmetic is pure domain code (`packages/domain/src/entitlement/
allocation.ts`): the repository loads every allocation of the period with its
reservation's state, and the domain decides which count. The release rule is
therefore stated once, not as a `WHERE` clause in one place and a function in
another.

## Decision 2 — Eligibility-first, across the whole quantity, all or nothing

For a job needing N Units in quality Q:

1. **Base Units**, as many as are eligible. For HQ, eligibility is bounded by
   both the Base Units left and the included HQ ceiling left. Partial Base
   capacity is used — it is never skipped because a block could cover the whole
   request.
2. **Add-on blocks of quality Q only**, oldest purchase first (ties broken by
   id, so the order is total), continuing to the next-oldest until N is met.

A block of the other quality is never eligible; skipping it is not a FIFO
violation. There is no fallback between qualities in either direction, so a
Standard HQ job needing 2–3 Units cannot be admitted: Standard's ceiling is 1
and it sells no HQ block.

**All or nothing.** The plan is computed before anything is written. If the
eligible total is short, `reserve()` returns `INSUFFICIENT_ENTITLEMENT` with the
number of eligible Units, and nothing is written: no reservation, no allocation,
no job move, no event.

## Decision 3 — The funding is frozen in Transaction B

`reserve()` takes `reservedAt` from the server clock instead of a caller-supplied
cycle. The organization's period containing `reservedAt` funds the reservation,
and its billing-cycle key and bounds become the reservation's for life; the row's
own `reservedAt` is that same instant, so it can never claim to have been
reserved outside the interval it is bound to. A replay for a job that already
holds a reservation is answered `ALREADY_RESERVED` whenever it arrives, before
any period is looked up. The
allocation rows are inserted in the same commit as the reservation, numbered in
draw order.

Allocation rows have **no update path**. Consume and release never reselect
them, and opening the next period or buying a block never rebinds an existing
reservation: a hold made in November stays November's even if it is consumed or
released in December, and releasing it returns Units to November only.

The database holds the shape as well as the code:

- `(reservationId, entitlementPeriodId)` → reservations: an allocation names its
  own reservation's period;
- `(entitlementPeriodId, organizationId)` → periods: an allocation and a block
  stay inside their period's organization;
- `(addOnBlockId, entitlementPeriodId, quality)` → blocks: a block allocation
  names a block of the same period **and the same quality** — quality lock at the
  schema level;
- `(entitlementPeriodId, billingCycleKey)` → periods: a reservation's cycle is
  its period's, so the cost-admission lock every settlement takes for it is the
  one Transaction B took;
- CHECKs: positive quantities, a block id exactly on add-on allocations, an HQ
  ceiling inside the Base Units, a non-empty period interval, one Base row per
  reservation, and `funding = 'ALLOCATED'` exactly when a period is named.

## Decision 4 — The established lock order, unchanged

```text
cost-admission advisory lock (organization + cycle) -> reservation row -> everything else
```

Transaction B takes the cost-admission lock before it computes the balance,
moves the job or writes a row. That serializes it against every other
reservation, block grant and settlement on the same period, so two concurrent
reservations cannot both spend the last Unit. The period lookup before the lock
reads an immutable row and only decides which lock to take.

Before that, and before anything else, Transaction B takes a **job-scoped
reservation-admission lock**. Two attempts on one job may carry instants in
different periods — or one in none — and would otherwise take different
cost-admission locks, or none, so the loser reported `LOST` or
`NO_ENTITLEMENT_PERIOD` instead of `ALREADY_RESERVED`. It is the only lock ever
taken before the cost-admission lock, and it cannot form a cycle with it: only
`reserve()` takes it, always first, so no holder of the cost-admission lock or of
any row lock ever waits for it.

The public balance read takes no lock but reads one `REPEATABLE READ` snapshot:
its block and allocation queries would otherwise see different `READ COMMITTED`
snapshots, and a grant plus a reservation committing between them would make a
consistent ledger read as a defect. Transaction B needs no such snapshot — it
reads the balance under the cost-admission lock, which every grant and
reservation also takes.

Granting a block takes the same lock. Opening a period takes a separate
organization-scoped advisory lock and nothing after it, so it cannot form a
cycle. All three formulas live in `packages/database/src/cost-admission-lock.ts`,
the one module that holds advisory-lock formulas.

Transaction G is unchanged in its order (`reservation → job → version →
composition → validation`). It reads the allocations after taking the
reservation lock — they are immutable, so there is nothing to lock — and refuses
to spend a ledger-funded hold whose allocations do not fund exactly the reserved
Units in the job's own quality (`RESERVATION_FUNDING_INCOMPLETE`). A replacement
publication still spends nothing, and free recomposition still needs no
reservation at all.

## Decision 5 — History is labelled, never re-attributed

Reservations written before migration 17 recorded no funding source. They are
marked `UNALLOCATED_LEGACY` — the name of that shape, not a claim about where
their Units came from — with no period and no allocation, and the ledger counts
nothing against them. The column's default exists only in the statement that
labels them and is dropped at once, so no new reservation can become legacy by
omission. Every reservation made through `reserve()` is `ALLOCATED`.

## Decision 6 — The ledger takes inputs, not payments

`openPeriod` and `grantAddOnBlock` are the inputs a later billing package will
supply. The plan snapshot is derived from the catalog, not accepted. A block
carries a commercial reference that is unique per organization, so a replayed
purchase is credited once; it is never required to be a Stripe object, because
Enterprise and sales-assisted entitlements have none. An HQ block on a plan that
sells none is refused. Both writes leave an `audit_logs` entry. Nothing here
takes a payment, calls Stripe or decides a price.

## Decision 7 — The stale contract-term constants are removed

`CONTRACT_MONTHS = 12`, `ANNUAL_PREPAYMENT_DISCOUNT_BPS = 500` and the two
annual-prepayment functions encoded a 12-month contract with a standard 5%
discount, which ADR-0053 Decision 1A replaced. They had no production caller and
are removed; the plan catalog now also carries the approved add-on package sizes
(Normal +5 / +10 / +25, HQ — / +2 / +5).

---

## Not decided here

- **What a customer regeneration costs in Units** stays an open gate. Today one
  job entitlement covers an initial generation and up to two per-scene
  regenerations; that is not adopted as commercial policy, and no regeneration
  pricing is built. The ledger takes a quantity from its caller and chooses none
  for regeneration.
- Upgrade-time replacement of the Base ceiling (ADR-0053 Decision 3B), purchase
  checkout, renewal scheduling, and charged disclosure recomposition are later
  Phase 6 packages; none is implemented.

## Consequences

**Accepted cost.** Every balance read scans the period's allocations. A period
holds at most a few hundred reservations, so this is a bounded scan under an
index, and it buys a ledger that cannot drift from the reservations it describes.

**Accepted cost.** `reserve()` can now refuse. Callers must handle
`NO_ENTITLEMENT_PERIOD` and `INSUFFICIENT_ENTITLEMENT`; the job stays in
`RESERVING`, untouched, and the caller decides what the customer sees.
