# ADR-0091 — A billing cycle's revenue is read from its period

Status: Accepted (GS-5b, 2026-10-28). Last of GS-5's pull requests in the
generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`, row GS-5).
Implements: the product owner's decision of 2026-10-27 on what a billing
cycle's revenue is (decision card, option "月額+Unit購入";
`docs/decisions/TODO.md`, *Decision gates — CLOSED*).
Builds on: ADR-0055 and ADR-0056 (entitlement periods, each opened on a plan
it keeps), ADR-0067 (a Unit purchase on its period), ADR-0070 (a cancelled
purchase is withdrawn and not invoiced), ADR-0054 Decision 3 (the Cost Safety
Guard).

## Context

The paid-submission gate weighs a cycle's cost against the cycle's revenue
and hard-pauses below its floor. It reads revenue through
`BillingCycleRevenueReader`, and the only reader answered unknown for every
cycle, so the gate paused every paid submission, the test route's included
(ADR-0090, *Not decided here*). No ADR said what revenue was until the product
owner decided it on 2026-10-27.

## Decision 1 — The rule is the domain's

`billingCycleRevenueYen(facts)` in `@app/domain` is the decision, written
once:

- the monthly price of the plan the period was opened on, from the customer
  plan catalog, tax-exclusive;
- plus the price of every Unit purchase approved on the period, tax-exclusive;
- a cancelled purchase counts nothing (ADR-0070);
- seats and storage blocks are not counted while they are not recorded;
- **Enterprise is unknown**, `null`, until its contracted price is recorded:
  its catalog price is a list price, not what any customer agreed to pay;
- a plan the catalog does not hold is unknown too.

Unknown fails the gate closed, as before. A total past a safe integer throws
rather than rounding a revenue figure.

## Decision 2 — The facts are the cycle's entitlement period

The gate already knows the cycle: its key comes from the job's reservation,
frozen when the hold was taken. An organization has at most one period for a
cycle key, and that period keeps the plan it was opened on (ADR-0056). A Unit
purchase records the period it was approved on (ADR-0067). So the period alone
answers which plan and which purchases; no subscription row, invoice or
"current plan" is read.

A cycle with no period for the asking organization is unknown. A purchase
counts on its own period, never on a later one. A legacy reservation with no
allocated period carries a cycle key no foreign key ties to a period; the
lookup by organization and key then finds the period of that key or none, and
none is unknown, so it fails closed.

## Decision 3 — One statement, on the gate's own transaction

The gate asks its session for the revenue
(`PaidSubmissionAuthorizationSession.readBillingCycleRevenue`), after loading
its facts and before arming, so the read happens only while the cycle's
cost-admission lock is held. A purchase's block grant (ADR-0067) and a
cancellation (ADR-0070) take that same lock, so neither can commit between
this read and the decision it feeds.

The database's session runs `readBillingCycleRevenueWithin(tx, …)` on the
gate's transaction: one SQL statement reading the period, its purchases and
their cancellations, so they are one snapshot, with the arithmetic left to
Decision 1's rule. Every join is scoped by organization as well as by id.
Reading on the transaction rather than on another pooled connection means an
authorization never holds one connection while waiting for a second.

The paid-submission repository takes an optional `revenue` source. A test
passes a fixed figure to steer the Safety Guard, and a composition that must
fail closed whatever the database holds passes
`createUnavailableBillingCycleRevenueReader`. Left out, the revenue is the
cycle's period's. The gate's dependencies no longer carry a revenue reader.

## Decision 4 — Today's catalog price

Plan prices are not versioned: the reader prices a period's plan at the
catalog's current price. A future price change would change the revenue the
guard reads for a period already open. Versioning prices is not decided here.

## Decision 5 — Nothing in production builds it yet

The paid-submission service is constructed only in tests until the pipeline
command (GS-9) composes it with the test route (ADR-0090).

## Not decided here

- **Where an Enterprise contracted price is recorded**, and so Enterprise
  revenue. Until then an Enterprise cycle keeps pausing; the development
  organizations GS-9 uses need a Standard or Premium period.
- **Versioned plan prices** (Decision 4).
- **Seats, storage blocks and payment fees**, which the decision left out;
  seats and storage are to be revisited once they are recorded.

## Consequences

- `@app/domain` exports `billingCycleRevenueYen` and
  `BillingCycleRevenueFacts`; the session gains `readBillingCycleRevenue`, and
  `PaidSubmissionAuthorizationDeps` loses `billingCycleRevenue`.
- `@app/database` exports `readBillingCycleRevenueWithin`, and the
  paid-submission repository's options gain `revenue`.
- Reading the cycle's period, an attempt in a Standard or Premium cycle can
  cross the gate in a test; an Enterprise one still hard-pauses with
  `BILLING_CYCLE_REVENUE_UNAVAILABLE`.
- No migration, no route, no page. Paid provider activation stays BLOCKED
  (ADR-0054 Decision 7).
