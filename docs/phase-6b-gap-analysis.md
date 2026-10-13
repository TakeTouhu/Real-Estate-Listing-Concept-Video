# Phase 6B gap analysis — the subscription record and period renewal

Status: implemented on branch `phase-6b-subscription-renewal`.
Base: `main @ 2c529555095966a6cf5921fd4665197942567259` (PR #74, Phase 6A, merged
2026-10-12; migration 17 is the latest; no open pull request).

Authority: ADR-0053 Decisions 1, 1A, 2, 3 and 5; ADR-0055; ADR-0054 Decision 7.

## Why this package is next

Phase 6A built the ledger and left it with no producer. `openPeriod` is an input
"a later billing package will supply", and `reserve()` now refuses with
`NO_ENTITLEMENT_PERIOD` whenever nothing has opened a period. No organization
records which plan it is on, so nothing can derive a period, and every remaining
Phase 6 package — seats, storage blocks, upgrade, downgrade, cancellation, the
per-period recovery budget, a purchase that grants a block into the *current*
period — needs to know the organization's plan and its current renewal period.

This package is the root of that dependency tree and changes no charge.

| Concern | Before Phase 6B | Where |
| --- | --- | --- |
| Which plan an organization is on | **Not recorded.** `organizations` has no plan; only a period's frozen snapshot names one | `schema.prisma` |
| Sales-assisted representable without Stripe (ADR-0053 Decision 5) | No commercial record of any kind | — |
| Renewal | **None.** Every period must be opened by hand, with caller-chosen bounds and key | `unit-entitlement-repository.ts:openPeriod` |
| Period bounds | Caller-supplied; nothing derives a month | — |
| Scheduler | None, and production scheduler activation is BLOCKED (ADR-0054 Decision 7) | — |

## Gaps this package closes

1. **A durable commercial record per organization** — plan, channel
   (`SELF_SERVICE` or `SALES_ASSISTED`), the anchor its renewal periods are
   counted from, and the commercial reference it came from. Enterprise is
   refused on the self-service channel (ADR-0053 Decisions 1A and 3B).
2. **Deterministic monthly period bounds** from the anchor, with no drift.
3. **Renewal without a scheduler** — an idempotent operation that opens the
   period containing a given instant, safe to call on demand from reservation
   admission and safe under concurrent callers.

## Not in this package

- Subscription cancellation, upgrade, downgrade, seats and storage blocks.
- Stripe, invoices, payment state and dunning. **What happens to a self-service
  renewal whose payment fails is not decided anywhere** and is recorded as an
  open gate; it must be settled before self-service billing is built.
- Wiring a production caller. `reserve()` still has none, so nothing here changes
  what any customer is charged.
