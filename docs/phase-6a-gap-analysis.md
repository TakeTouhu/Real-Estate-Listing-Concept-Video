# Phase 6A gap analysis — Unit entitlement and ledger foundation

Status: **implementation paused at a decision gate** (see *Blocking decision*).
Base: `main @ 9a4639256af9228d690b72d92b86e2ef79d9818a` (PR #73 merged; migration
16 is the latest; no open decision gate in `docs/decisions/TODO.md`; the only
open PR, #46, is unrelated governance work).

Authority: ADR-0053 Decisions 1, 1A, 2, 3; ADR-0052 Decisions 4, 9, 19.

## What exists today

| Concern | Current runtime | Where |
| --- | --- | --- |
| Plan values | Standard/Premium/Enterprise: 15/40/100 included Units, HQ ceiling 1/5/10 *inside* the total, HQ add-on unavailable on Standard — all match ADR-0053 | `packages/domain/src/pricing/customer-plan-catalog.ts` |
| Units per job | **1–3 Units per job**, from total duration: 1–30 s → 1, 31–60 s → 2, 61–90 s → 3, refused above 90 s. HQ jobs mark the same count as HQ (`highQualityUnits = totalVideoUnits`) | `pricing/customer-pricing.ts:videoUnitsForSeconds`, `orchestration/entitlement.ts:requiredUnitsFor` |
| Job admission | Derives `requiredVideoUnits` / `requiredHighQualityUnits` and freezes them on `GenerationJob` | `orchestration-repositories.ts:create` |
| Reservation | One `GenerationReservation` per job (unique `generationJobId`); copies the job's unit counts; freezes a **caller-supplied** `billingCycleKey` / start / end | `orchestration-repositories.ts:reserve` (Transaction B) |
| Balance check | **None.** Reserving never consults any allowance, so nothing stops overspend | — |
| Subscription / period | **None.** No organization plan, no entitlement period, no renewal record | `schema.prisma` |
| Add-on blocks | **None.** Add-on *pricing* exists (`addOnPackagePrice`); no block is representable | — |
| Reservation states | `RESERVING → RESERVED ⇄ RECONCILIATION_HOLD → CONSUMED \| RELEASED`; both terminal | `orchestration/state-machines.ts` |
| Consume | Transaction G only, in the publication commit, and only for the **initial** publication; a replacement publication consumes nothing | `deliverable-validation-repository.ts:publishDeliverable` |
| Release | Generic transition, reconciliation, and media-failure settlement (Transaction H) | `orchestration-repositories.ts`, `reconciliation-repository.ts`, `media-failure-resolution-repository.ts` |
| Lock order | `cost-admission advisory lock (org + cycle) → reservation row → everything else`; Transaction G: `reservation → job → version → composition → validation` | `cost-admission-lock.ts`, ADR-0051 Decision 5 |
| Audit | `GenerationTransitionEvent` (append-only machine history, allowlisted metadata) per aggregate; `AuditLog` for person actions | `schema.prisma` |
| Production callers | None — generation stays dormant behind the activation gates | — |

## Gaps Phase 6A must close

1. **No entitlement exists to reserve against.** A durable, period-bound
   entitlement (organization, plan snapshot, Base Units, HQ ceiling, period
   start/end, external reference) is needed, supplied by an internal interface a
   later billing package will call. No Stripe object is required.
2. **No add-on block representation.** Quality-tagged blocks (organization,
   quality, original quantity, period, external/order reference, creation time,
   deterministic FIFO key) are needed; remaining quantity must be derivable
   rather than a drifting counter.
3. **No eligibility-first selection.** Base → oldest eligible block → … within
   the request's quality class, HQ Base only while the ceiling remains, ineligible
   blocks skipped.
4. **No frozen funding source.** The reservation records units and a cycle key,
   never *which entitlement* funds it.
5. **No serialization of reservations against a balance.** Reserving does not
   take the cost-admission lock today; with a balance it must, as the outermost
   lock, to prevent concurrent overspend.
6. **Stale commercial constants.** `CONTRACT_MONTHS = 12` and
   `ANNUAL_PREPAYMENT_DISCOUNT_BPS = 500`, with `annualContractRawPricing` /
   `annualPrepaymentFinalPrice`, contradict ADR-0053 Decision 1A. They live in
   the same plan catalog and have no production caller, so they can be removed
   safely in this package without any payment flow.

## Design direction (not yet implemented)

Remaining capacity is **derived from reservation state**, not stored as a
counter: an allocation is held while its reservation is `RESERVING` / `RESERVED`
/ `RECONCILIATION_HOLD`, spent when `CONSUMED`, and returned when `RELEASED`.
Consume and release therefore stay exactly-once through the existing reservation
CAS in Transactions G and H and the existing release paths, with no new lock in
them and no counter to drift. Reserving takes the existing cost-admission lock
first, then computes availability. A migration 17 would add the entitlement
period, the add-on block and the frozen allocation of a reservation, nullable for
history (historical reservations have no recorded source and none is guessed).

## Blocking decision — how a multi-Unit job is funded

The work package requires that a reservation durably identify **"which
entitlement source funds it — Base Unit or a specific additional Unit block"**,
and that there be **"no consumption from two entitlement sources for one
reservation."** ADR-0053 Decision 3 states the order per Unit (*"draws from an
eligible remaining Base Unit … the oldest unexpired Normal add-on block …"*).

Both read naturally when a job costs one Unit. **A job here costs 1–3 Units**
(the duration rule above), so a job can need more Units than any one source has
left. Example: a Premium organization with 2 Base Units left and a +10 Normal
block requests a 90-second Normal video (3 Units).

| Option | Reservation funded by | Example result | Consequence |
| --- | --- | --- | --- |
| **A — per-Unit allocation** | each Unit independently, in eligibility-first order; a reservation holds 1–3 frozen allocations, **each from exactly one source** | 2 Base + 1 from the Normal block | Never refuses a fundable request; literal per-Unit reading of ADR-0053 Decision 3; one reservation draws from more than one source |
| **B — single source per reservation** | the first eligible source that can cover **all** of the job's Units | Base skipped (only 2 left); 3 from the Normal block — or refused if no single block has 3 | One source per reservation; can skip remaining Base Units or refuse a request whose eligible total suffices |

The same question arises for HQ: a 60-second HQ job on Premium with 1 included
HQ Unit left and a +2 HQ block is `1 Base + 1 HQ block` under A, and `2 from the
HQ block` under B.

This is a product/billing rule the approved contract does not settle, and the
explicit work-package wording and the per-Unit ADR wording point different ways.
**It is not guessed.** Recommendation: **Option A**, with "one source" applied
per allocated Unit — it follows ADR-0053's per-Unit order exactly, never refuses
a request the customer's eligible entitlement covers, and still freezes every
Unit to exactly one source and spends each exactly once.

## Non-blocking findings for the CTO

- **Standard HQ is limited to ≤ 30 seconds.** Standard's HQ ceiling is 1, it
  cannot buy HQ add-ons, and an HQ job of 31–90 s needs 2–3 HQ Units. Under
  either option, a Standard organization can never fund an HQ video longer than
  30 seconds. This follows from approved rules rather than creating one; it is
  stated so it is not discovered by a customer.
- **Customer regeneration is not charged today.** The existing model lets one
  job entitlement cover an initial generation and up to two per-scene user
  regenerations, and Transaction G consumes nothing on a replacement
  publication. ADR-0052 Decision 4 says customer-requested content regeneration
  consumes additional Unit(s). How a per-scene regeneration maps to Units (the
  scene's duration, the whole video's, or one Unit) is undecided. This does not
  block Phase 6A, which keeps the existing Phase 5C regeneration semantics; it
  must be decided before paid regeneration is built.
