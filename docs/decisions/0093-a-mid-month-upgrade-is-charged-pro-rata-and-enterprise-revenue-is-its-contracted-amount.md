# ADR-0093 — A mid-month upgrade is charged pro-rata, and an Enterprise organization's revenue is its contracted amount

Status: Accepted (2026-10-28). Records the decisions the product owner made on
2026-10-28 in the CTO thread: two in the morning, and three follow-ups answering
questions they left. Documentation only: nothing is built here.
Amends: ADR-0053 Decision 3B (the upgrade's charge and its Base-Unit ceiling). Builds on: ADR-0091
(a billing cycle's revenue for the Cost Safety Guard), ADR-0066 (the
operator command that provisions a plan).

## Context

ADR-0053 Decision 3B charges an immediate upgrade "the full difference"
between the two plans' monthly prices and says "do not prorate that
difference". ADR-0091 counts a billing cycle's revenue from the plan its
period was opened on, and counts an Enterprise cycle's as unknown, because no
contracted price is recorded anywhere: every Enterprise paid submission
therefore pauses. On 2026-10-28 the product owner settled both points.

## Decision 1 — A mid-month upgrade is charged pro-rata for that month

Decided by the product owner on 2026-10-28:
「月の途中で切り替えた場合は、その月はアップデートしたプランを日割りで請求。」

For the billing month in which an upgrade takes effect, the upgraded plan is
charged by the day, from the day of the switch to the end of that month. This
replaces ADR-0053 Decision 3B's "full difference … do not prorate" for
upgrades. The rest of Decision 3B stands: the upgrade is immediate, the next
renewal uses the new plan's normal price, and downgrade is renewal-effective with
no refund and no proration.

The old plan's unused days are **not credited**. Decided by the product owner
on 2026-10-28, answering that follow-up question:
「アップグレードした月は前のプランの残り日数は差し引きません。」 The old plan's
price for the month, already billed, stands in full, and the upgraded plan's
pro-rated days are charged on top of it.

The Base-Unit ceiling is pro-rated the same way. Chosen by the product owner on
2026-10-28 (decision card, option 「日割り」, which read: 「前のプランの Unit は
そのまま、新プランの Unit を残り日数で日割りして足します(端数は切り捨て、HQ 上限
も同じ)。」). For the month of the switch the organization keeps the old plan's
Base Units, since that month is paid in full, and gains the upgraded plan's Base
Units for the days it is charged for, rounded down:

```text
ceiling for the month = old plan's Base Units
                      + floor(new plan's Base Units × days charged ÷ days in the month)
remaining             = ceiling − Base Units consumed this period
```

For example, Standard (15) to Premium (40) with 15 of 30 days charged and 10
Base Units consumed: 15 + floor(40 × 15 ÷ 30) = 35, so 25 remain. The plan's
included HQ ceiling is computed alike. This replaces Decision 3B's "replaced by
the new plan's period ceiling, not stacked" for the month of the switch; its
rule that only Base Units consumed reduce the ceiling stands, and from the next
renewal the new plan's ceiling applies whole. Each Unit then costs what its own
plan's price buys: an upgrade late in the month buys a few days' Units for a few
days' price.

## Decision 2 — An Enterprise organization's revenue is the amount the operator records

Decided by the product owner on 2026-10-28 (typed 「１、２はそれで決定。」,
answering two questions in the CTO thread; the second's recommendation,
「契約額を登録」, read: 「Enterprise を登録するときに合意した月額も入力し、
安全装置はその額で計算します。」).

When an operator provisions an Enterprise plan, the agreed monthly amount is
recorded with it, and the Cost Safety Guard counts that amount as the cycle's
plan revenue in place of a catalog price. An Enterprise cycle with no recorded
amount stays unknown and keeps pausing.

The amount is entered **tax-exclusive**, as ADR-0091 counts every other figure.
Decided by the product owner on 2026-10-28, answering that follow-up question:
「税抜で入力」.

## Not decided here

- How a day is counted, for the charge and the Units alike (the time zone a
  day is counted in, and a switch made partway through a day). To be proposed
  when plan upgrade is built.
- How the Cost Safety Guard counts an upgraded period's revenue. Until upgrade
  revenue is recorded, it counts the plan the period was opened on, the lower
  price, which is the safe side.

## Consequences

- ADR-0053 Decision 3B's upgrade charge is superseded by Decision 1. Its
  text is not rewritten; a note at its upgrade section points here, so the
  initial-release contract no longer reads as if no-proration still held.
- `docs/decisions/TODO.md`: five decisions CLOSED, leaving no gate open; one
  implementation item (record the Enterprise amount, a migration, after the
  generation-to-preview plan); the subscription-billing item points here.
- No code, schema, route or page changes. Plan upgrade and self-service
  billing are not built; live Stripe charges remain BLOCKED.
