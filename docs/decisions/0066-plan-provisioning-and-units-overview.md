# ADR-0066 — Plan provisioning by an operator, and the Units overview

Status: Accepted (UP-1, the first of four Unit purchase pull requests).
Implements: ADR-0053 Decisions 1, 2, 5 and 5A (in part), ADR-0054 Decision 6
(the operator privilege), and the UXFlow rule that what funds a generation is
legible before purchase and before generation.
Builds on: ADR-0055 (the Unit ledger) and ADR-0056 (the subscription and
on-demand renewal).

Approved by the product owner on 2026-10-16 as four pull requests, with
purchased Units usable as soon as the customer approves and invoiced afterwards
(`/mnt/project-files/cto/unit-purchase-proposal.md`).

## Context

Phase 6A built the Unit ledger and Phase 6B the subscription, and both are
dormant: **nothing in the application provisions a subscription**, so no
organization has a plan, a period or any Units. An additional Unit package is
added to the current period, so a purchase has nowhere to go until an
organization has a plan.

Self-service sign-up through Stripe cannot come first. Live charges are BLOCKED
(ADR-0054 Decision 7), and the open gate on a failed monthly card payment must
be decided before self-service billing is built (`TODO.md`). A sales-assisted
plan needs neither: it comes from an executed contract and is paid by invoice
and bank transfer (ADR-0053 Decision 5). So the first channel built is the
sales-assisted one.

---

## Decision 1 — An operator command gives an organization its contract's plan

`pnpm --filter @app/ops provision-subscription` writes the organization's one
subscription:

| Option | Meaning |
| --- | --- |
| `--organization` | the organization's id |
| `--plan` | `standard`, `premium` or `enterprise` |
| `--starts` | the contract's start, an ISO 8601 instant with an explicit offset; it becomes the renewal anchor |
| `--contract` | the executed contract's number; it becomes the commercial reference |
| `--operator` | who is running it |
| `--reason` | why, for example the order it fulfils |

- **Always `SALES_ASSISTED`.** There is no channel option. A self-service
  subscription will come from its payment processor, never from an operator.
- **Every option is required**, and nothing is defaulted. The start must name its
  offset, so no machine's time zone chooses the anchor, and it must be a real
  calendar instant: `Date` would silently turn 30 February into 2 March.
- **The subscription is named after its organization** (`sub_<organization id>`).
  Running the command again with the same plan, start and contract is a replay
  and writes nothing. Anything different is refused, and the command shows what
  the organization already has. It never changes a plan; plan changes are later
  work.
- **The audit entry** (`subscription.provisioned`, written in the same
  transaction as the subscription, as since Phase 6B) records the operator and
  the reason. An operator is not a member of any organization, so the entry has
  no actor user.
- **Exit codes**: 0 when the organization has this plan afterwards, 1 when
  refused, 2 when the arguments are unusable.

## Decision 2 — The command is the operator privilege, and only that

ADR-0054 Decision 6 asks that an operator privilege be explicit, identified,
reasoned, audited and least-privilege, and kept separate from support-content
access and permission mutation.

- **Explicit and least-privilege.** The command runs outside the web app with the
  database credentials of whoever runs it. It lives in its own package,
  `apps/ops`, which neither application depends on, and it does exactly one
  thing.
- **Identified, reasoned and audited**, as in Decision 1.
- **Separate.** It reads no customer content and changes no member or permission.
- **Not time-limited**, because it is a single action rather than a standing
  grant.

**Accepted cost.** The operator's name is declared, not authenticated: anyone
holding the database credentials could write any name. An operator console with
its own sign-in replaces this command later (`TODO.md`).

## Decision 3 — The Units overview

`UnitsOverviewService.overview` answers what an organization has left to
generate with this period. The Units page (`/organizations/{id}/units`, linked
from the dashboard) shows it.

- **Who sees it.** It needs `unit.view` (`OWNER`, `ADMIN`, `MANAGER`, `CREATOR`,
  `BILLING` by default). How the plan is paid and its monthly price also need
  `billing.view` (`OWNER`, `ADMIN`, `BILLING` by default). An individual or group
  grant of either counts. A non-member and a member without `unit.view` are
  refused alike, before anything about the plan is read.
- **Which period.** The ledger's period containing now, as the ledger has it.
  Without one, it shows the subscription's current period as it would open, with
  the plan's whole allowance and no add-on block. That is exactly what opening
  it would freeze, because nothing can have been reserved or bought in an
  unopened period. Before the subscription's anchor it says when the plan
  starts. Without a subscription or a period, it says there is no plan.
- **It writes nothing.** Viewing opens no period, grants nothing and audits
  nothing. A period is opened by whatever first needs one: a purchase (UP-2) or
  a reservation.
- **What it shows:**
  - the plan;
  - the period's bounds, in Japan time;
  - that nothing carries over;
  - the Base Units left, and how many of them can still fund HQ. That number is
    the smaller of the Base Units left and the included HQ ceiling left, because
    the ceiling sits inside the Base pool (ADR-0053 Decision 3);
  - every add-on block, oldest first, with its quality and what is left, and the
    totals for each quality;
  - that a Normal add-on funds only Normal and an HQ add-on only HQ;
  - when the plan sells no HQ package, that it does not.
- **Wording.** Prices are labelled as excluding tax (ADR-0053 Decision 1).
  Qualities are only ever "Normal" and "HQ", never a model or provider.

## Decision 4 — Choices the contract leaves open, recorded

These are the product owner's approval of 2026-10-16 and the defaults proposed
with it, recorded in `TODO.md`:

1. **An invoice-paid organization can use purchased Units as soon as its
   `billing.manage` holder approves the purchase.** The purchase is invoiced
   afterwards under the contract. *(Product owner's decision; built in UP-2 and
   UP-3.)*
2. **One package per approval.** Buying more means buying again.
3. **An Enterprise package goes through sales.** The page lists it with a contact
   note rather than a buy button, because an in-app action must not be assumed
   to change an Enterprise contract amount (ADR-0053 Decision 5A).
4. **No purchase cut-off near the end of a period.** The expiry is shown before
   approval instead.
5. **An organization gets a plan from the operator command** until self-service
   sign-up exists.

---

## Not decided or built here

- **The purchase**: the record, the price authority and the one-transaction
  grant (UP-2), the screen (UP-3), and the invoicing list (UP-4).
- **Stripe self-service.** It needs the failed-payment decision and the
  product owner's go-ahead for live charges.
- **Opening a period for a reservation.** Generation is not wired to a route yet.
- **An operator console** with its own sign-in.

## Consequences

**Accepted cost.** The page computes an unopened period's allowance from the
catalog instead of reading a frozen snapshot. The two agree because the period
opens from the same catalog and nothing has drawn on it. A later catalog
revision would change what an unopened period shows, which is exactly what
opening it would then freeze.

**Accepted cost.** The dashboard links every member to the Units page, including
a `VIEWER`, who is told they cannot view it. Working out each organization's
effective permissions on the dashboard would cost a grant and group query per
organization, to hide one link.
