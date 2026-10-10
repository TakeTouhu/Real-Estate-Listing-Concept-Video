# Phase 6A gap analysis — Unit entitlement and ledger foundation

Status: the multi-Unit funding gate is **CLOSED by CTO decision (Option A)**;
implementation resumed on this branch.
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

## Multi-Unit funding — decision gate CLOSED (Option A)

A job costs 1–3 Units, so it can need more Units than any single source holds.
The CTO chose **Option A**:

- **A reservation may span multiple funding sources.** It does not require one
  source to cover the whole quantity.
- **Allocation is eligibility-first across the whole quantity.** Normal: available
  Base Units, then the oldest eligible Normal block, then the next-oldest, until N
  is met. HQ: Base Units limited by both the remaining Base capacity and the
  remaining included HQ ceiling, then the oldest eligible HQ block, then the
  next-oldest. Normal and HQ blocks never substitute for one another.
- **Partial Base capacity is used before any add-on**, and add-ons continue
  oldest → newest within the eligible quality class.
- **The allocation set is frozen at reservation.** Each allocation names the
  reservation, the source type, the entitlement period, the specific block where
  applicable, the quality and the quantity. Consume and release act on the frozen
  set and never rerun selection; renewal and later purchases never rebind it.
- **Reservation is all-or-nothing.** If the eligible total is below N, admission
  fails with no reservation, no allocation and no balance change.

Examples the CTO fixed: Premium Normal needing 3 with 2 Base left and a +10 Normal
block → Base 2 + block 1; Premium HQ needing 2 with 1 Base and 1 HQ ceiling left
and a +2 HQ block → Base 1 + HQ block 1.

**Standard HQ consequence, not a gate.** Standard's HQ ceiling is 1 and it holds
no HQ add-on, so a Standard HQ job needing 2 or 3 Units cannot be admitted, and
there is no fallback to Normal Units.

## Still open — regeneration Units

- **Customer regeneration is not charged today.** The existing model lets one
  job entitlement cover an initial generation and up to two per-scene user
  regenerations, and Transaction G consumes nothing on a replacement
  publication. ADR-0052 Decision 4 says customer-requested content regeneration
  consumes additional Unit(s). How a per-scene regeneration maps to Units (the
  scene's duration, the whole video's, or one Unit) is undecided and **stays an
  open gate**. Phase 6A does not answer it, does not treat today's free
  regeneration as commercial policy, and builds no regeneration pricing; its
  reservation infrastructure takes a Unit quantity from its caller and chooses
  none for regeneration.
