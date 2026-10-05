# ADR-0053 — Initial-release commercial contract

Status: Accepted (CTO decision, pre-Commercial-Launch)
Scope: plans, pricing, Unit accounting, storage quotas, payment channels, SLA,
legal retention, responsibility boundary, support, launch gates.

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

Additional user: **¥3,000 / user / month**, tax-exclusive.

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

### Open gate — the recovery-budget denominator

ADR-0052 Decision 5 sizes the internal service-recovery budget as `plan maximum
user limit × 1`, from **plan slots rather than active users**. The included-user
values above give that formula its baseline: 3, 10, 30.

**Whether purchased additional seats raise that denominator is not decided here.**
Deciding it would change how much VTaVision spends absorbing its own failures,
which is a cost decision and not a documentation one. It is recorded as an open
gate in `docs/decisions/TODO.md`. Until it is answered, do not implement either
reading as though it were settled.

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

## Decision 3 — Unit consumption order and period binding

Consumption order:

```text
base Units → oldest added Units → newest added Units
```

A generation belongs to the entitlement/billing period in which its
**reservation/start** occurred, even if completion crosses the renewal boundary.
This matches the already-implemented behaviour: the billing cycle is frozen on
the reservation and never recomputed.

**Once a paid Provider request has been submitted, customer cancellation is
unavailable.** The spend has already left the platform.

What consumes a Unit, and what does not, is ADR-0052 Decision 4. In particular a
moderation-blocked request consumes none, and an exhausted-recovery-budget
failure consumes none.

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

Organization-level; OWNER/ADMIN purchase and cancel; no auto-overage;
cancellation effective at renewal. If cancellation puts current usage over quota,
existing data remains and new upload/generation is blocked until usage is reduced
or storage is repurchased.

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

**No 24/7 telephone support** unless separately approved later. This ADR does not
invent support hours beyond the above.

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

**Not decided here.** No minimum gross-margin percentage is fixed — see ADR-0054
Decision 3. Final legal wording for Terms, Privacy and Mode C consent is counsel's
to produce; this ADR records required meaning only.
