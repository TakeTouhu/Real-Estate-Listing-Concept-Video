# ADR-0068 — The Unit purchase screen, its confirmation step and its route

Status: Accepted (UP-3, the third of four Unit purchase pull requests).
Implements: ADR-0053 Decisions 1, 2, 5 and 5A (who may buy an additional Unit
package, and what a customer is shown before buying one), ADR-0066 Decision 4
(the product owner's purchase-timing decision and its defaults), and the
UXFlow rule that the quality lock is legible before purchase.
Builds on: ADR-0067 (the purchase record and its one-transaction approval),
ADR-0066 (the Units page) and ADR-0065 (MFA for every `billing.manage` holder).

## Context

After UP-2 a purchase can be approved and recorded, but nothing calls it. The
approved plan asks for a screen that lists the packages a plan sells, a
confirmation step that states what is being bought, and one explicit approval
(the Unit purchase proposal, Design 3 and 7):

- the Units and their quality, as Normal only or HQ only;
- the price, excluding tax;
- that the Units expire at the end of the current period, on a date, with no
  carry-over and no refund;
- that it will be invoiced.

This is the first route in the product that changes what a customer is charged.

---

## Decision 1 — Who sees it

The purchase screen, `/organizations/{id}/units/buy`, is for holders of
`billing.manage`: `OWNER` and `BILLING` by default, an `ADMIN` only once an
`OWNER` grants it (ADR-0053 Decision 5A). Anyone else, member or not, is told
alike that they cannot buy Units for the organization, and sees nothing of the
plan. Viewing the screen is not audited, as viewing the Units page is not; every
refused *approval* of a member is (ADR-0067 Decision 3).

The Units page links to the screen for a holder of `billing.manage` only. The
overview says whether the viewer holds it (`mayBuyUnits`); it reads nothing more.

The sign-in that reaches either page has passed MFA, because every
`billing.manage` holder must use it (ADR-0065 Decisions 7 and 15) and no page or
route is reachable before that step.

## Decision 2 — What it offers

`UnitPurchaseService.offers` decides what the screen shows, with **the same
check a purchase is written under** (`unitPurchaseRefusal`), so it never offers
a package that approving would refuse:

| The organization | The screen |
| --- | --- |
| no plan | says VTaVision sets it up when the contract starts |
| a plan not started | says when it starts |
| Enterprise | lists its packages and says they are bought through the VTaVision representative; no review link, no button (ADR-0053 Decision 5A) |
| a card-paid plan | says additional Units cannot be bought by card yet |
| an invoice-paid Standard or Premium plan | lists each package it sells with its price, excluding tax, and the date every package bought now expires |

- **The period.** The ledger's period containing now, if one is open; otherwise
  the current period as it would open, as on the Units page. Showing it opens
  nothing (ADR-0066 Decision 3). Approving opens it (ADR-0067 Decision 3).
- **The price.** The open period's frozen plan prices the package, as when the
  purchase is written; before it opens, the subscription's plan does.
- **One package per purchase** (ADR-0066 Decision 4, item 2). HQ is never
  offered on Standard, and the screen says so.

## Decision 3 — The confirmation step

`?package=NORMAL` or `?package=HIGH_QUALITY` shows one package, and states:

- its Units, and that they fund only videos of its quality, never the other;
- its price excluding tax, and that consumption tax is added on the invoice;
- that it expires at the end of this period, with the date and time in Japan
  time, and that Units left unused then do not carry over and are not refunded;
- that the Units are ready as soon as the customer approves, and that VTaVision
  invoices the purchase under the contract, named by its reference.

It has one button, which names the price. A package the plan does not sell, or
no package at all, is refused on the screen and no form is shown.

The form carries back what the step showed: the quality, the Units, the price
and the period's end, and **an idempotency key made for this step**
(`crypto.randomUUID()` each time it is shown). Submitting the same step twice
buys once (ADR-0067 Decision 3); buying another package means reviewing again.

"Not refunded" is about unused Units at the period's end (ADR-0053 Decision 3A).
It does not exclude a refund VTaVision owes for its own billing error, which the
open `TODO.md` item on correcting a purchase made in error covers.

## Decision 4 — The route

`POST /api/organizations/{id}/unit-purchases`, a form post from the confirmation
step, in this order:

1. **The origin.** The post must name an `Origin` whose host is the one the
   browser addressed (the first `X-Forwarded-Host`, else `Host`). Anything else,
   including no `Origin` at all, is refused `403` before anything is read. The
   session cookie is already `SameSite=Lax` (ADR-0006), which keeps it off a
   form posted from another site; the check also refuses another origin of the
   same site. SecurityCompliance asks for CSRF protection on cookie-based
   mutations, and this is the first one that changes a charge.
2. **The sign-in**, else to the sign-in page.
3. **The form**, shape only (whole Units and yen without a leading zero, the
   period's end exactly as the step wrote it, a key of 1 to 200 characters);
   anything else goes back to the screen saying nothing was bought.
4. **The approval** (`UnitPurchaseService.approve`), which decides everything
   else and audits every refusal of a member.

| Outcome | Where the customer lands |
| --- | --- |
| approved, or the same approval replayed | the Units page, which says the purchase is approved, its Units are ready and VTaVision will invoice it |
| refused | the purchase screen, saying why and that nothing was bought; a changed offer, period or key asks for a fresh review |
| `FORBIDDEN` | the purchase screen: they cannot buy Units, nothing was bought |
| another `AppError` | the purchase screen: the purchase could not be confirmed, and to check the Units page before trying again |
| anything else | not caught: a server error |

Only a refusal, a permission refused or an unreadable request says nothing was
bought. Any other failure may have come after the transaction committed, so the
customer is sent to look rather than told it failed.

## Decision 5 — What stays out

- **No rate limit.** Rate limiting is its own cross-cutting milestone and covers
  billing too (SecurityCompliance); this route has none yet.
- **No payment processor.** Nothing here calls Stripe or any network service; an
  invoice-paid organization is invoiced under its contract (UP-4 lists the
  purchases for that).
- **The origin check covers this route only.** The other cookie-based mutation
  routes rely on `SameSite=Lax` alone; extending the check to them is recorded
  in `TODO.md`.

---

## Consequences

- An invoice-paid Standard or Premium organization can buy additional Units in
  the product, and its Units are usable at once.
- Enterprise and card-paid organizations see why they cannot buy here.
- The screen and the approval share one check, so what is offered is what is
  accepted; anything that moved in between is refused and explained.

Paid Provider Activation, production Provider credentials, production paid AI
calls, production scheduler activation and live Stripe charges remain BLOCKED.
Nothing here touches them.
