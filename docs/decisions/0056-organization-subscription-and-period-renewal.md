# ADR-0056 — The organization subscription and on-demand period renewal

Status: Accepted (Phase 6B)
Implements: ADR-0053 Decisions 1, 1A and 5 (which plan an organization is on,
monthly renewal, sales-assisted representable without Stripe).
Extends: ADR-0055, whose `openPeriod` now has a producer.

## Context

Phase 6A built the Unit ledger and left it without a producer: `openPeriod` is an
input "a later billing package will supply", and `reserve()` refuses with
`NO_ENTITLEMENT_PERIOD` until something has opened the period containing its
instant. Nothing recorded which plan an organization is on, so nothing could
derive a period. Every remaining Phase 6 package — Unit purchase, seats, storage
blocks, upgrade, downgrade, cancellation, the per-period recovery budget — needs
both facts.

Production scheduler activation is BLOCKED (ADR-0054 Decision 7), so renewal
cannot depend on a timer.

---

## Decision 1 — One subscription row per organization

`organization_subscriptions` holds the organization's plan, the channel it was
sold through, the anchor its renewal periods are counted from, and the commercial
reference it came from. It holds no period, no Unit count and no balance: periods
stay in the ledger, which freezes its own plan snapshot.

- **Channel.** `SELF_SERVICE` (Standard and Premium, Stripe, later) or
  `SALES_ASSISTED` (invoice and bank transfer, no Stripe object). **Enterprise is
  sales-assisted only** (ADR-0053 Decisions 1A and 3B); provisioning refuses it on
  self-service with `CHANNEL_NOT_OFFERED`, and a CHECK constraint holds the same
  rule in the schema.
- **Commercial reference is required.** An entitlement with no commercial record
  behind it is an allowance nobody sold.
- **Written once.** A replay with identical facts answers
  `ALREADY_PROVISIONED`; anything else is `CONFLICT`. Two concurrent first
  provisions are ordered by the unique organization id, and the loser re-reads the
  winner and answers exactly as a sequential replay would. Plan changes are a
  later package and will not go through provisioning.
- **Audited.** `subscription.provisioned`, with the acting operator or billing
  integration.
- **The foreign key to `organizations` is `RESTRICT`.** Billing records are
  retained for 10 years (ADR-0053 Decision 7), so an organization row cannot be
  deleted from under its subscription. The ledger tables carry no organization
  foreign key at all; this one does, because a subscription for an organization
  that does not exist is a defect worth refusing at the schema.

## Decision 2 — Monthly periods counted from the anchor

Every plan's Units are stated per month (ADR-0053 Decision 1), so every renewal
period is one calendar month. Enterprise's *payment* cadence may be individually
agreed; its Unit allowance is still monthly.

Period *n* runs from `anchor + n months` (inclusive) to `anchor + (n+1) months`
(exclusive), in UTC, with the day clamped to the target month's last day and the
time of day kept. It is **always computed from the anchor**, never from the
previous period's end, so clamping never drifts: an anchor on Jan 31 gives
Feb 28 (or 29), then Mar 31 again. This is the convention a Stripe monthly
subscription with the same billing anchor uses, so a later integration can agree
with these bounds exactly. Periods are contiguous by construction.

## Decision 3 — Renewal is on demand and idempotent; there is no scheduler

`renewEntitlementPeriod(organizationId, at)` opens the subscription's period
containing `at` through the ledger's `openPeriod`, with a deterministic id
(`uep_<subscription>_<n>`), billing-cycle key (the period's start instant) and
commercial reference (`subscription:<subscription>:<n>`). Every concurrent or
replayed caller derives the same facts, so the ledger opens the period once and
answers the rest `ALREADY_OPEN`.

It is meant to be called just before reservation admission, with the same
instant the reservation will carry. No timer, cron or loop is introduced, so the
production scheduler gate is untouched.

- **No back-fill.** Only the period containing `at` is opened. A month nobody
  generated in is never opened afterwards: unused Units do not carry over, and
  nothing could have reserved against it.
- **`NOT_STARTED`** before the anchor; **`NO_SUBSCRIPTION`** for an organization
  without one.
- **`PERIOD_CONFLICT`** when the derived period collides with a period this
  subscription did not open (one opened by hand). It is surfaced, never resolved
  by choosing; nothing is written.
- **The plan snapshot** is the subscription's plan when the period opens, frozen
  by the ledger as ADR-0055 already requires.

The renewal opens a period with no acting user, matching ADR-0055's "a renewal
has none".

## Not decided here

- **What happens to a self-service renewal whose payment fails.** No approved
  decision covers dunning, grace or suspension. Renewal today opens a period for
  any provisioned subscription, which is correct for sales-assisted contracts and
  must be gated on payment standing before self-service billing is built. Recorded
  as an open gate in `docs/decisions/TODO.md`.
- Cancellation, upgrade (Base ceiling replaced minus Base Units consumed),
  downgrade, seats and storage blocks are later Phase 6 packages. An upgrade will
  need its own rule for the period already open, since a period's snapshot is
  immutable and a replayed renewal with a different plan answers
  `PERIOD_CONFLICT`.
- A returning customer after a subscription ends is not representable yet: one
  subscription row per organization.

## Consequences

**Dormant.** No application code provisions a subscription or calls renewal, and
`reserve()` still has no production caller, so nothing here changes what any
customer is charged.

**Accepted cost.** Renewal is lazy: a period exists only once something asked for
it. A billing report that wants every month of a subscription must derive the
bounds from the anchor rather than list periods.

**Accepted cost.** The `RESTRICT` foreign key means a future organization-deletion
feature must decide what happens to the commercial record; it cannot remove it
silently.
