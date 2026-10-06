# ADR-0053 — Initial-release commercial contract

Status: Accepted (CTO decision, pre-Commercial-Launch)
Scope: plans, pricing, contract term and billing cadence, Unit accounting,
cancellation and refund, plan upgrade/downgrade, storage quotas, payment
channels, SLA, legal retention, responsibility boundary, support, launch gates.

Supersedes, at the **product-contract level only**, the placeholder commercial
language in `docs/SaaSOperations.md` v1.0 ("credits", unspecified plan
definitions) and the open plan-definition TODO.

Does **not** supersede any historical ADR or phase-completion record.

Companion ADRs: ADR-0052 (product and delivery), ADR-0054 (production platform
and activation gates).

**This ADR is documentation. It implements no billing and charges nothing.**

---

## Context

The engineering layer already reserves and settles an entitlement unit exactly
once (Phase 5C, Transaction G). What a Unit *costs*, what a plan *includes*, and
who bears which risk were unspecified, and `docs/SaaSOperations.md` still spoke of
generic "credits" with plan definitions left open.

This ADR records the approved commercial contract. Terminology note: the product
sells **Units**; "credits" in v1.0 documents and in older code comments refers to
the same entitlement concept.

---

## Decision 1 — Plans

All prices **tax-exclusive** unless the UI explicitly presents a tax-inclusive
total.

| Plan | Monthly | Units | Included users | HQ ceiling | HQ add-on |
| --- | --- | --- | --- | --- | --- |
| Standard | ¥49,800 | 15 | 3 | 1 | unavailable |
| Premium | ¥119,800 | 40 | 10 | 5 | available |
| Enterprise | ¥298,000 | 100 | 30 | 10 | available |

Additional user: **¥3,000 / user / month**, tax-exclusive — usable immediately
on purchase with a prorated first period, full price from the next renewal
(Decision 5A).

**Buying additional users does not increase video generation Units.** User seats
and generation capacity are separate goods.

### The included-user and HQ columns are recorded, not newly priced

The last three columns are **not new pricing introduced by this ADR.** They are
the values the implemented plan catalog
(`packages/domain/src/pricing/customer-plan-catalog.ts`) has carried since the
pricing phase. They are written here because this ADR is declared authoritative
for the commercial contract, and an authoritative plan table that omitted them
would leave code as the only statement of a customer-facing entitlement.

Two semantics travel with them, and both match the implementation:

- **"HQ ceiling" is a limit inside the included Units, never an extra pool.** A
  Standard customer has 15 Units and may spend **at most 1** of them on HQ. HQ
  usage is drawn from the included entitlement, not added to it.
- **Standard's HQ behaviour is therefore not ambiguous:** Standard *may use* its
  single HQ Unit, and *may not buy more* — which is why Decision 2 lists its HQ
  package as unavailable. "No HQ package" is not "no HQ".

### The recovery-budget denominator — decision gate CLOSED

**Purchased additional user seats do not increase the internal service-recovery
budget.** The denominator is the **base plan's** included-user slots, so the
budget is 3 / 10 / 30 per organization per renewal period, and it does not vary
with active users, purchased seats, purchased Units or temporary membership
changes. The full rule, and why, is ADR-0052 Decision 5.

## Decision 1A — Contract term, billing cadence and annual prepayment

### Standard and Premium (self-service)

| Property | Value |
| --- | --- |
| Contract period | **1 month** |
| Billing | **monthly recurring, through Stripe** |
| Renewal | **automatic, monthly** |
| Minimum commitment | **none** — no 12-month minimum |
| Annual prepayment | **not offered in the initial release** |
| Annual-prepayment discount | **none** — no standard 5% |

### Enterprise and sales-assisted

- contract terms are **individually agreed**;
- the normal/default sales proposal **may** be a 12-month contract;
- payment cadence is **individually agreed**;
- discounts are **individually approved contractual terms**.

**There is no platform-wide rule that annual prepayment automatically receives
5%, or any other fixed percentage.** A discount is something a contract grants,
not something the catalog promises.

### Implementation delta — the runtime pricing code disagrees

`packages/domain/src/pricing/customer-plan-catalog.ts` currently defines
`CONTRACT_MONTHS = 12` and `ANNUAL_PREPAYMENT_DISCOUNT_BPS = bps(500)` (5%), and
`customer-pricing.ts:annualContractRawPricing` computes a 12-month gross and a
prepayment price from them.

**That code is not authoritative commercial policy.** It encodes an assumption —
every plan is a 12-month contract with a standard 5% prepayment discount — that
this decision replaces for Standard and Premium, and reduces to an
individually-negotiated case for Enterprise.

**This ADR is the authority. The code is a delta to reconcile.** It is
deliberately **not changed in this documentation work package**, and must be
reconciled in a future runtime work package **before commercial billing is
activated**. It is recorded as an open implementation delta in
`docs/decisions/TODO.md`. Until then, no caller may treat those constants as a
statement of what a Standard or Premium customer has agreed to.

## Decision 2 — Additional Unit packages

Pricing rule:

- Normal additional Unit package: base plan per-Unit price **× 1.20**
- HQ additional Unit package: base plan per-Unit price **× 1.50**

Round to the nearest ¥100, but **never round in a way that creates a loss**.

Approved package values:

| Plan | Normal package | HQ package |
| --- | --- | --- |
| Standard | +5 Units = ¥19,900 | **unavailable** |
| Premium | +10 Units = ¥35,900 | +2 Units = ¥9,000 |
| Enterprise | +25 Units = ¥89,400 | +5 Units = ¥22,400 |

Rules:

- **No automatic overage charge.**
- **Customer approval is required** to purchase additional Units.
- Additional packages **do not carry over**.
- Base Units and added Units are **renewal-period based**.

### Additional Units are quality-locked

**Decision gate CLOSED.** An additional Unit carries the quality of the package
it was bought in, and **there is no cross-quality fallback or conversion:**

- a **Normal** add-on Unit is **Normal-only** and cannot fund an HQ generation;
- an **HQ** add-on Unit is **HQ-only** and cannot fund a Normal generation.

**Nothing creates fungibility** — not the price difference, not expiry pressure
on a block about to lapse, not customer preference. The two prices exist because
the two outputs cost different amounts; a pool that could be spent either way
would make the ×1.50 package pointless.

A consequence worth stating plainly: because **Standard cannot purchase HQ
add-on Units**, once a Standard organization has used its single included HQ
entitlement it has **no route to further HQ output** in that period. Its Normal
add-on Units are not eligible, and **must not be reinterpreted as generic
Units.** There is no automatic conversion, exchange, refund or package
substitution.

## Decision 3 — Unit consumption order and period binding

Consumption order:

**Decision gate CLOSED.** The order is **eligibility-first**, not an
unconditional `base → oldest added → newest added` sweep across every block:

```text
ELIGIBILITY FIRST
→ BASE where eligible
→ OLDEST ELIGIBLE ADD-ON
→ NEWEST ELIGIBLE ADD-ON
```

**A Normal request draws from:**

1. an eligible remaining **Base Unit**;
2. the **oldest unexpired Normal** add-on block;
3. the next-oldest Normal add-on block;
4. and so on, oldest → newest **within Normal add-ons**.

**HQ add-on blocks are ineligible for a Normal request and are skipped.**

**An HQ request draws from:**

1. an eligible remaining **Base Unit**, *provided the plan's included HQ ceiling
   remains*;
2. the **oldest unexpired HQ** add-on block;
3. the next-oldest HQ add-on block;
4. and so on, oldest → newest **within HQ add-ons**.

**Normal add-on blocks are ineligible for an HQ request and are skipped.**

**Skipping an ineligible quality block is not a FIFO violation.** FIFO applies
*within* the eligible add-on class, and only there. A block the request may not
spend was never in the queue for that request.

### Base Units and the included HQ ceiling

Base Units are the plan's included pool. HQ may draw on a Base Unit only while
**both** hold:

1. an included Base Unit remains available, **and**
2. the plan's included HQ ceiling is not yet exhausted.

The approved ceilings are **Standard 1, Premium 5, Enterprise 10** (Decision 1),
and they sit **inside** the included Base Unit pool — never as an extra pool.

Worked example. A Standard organization has 15 included Base Units and an HQ
ceiling of 1. After one included HQ generation has consumed a Base Unit, the
remaining Base Units **may still fund Normal generation** but **cannot fund
another HQ generation** through the included entitlement. Standard cannot buy HQ
add-on Units, so there is no further HQ route that period.

### Three cases stated explicitly

| Customer holds | Requests | Result |
| --- | --- | --- |
| Premium: older **Normal** block, newer **HQ** block | **HQ** | eligible Base Unit if the HQ base entitlement remains; otherwise the **HQ block**. **Never the older Normal block.** |
| Premium: older **HQ** block, newer **Normal** block | **Normal** | eligible Base Unit if available; otherwise the **Normal block**. **Never the older HQ block.** |
| Standard: included HQ ceiling exhausted, Normal add-ons remaining | **HQ** | **Not fundable.** Normal add-ons are not eligible for HQ and must not be reinterpreted as generic Units. |

A generation belongs to the entitlement/billing period in which its
**reservation/start** occurred, even if completion crosses the renewal boundary.
This matches the already-implemented behaviour: the billing cycle is frozen on
the reservation and never recomputed.

**Once a paid Provider request has been submitted, customer cancellation is
unavailable.** The spend has already left the platform.

What consumes a Unit, and what does not, is ADR-0052 Decision 4. In particular a
moderation-blocked request consumes none, and a permanently failed generation
consumes none and has its reservation released (ADR-0052 Decision 19).

## Decision 3A — Subscription cancellation and refund

For **Standard and Premium self-service** subscriptions:

- the customer may **request cancellation at any time** — by a holder of
  `billing.manage` (Decision 5A);
- cancellation takes effect at the **end of the current billing period**;
- service remains available through the paid period;
- **no prorated subscription refund**;
- **unused base Units are not refunded**;
- **unused purchased additional Units are not refunded** merely because the
  customer cancels;
- **customer-choice cancellation is not a refund event**;
- a **technically valid delivered video is not refundable** merely because the
  customer dislikes it.

**This is not a blanket no-refund clause.** A refund is owed, and must remain
possible, for:

- duplicate billing;
- incorrect billing caused by VTaVision;
- any other billing error attributable to VTaVision;
- **any refund legally required**;
- any separately applicable contractual remedy.

Nothing here overrides mandatory law or excuses VTaVision's own billing errors.

**Enterprise cancellation and refund follow the individually executed Enterprise
contract**, not this clause.

## Decision 3B — Plan upgrade and downgrade

Self-service **Standard ↔ Premium** plan changes, each requiring
`billing.manage` (Decision 5A).

### Upgrade — immediate

- effective **immediately**;
- charge the **full difference** between the current plan's monthly price and the
  new plan's monthly price for the current billing period;
- **do not prorate** that difference;
- the next renewal uses the new plan's normal monthly price.

**Base Units are replaced by the new plan's period ceiling, not stacked.**

```text
Standard base Units                 15
Base Units consumed this period     10
upgrade to Premium (40 base Units)
remaining base Units  = 40 - 10  =  30
```

Only **Base** Units consumed this period reduce the new ceiling. Units drawn
from purchased add-on blocks were consumed from those blocks, which keep their
own entitlement (below); counting them against the new Base ceiling as well
would charge one consumption to two entitlements. So with 15 Base and 2 add-on
Units consumed, the upgrade leaves `40 - 15 = 25` Base Units plus the add-on
block's remaining 3.

Not `15 + 40`, and not 45 or 55 through double-granting. The customer moves to a
larger ceiling for the same period; they do not receive a second allowance.

An upgrade immediately raises the applicable base-Unit ceiling, storage quota,
concurrent-Job limit, included-user limit and other approved plan entitlements.

**Previously purchased additional Units remain valid through their original
entitlement period** — an upgrade does not void them and does not extend them.

### Downgrade — at renewal, and only once membership fits

**A plan downgrade never takes effect during the current paid period.**

- it may be requested and scheduled during the current period;
- it takes effect **only at the next billing renewal**; until then the current
  plan and all its entitlements stay in force;
- **no current-period refund and no proration**;
- **no automatic deletion** of stored content;
- the next renewal uses the downgraded plan's limits.

If storage exceeds the downgraded quota after renewal: keep existing data, block
new uploads and generation under the existing quota rule (Decision 4), and keep
preview, download and delete available.

**Membership must fit before the downgrade can be scheduled — decision gate
CLOSED.** A downgrade must never create an over-capacity membership state.
Current membership must fit within the **next-period entitlement**: the target
plan's included users plus the additional seats that will remain active next
period.

```text
Premium → Standard
Standard included users                      3
additional seats remaining next period       5
next-period entitlement                      8
current members                             10
→ warn: 2 users must be removed before the downgrade can proceed
→ the downgrade cannot be scheduled while membership is 10
→ once membership is 8 or fewer, it may be scheduled for the next renewal
```

If membership exceeds the next-period entitlement:

- show a clear warning to the person managing the downgrade, stating that users
  must be removed before the plan change can proceed;
- **do not** select, delete or deactivate users on the organization's behalf;
- **do not** automatically purchase seats;
- **do not** apply or schedule the downgrade while the organization is over
  capacity.

**While a downgrade is pending**, the next-period membership entitlement is
recorded, and any member addition or invitation that would exceed it is blocked;
the UI must make clear that the lower next-period limit is the reason. Otherwise
the current paid plan governs access until renewal. Cancelling or changing the
scheduled downgrade recalculates the next-period capacity. Exact UI wording is
not fixed here. Because scheduling required fit and growth past it is blocked,
renewal cannot arrive over capacity.

**Enterprise upgrades and downgrades, and any transition to or from Enterprise,
are sales-assisted contractual changes**, not self-service automatic ones.

## Decision 4 — Storage quotas and additional storage

| Plan | Storage |
| --- | --- |
| Standard | 50 GB |
| Premium | 200 GB |
| Enterprise | 500 GB |

What counts toward the quota, and what does not, is ADR-0052 Decision 17.

Quota behaviour:

| Usage | Behaviour |
| --- | --- |
| 80% | warn OWNER/ADMIN |
| 90% | stronger warning, and warn creators |
| 100% | block new uploads and generation |

At 100%, existing preview / download / delete remain possible.

**No automatic deletion. No automatic storage-overage charge.**

Additional storage — **PROVISIONAL**:

```text
+50 GB = ¥1,500 / month, tax-exclusive
```

Organization-level. The add-on **is initial-release scope**; only its price is
provisional.

- purchase and cancellation require **`billing.manage`** — `OWNER`/`BILLING` by
  default (Decision 5A; this supersedes the earlier "OWNER/ADMIN purchase and
  cancel");
- usable **immediately** on purchase, with a **prorated first period** and the
  full monthly price from the next renewal (Decision 5A);
- cancellation takes effect at the **next renewal**, with no prorated refund;
- no automatic purchase and no automatic overage charge;
- if cancellation puts current usage over quota, existing data remains and new
  upload/generation is blocked until usage is reduced or storage is repurchased.

**Open gate — quantity.** Whether the add-on is a single optional +50 GB
entitlement or a repeatable +50 GB block an organization may hold several of —
and so whether a cancellation removes one block or all added capacity — is **not
decided**. Tracked in `docs/decisions/TODO.md`.

**This price is explicitly provisional and must be validated against production
cost and egress economics before Commercial Launch.** It is recorded as an open
gate, not as settled pricing.

## Decision 5 — Billing and payment channels

| Contract path | Payment |
| --- | --- |
| Web self-service | Stripe credit card |
| Sales-assisted | invoice + bank transfer |

For credit-card payment, **Stripe/payment-processing fees are borne by VTaVision
as a business cost.** Do not add a card surcharge to the customer solely to
reimburse Stripe fees.

Payment-processing cost **must be included in profitability / Safety Guard
analysis** (ADR-0054).

**Stripe is a payment processor, not the pricing authority, and not the only
possible commercial contract record.** Sales-assisted customers must be
representable without a Stripe subscription object. The authoritative
selling-price catalog belongs inside VTaVision's own commercial model.

## Decision 5A — Authority for commercial mutations

**Decision gate CLOSED.** One rule:

> **Any customer action that changes what the organization is charged requires
> `billing.manage`.**

Under the default role matrix (ADR-0052 Decision 10) that means **`OWNER` and
`BILLING`**. **`ADMIN` does not hold `billing.manage`** and is not authorized for
these actions merely because it manages operational content and users. `ADMIN`
may still *view* billing where it holds `billing.view`; viewing authorizes no
mutation.

**The rule is capability-based, not role-based.** What authorizes a commercial
mutation is holding `billing.manage`, not the role name. Granting it is
`OWNER`-only protected authority (ADR-0052 Decision 10), and no approved decision
restricts which individual an `OWNER` may grant it to — so an `ADMIN` to whom an
`OWNER` has **explicitly** granted `billing.manage` may perform these actions,
exactly as any other holder may. What is excluded is an `ADMIN` acting on its
role alone, or acquiring the permission by any route an `OWNER` did not take: the
grant ceiling and self-escalation rules already forbid that. Any such holder is
also mandatory-MFA under the existing capability rule.

It applies to at least:

- purchasing additional Unit packages;
- purchasing or cancelling additional user seats;
- purchasing or cancelling the storage add-on (superseding the earlier
  "OWNER/ADMIN purchase and cancel" in Decision 4);
- Standard/Premium self-service plan upgrade and downgrade;
- Standard/Premium subscription cancellation;
- any other self-service action that alters a recurring or one-time charge.

**Member management is not seat purchase.** `ADMIN` may manage users within
already-purchased capacity, as the authorization model permits. When no seat
entitlement remains, nothing is auto-purchased and no member-management action
creates a charge: a holder of `billing.manage` must explicitly purchase an
additional seat, after which ordinary user management proceeds.

### Additional-seat cancellation

**Decision gate CLOSED.** Requesting it requires `billing.manage`, like every
other commercial mutation. For Standard/Premium self-service:

- **Timing.** A seat cancellation takes effect at the **next billing renewal**,
  never immediately.
- **No proration.** No prorated refund or credit is issued for the current
  period. Members already occupying the paid seats stay active until the period
  ends.
- **Precondition.** A reduction may be **scheduled only if current membership
  already fits within the post-cancellation entitlement** (included users plus
  the remaining additional seats).

  ```text
  Premium: 10 included + 3 additional = 13 seats; 12 current members
  cancel 2 additional seats → next-period entitlement 10 + 1 = 11
  12 > 11 → the reduction cannot be scheduled yet
  ```

  The organization must first bring membership to 11 or fewer; then the
  reduction may be scheduled. The system never chooses, deletes or deactivates
  members to make room, and never repurchases seats.
- **While a reduction is pending**, existing members stay active through the
  current paid period, but any member addition or invitation that would make
  membership exceed the **next-period** entitlement is blocked. **Scheduling a
  reduction therefore gives up any unused paid capacity above the next-period
  entitlement for the rest of the period**, without refund — e.g. Premium with
  8 members and 3 additional seats may schedule cancelling all 3, but may then
  grow only to 10, not 13. Cancelling or changing the scheduled reduction
  restores it. The UI explains
  that a scheduled seat reduction limits member growth until renewal or until
  the reduction is cancelled or changed. Exact wording is not fixed here.
- **At renewal**, the paid additional-seat quantity becomes the scheduled reduced
  quantity and billing uses it; no proration credit is issued for the previous
  period; no member is removed. Because the reduction could only be scheduled
  when membership already fitted, and growth past it was blocked meanwhile, the
  organization enters the new period within entitlement. Any concurrent change
  that would breach the committed next-period capacity is refused rather than
  allowed to create an over-capacity state.

#### Mid-period purchase of a seat or the storage add-on

**Decision gate CLOSED.** Both follow one shape:

```text
IMMEDIATE USE + PRORATED FIRST PERIOD + FULL MONTHLY PRICE FROM NEXT RENEWAL
```

- an explicitly purchased **additional seat** (¥3,000 / user / month,
  tax-exclusive) or **+50 GB storage add-on** (¥1,500 / month, tax-exclusive,
  price provisional per Decision 4) is **usable immediately**;
- the **first charge is prorated** for the remaining portion of the current
  billing period;
- from the **next renewal**, the normal full monthly price applies;
- purchase requires `billing.manage`; nothing is purchased automatically, and no
  member-management or upload action creates a charge;
- there is no automatic storage-overage billing.

Cancellation stays as already decided — at the next renewal, with no prorated
refund — so proration applies to the first period of a purchase only, never to a
cancellation. The proration calculation method (day basis, rounding) is an
implementation detail of the billing integration and is not fixed here.

A seat cancellation is **not** user deletion, and never triggers it. This rule
matches the other renewal-effective changes — subscription cancellation
(Decision 3A), plan downgrade (Decision 3B) and storage add-on cancellation
(Decision 4) — and the no-automatic-purchase rule. **Enterprise** seat changes
follow the executed Enterprise contract instead.

**Storage limit.** At the limit nothing is auto-purchased and no upload or
member-management action creates a charge implicitly; a `billing.manage` holder
may explicitly purchase or cancel the storage add-on.

**Enterprise.** Commercial changes remain sales-assisted and contract-governed.
`OWNER`/`BILLING` may initiate or request a change where the product supports it,
but the application must **not** assume a self-service action changes an
Enterprise contract amount; the executed contract, quotation and approval process
govern.

**Not a billing action.** Unrelated high-risk ownership operations — organization
deletion, for example — stay governed by the authorization and ownership contract
(ADR-0052 Decision 10), not by `billing.manage` alone.

## Decision 6 — SLA

**Standard and Premium:** no contractual uptime SLA initially. An internal SLO
target of 99.9% may be tracked.

**Enterprise:** target contractual monthly uptime SLA **99.9%**, applying to
VTaVision-controlled web/API/service availability, and **excluding** properly
defined events such as upstream AI Provider availability and processing time,
planned maintenance, customer environment, and force majeure where legally
appropriate.

Service-credit model:

| Measured monthly uptime | Credit |
| --- | --- |
| 99.0% to < 99.9% | 10% of applicable monthly fee |
| 95.0% to < 99.0% | 25% |
| < 95.0% | 50% |

Maximum credit: the applicable monthly fee. **Service Credit, not automatic cash
refund.** A customer claim/validation workflow is acceptable.

**No fixed AI generation completion-time SLA for the initial release.** Generation
time depends on an upstream provider and is tracked separately from platform
availability.

Closed Beta carries **no formal commercial SLA**. The contractual Enterprise SLA
begins only after production measurement and legal/commercial approval.

Design documentation may describe how Cloud Monitoring / observability supports
measurement, exclusion accounting, monthly calculation and service-credit
determination.

## Decision 7 — Legal retention

| Record | Retention |
| --- | --- |
| Billing / invoices / Unit transaction records | 10 years |
| Mode C and comparable legal Consent evidence | 10 years |
| Audit logs | 7 years |
| Legal Hold | retention extends until the hold is released |

**Deleting a user does not delete legally retained Billing / Audit / Consent
evidence** (ADR-0052 Decision 11).

Where possible, retain immutable internal IDs rather than unnecessary personal
data once identity details are no longer required.

## Decision 8 — Commercial use and the responsibility boundary

VTaVision is a **video-generation and delivery service**. It does not
automatically externally publish customer videos (ADR-0052 Decision 2).

**The customer is responsible for the final decision to externally publish or
commercially use generated content**, including:

- holding rights to source materials;
- accuracy of the property/source information they provide;
- reviewing the generated content before external use;
- deciding whether to use it commercially;
- compliance with applicable law;
- real-estate advertising rules;
- industry rules;
- destination-platform rules;
- third-party publication/distribution choices.

VTaVision must **not** claim that a generated video is guaranteed legally
compliant for every external commercial use, and must **not** become the
customer's advertising-law approval authority.

**This is not a blanket exemption.** VTaVision remains responsible for its own
contractual and legal duties, including appropriate service operation,
customer-data handling and security obligations, and liabilities that cannot or
should not lawfully be excluded — including intentional misconduct and gross
negligence as applicable.

**Commercial Launch requires legal review by counsel familiar with Japanese
IT/SaaS and real-estate advertising.** The purpose of that review is to validate
the responsibility boundary — *not* to turn VTaVision into an external-publication
approver.

## Decision 9 — Legal documents, versioning and subprocessors

Commercial Launch documentation must cover: Terms of Service; Privacy Policy;
Mode C consent language; the customer/VTaVision responsibility boundary;
pricing/Unit/refund rules; SLA; retention and deletion; IP and source-material
warranties; applicable subprocessors.

Subprocessors to be documented appropriately include Google Cloud, Stripe, the
active AI Provider(s), email-delivery vendors, and any other material
customer-data processors.

There must be a formal way to **publish and update** a subprocessor list.

Terms / Privacy / Consent documents must be **versioned** where appropriate, and
consent evidence must make it possible to determine **who accepted which version
and when**.

## Decision 10 — Security and procurement review support

Responding to an ordinary customer security questionnaire is **not** chargeable.
Standard security material and ordinary security/procurement questionnaire
response: **no additional charge.**

Where a request materially exceeds ordinary SaaS due diligence — extensive bespoke
documentation, unusual audit work, on-site work, substantial custom professional
effort — treat it as **Professional Services**.

Professional Services baseline: **from ¥50,000 per engagement, tax-exclusive,
individually quoted.**

## Decision 11 — Onboarding and support

| Path | Onboarding |
| --- | --- |
| Web contract | self-service |
| Sales-assisted | contract → invoice/bank transfer → commercial activation confirmation → Organization provisioning → OWNER invitation → assisted onboarding as required |

Suggested self-service flow: plan selection → Stripe payment → Organization
creation → OWNER creation → email verification/MFA → organization/company setup →
logo → invite members → first property/project.

Support is **fundamentally online** for all plans:

| Plan | Support |
| --- | --- |
| Standard | self-service onboarding + normal online support |
| Premium | online support + one initial online onboarding/explanation session |
| Enterprise | assisted onboarding + administrator guidance + priority online support |
| Closed Beta | hands-on online onboarding/support for all companies |

### Staffed support hours and initial-response targets

**Decision gate CLOSED.** Support is fundamentally online. Staffed hours:

```text
Weekdays 10:00–18:00 JST
```

Excluded: Saturdays, Sundays, Japanese public holidays, and the designated
year-end / New Year closure.

**Customers may submit inquiries 24 hours a day**, but the response clock runs in
staffed support hours and business days.

| Plan | Initial-response target |
| --- | --- |
| Standard | within **2 business days** |
| Premium | within **1 business day** |
| Enterprise | within **4 staffed support hours** |
| Closed Beta | within **1 business day** |

**"Initial response" means acknowledgement, context review and next-action
guidance. It is not a promise that the issue will be resolved in that period.**

**These are support targets / SLOs, not contractual uptime SLA service credits.**
The Enterprise uptime credit schedule in Decision 6 **must not** be attached to
support response time: they measure different things, and conflating them would
turn a slow reply into a refund claim.

**No 24/7 staffed telephone support** is promised, now or by implication.

Sev1 monitoring and incident response may operate outside staffed support hours.
**That must not be described to customers as 24/7 staffed support** — watching
for incidents is not the same as answering inquiries.

## Decision 12 — Closed Beta and commercial-launch gates

Closed Beta target: **3–5 real-estate companies.**

Commercial-launch evaluation must include at least:

- 3 companies actively using the system
- 30+ real properties
- 100+ completed videos
- technically valid Deliverable success rate **≥ 98%**, including bounded
  recovery as defined by product policy
- erroneous/double Unit consumption = **0**
- blind retry that can produce duplicate Provider charging = **0**
- cross-tenant data exposure = **0**
- Sev1 incidents = **0**
- loss-making Jobs under the Safety Guard definition = **0**
- manual operator intervention target **< 5%**
- the core customer generation flow can be completed **without support**

**Customer aesthetic satisfaction is useful product feedback but is not a
mandatory technical launch-success criterion** (ADR-0052 Decision 1).

Track as product metrics: download/use behaviour, customer-regeneration rate,
funnel abandonment / UX confusion, operator intervention.

**Zero-tolerance gates are not negotiable against percentages.** Tenant isolation
failure and double billing are launch blockers even if every percentage KPI is
met.

---

## Consequences

The commercial model is now stated once, in numbers, so Safety Guard work
(ADR-0054) has a selling-price side to compare cost against, and so plan
definitions stop being an open TODO.

**Accepted cost.** VTaVision absorbs Stripe fees rather than surcharging. That is
a deliberate margin decision and it makes payment cost a mandatory input to the
profitability guard rather than a pass-through.

**Accepted cost.** The Enterprise SLA excludes upstream provider availability.
A customer whose generation is slow because the provider is slow has no credit
claim, which is honest about what VTaVision controls — and is why no generation
completion-time SLA is offered at all initially.

**Explicitly provisional.** Additional-storage pricing (¥1,500 / +50 GB) is
approved only as a working figure and must be validated against measured
production storage and egress cost before Commercial Launch.

**Accepted cost.** A one-month Standard/Premium term with no minimum commitment
and no prepayment discount means no contracted revenue floor and monthly churn
exposure, in exchange for a self-service funnel nobody has to be sold into. It
also means the runtime pricing code is wrong about those plans until a future
work package reconciles it — recorded as an implementation delta rather than
quietly code-changed here.

**Accepted cost.** Upgrading charges the full monthly price difference without
proration, so a customer upgrading on the 28th pays the same difference as one
upgrading on the 2nd. The Unit ceiling they gain is also the full one. Proration
on both sides would be fairer and considerably more machinery; this is the simple
rule, stated plainly so it can be disclosed rather than discovered.

**Accepted cost.** Downgrade-at-renewal with no refund means a customer who
downgrades early keeps paying the higher price to the period end, and requiring
membership to fit first means some customers must remove users before they can
downgrade at all. The alternative
— immediate downgrade with a credit — would let a customer consume a Premium
allowance and then pay Standard for it.

**Accepted cost.** Purchases are prorated but cancellations are not. That
asymmetry is deliberate: a customer buying capacity mid-period pays only for what
they can use, while a cancellation never generates a refund for capacity already
paid for.

**Accepted cost.** Support targets are business-hours only, so an Enterprise
customer reporting a non-Sev1 problem on Friday evening may wait until Monday.
Promising faster would mean staffing VTaVision does not have.

**Accepted cost.** Quality-locked add-on Units will sometimes leave a customer
holding Units they cannot spend on what they want — a Standard organization with
Normal add-ons and no remaining HQ entitlement most visibly. Fungibility would be
friendlier and would also make the ×1.50 HQ package pointless, since every HQ
generation could be funded at the ×1.20 price. The lock is what makes the two
prices mean anything, so the cost is disclosure: the constraint must be legible
before purchase, not discovered at generation time.

**Not decided here.** No minimum gross-margin percentage is fixed — see ADR-0054
Decision 3. Final legal wording for Terms, Privacy and Mode C consent is counsel's
to produce; this ADR records required meaning only.
