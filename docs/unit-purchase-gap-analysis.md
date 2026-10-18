# Gap analysis — additional Unit packages, invoice-paid organizations first

Base: `main @ a60a76d` (PR #88, MFA-4; post-merge CI run 565 green).
Contract: ADR-0053 Decisions 1, 2, 3, 5 and 5A; ADR-0054 Decision 6 (the
operator privilege); `docs/UXFlow.md` (what funds a generation is legible before
purchase). Approved by the product owner on 2026-10-16 as four pull requests,
with purchased Units usable on approval and invoiced afterwards
(`/mnt/project-files/cto/unit-purchase-proposal.md`).

## What the contract requires

- **Packages, excluding tax.** Standard: +5 Normal for ¥19,900, no HQ package.
  Premium: +10 Normal for ¥35,900 or +2 HQ for ¥9,000. Enterprise: +25 Normal for
  ¥89,400 or +5 HQ for ¥22,400.
- **Quality-locked and period-bound.** Normal funds only Normal, HQ only HQ, no
  conversion; a package belongs to the current renewal period and does not carry
  over.
- **Customer-approved.** Every purchase is approved by a `billing.manage` holder;
  no automatic overage, nothing bought implicitly. Approvals are audited.
- **Enterprise** changes are governed by the contract; an in-app action must not
  be assumed to change an Enterprise contract amount.
- **Channels.** Self-service pays by card through Stripe; sales-assisted pays by
  invoice and bank transfer, with no Stripe object.
- **Before purchase**, the customer can see what funds a generation and that
  blocks are quality-locked.

## What is implemented on the base

| Piece | State on `a60a76d` |
| --- | --- |
| Package sizes and the package price formula in the plan catalog | built, no production caller |
| Add-on block ledger (`grantAddOnBlock`, idempotent, HQ on Standard refused, audited) | built in 6A, dormant |
| Eligibility-first reservation across Base Units and blocks | built in 6A |
| Organization subscription and on-demand period opening | built in 6B, dormant: **nothing provisions a subscription**, so no organization has a plan or a period |
| `billing.view` / `billing.manage`, MFA for their holders | built (6C, 6D, MFA-3) |
| A page showing plan, period and Units left | not built |
| A purchase record, service, route or screen | not built |
| Stripe, invoice records | not built; live Stripe charges are BLOCKED |
| Rate limiting | not built anywhere (its own milestone) |

Two facts shape the order:

1. **No organization has a plan.** A package is added to the current period,
   which does not exist until something provisions a subscription.
2. **Self-service Stripe is blocked twice**: live charges need the product
   owner's go-ahead, and the open gate on a failed monthly card payment must be
   settled first (`TODO.md`). The invoice channel needs neither.

## The gap and how it is split

| PR | What it does | Visible? |
| --- | --- | --- |
| **UP-1** | the operator command that gives an organization its contract's plan; the Units page; ADR-0066; no migration | yes: the Units page, "no plan yet" until the command runs |
| UP-2 | migration 27 (`unit_purchases`); the approved package prices in the catalog; the purchase service writing purchase, block and audit in one transaction, idempotent, re-checking price, period and `billing.manage` | no: no route calls it |
| UP-3 | the purchase screen, the confirmation step and the route | yes, to `billing.manage` holders of an organization with a plan |
| UP-4 | this period's purchases on the Units page; the operator CSV for invoicing | yes, a list |

## Found while building UP-1

- **Viewing opens no period.** The proposal let the Units page open the current
  period when first needed. UP-1 opens nothing: an unopened period is shown as it
  would open, which is exact because nothing can have drawn on it (ADR-0066
  Decision 3). A period is opened by whatever first needs one.
- **`Date` accepts impossible dates.** `new Date("2026-02-30T00:00:00Z")` is
  2 March. The command checks the calendar itself before accepting a start.
- **The operator's name is declared, not authenticated.** Recorded as an
  accepted cost and an open item for an operator console (ADR-0066 Decision 2).

## Not in this plan

Stripe card payment; additional seats, storage blocks, plan changes and
cancellation; charged disclosure recomposition; rate limiting; an operator
console with its own sign-in. Each needs its own approval.
