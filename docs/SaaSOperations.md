# SaaS Operations

Version: 2.0
Status: Approved initial-release contract (pre-Commercial-Launch)

Authority: ADR-0052, ADR-0053, ADR-0054. Where this document and an ADR
disagree, the ADR governs. **Paid Provider Activation and production scheduler
activation remain BLOCKED** (ADR-0054 Decision 7).

## Operating model

Operate the service as a commercial multi-tenant SaaS with separate development, staging, and production environments. Production access follows least privilege and all privileged actions are audited.

## Plans and billing

The product sells **Units**. "Credits" in v1.0 documents and older code comments
refers to the same entitlement concept.

| Plan | Monthly (tax-excl.) | Units | Storage | Concurrent Jobs |
| --- | --- | --- | --- | --- |
| Standard | ¥49,800 | 15 | 50 GB | 1 |
| Premium | ¥119,800 | 40 | 200 GB | 3 |
| Enterprise | ¥298,000 | 100 | 500 GB | 5 |

Additional user: ¥3,000/user/month, tax-exclusive. **Buying users does not add
Units.** Unit packages, rounding rules and storage add-ons are in ADR-0053.

Billing rules:

- show estimated Unit use before generation,
- reserve the Unit transactionally before the generation row is created (there is
  no enqueue step — ADR-0024),
- settle exactly once after terminal outcome — Phase 5C's Transaction G is the
  only writer of `consumedAt`,
- a **technically valid delivered generation or paid regeneration consumes its
  reserved Unit** (free recompositions reserve none) regardless of whether
  the customer likes, downloads or uses it (ADR-0052 Decision 4),
- release the Unit where the generation must not consume one: moderation block,
  recovery-budget exhaustion, and **any permanent technical failure that
  delivered no technically valid Deliverable** (ADR-0052 Decision 19) — a
  reservation may never remain pending indefinitely,
- **no automatic overage charge** — customer approval is required to buy Units,
- consumption order is **eligibility-first**: eligible Base Unit → oldest
  eligible add-on block → newest eligible add-on block. **Add-on Units are
  quality-locked** — a Normal add-on cannot fund HQ and an HQ add-on cannot fund
  Normal, so an ineligible-quality block is **skipped, which is not a FIFO
  violation** (FIFO applies within the eligible class). HQ may draw a Base Unit
  only while the plan's included HQ ceiling (1 / 5 / 10, inside the Base pool)
  remains. Full rules and worked cases: ADR-0053 Decisions 2 and 3,
- a generation belongs to the period of its **reservation**, even if completion
  crosses the renewal boundary,
- **cancellation is unavailable once a paid Provider request has been submitted**,
- record estimated platform cost, estimated provider cost, and actual provider
  cost,
- make Stripe webhooks idempotent and replay-safe,
- **Stripe is a payment processor, not the pricing authority**, and sales-assisted
  contracts must be representable without a Stripe subscription object,
- Stripe fees are borne by VTaVision — **no card surcharge** — and must be
  included in Safety Guard analysis.

### Contract term, billing cadence and plan changes

| | Standard / Premium (self-service) | Enterprise / sales-assisted |
| --- | --- | --- |
| Contract period | **1 month**, auto-renewing | individually agreed (a 12-month proposal is the normal default) |
| Billing | monthly recurring via Stripe | individually agreed; invoice + bank transfer |
| Minimum commitment | **none** | contractual |
| Annual prepayment / discount | **not offered** | individually approved contract terms only |

**There is no platform-wide annual-prepayment discount** (ADR-0053 Decision 1A).
**Every charge-changing customer action requires `billing.manage`** —
`OWNER`/`BILLING` by default; an `ADMIN` only if an `OWNER` has explicitly granted
it `billing.manage` (ADR-0053 Decision 5A). That covers
Unit packages, seats, the storage add-on, upgrade, downgrade and cancellation.
**Seat cancellation** takes effect at the next renewal with no proration, can be
scheduled only when current membership already fits the reduced entitlement,
and blocks member growth past that entitlement while pending (ADR-0053
Decision 5A). Member management never buys a seat, reaching a limit never buys
anything, and
Enterprise changes stay sales-assisted.

Note the open **implementation delta**: the runtime pricing code still assumes a
12-month contract and a 5% prepayment discount for every plan. ADR-0053 is
authoritative; the code must be reconciled before commercial billing is
activated.

**Cancellation (Standard/Premium):** requestable any time, effective at the end
of the paid period, service continues until then, no prorated refund, unused base
and purchased Units are not refunded. Customer-choice cancellation is not a
refund event, and a technically valid delivered video is not refundable because
the customer dislikes it. **Refunds remain owed for duplicate billing, billing
errors attributable to VTaVision, legally required refunds and applicable
contractual remedies** (ADR-0053 Decision 3A). Enterprise follows its own
contract.

**Upgrade:** immediate; charge the **full, unprorated** monthly price difference
for the current period; base Units become the new plan's ceiling **minus Base Units already
consumed** (Standard 15 with 10 used → Premium gives 30 remaining, never 45 or
55); storage, concurrency and included-user limits rise immediately; previously
purchased additional Units keep their original entitlement period.

**Downgrade:** never effective in the current period — only at the **next
renewal**; no refund; no automatic content deletion. If storage then exceeds
quota, keep the data and block new upload/generation. **It can be scheduled only
once current membership fits** the target plan's included users plus the
additional seats remaining next period; otherwise the administrator is warned how
many users must be removed, and **no user is selected, deleted or deactivated and
no seat is bought**. While pending, member growth past that entitlement is
blocked (ADR-0053 Decision 3B).

**Mid-period purchases** of a seat or a +50 GB storage block are usable
immediately, with a prorated first charge and the full monthly price from the
next renewal (ADR-0053 Decision 5A). **Storage blocks are repeatable** up to the
plan cap — Standard 2 (150 GB total), Premium 5 (450 GB total); Enterprise is
contract-governed, not capped by a guessed constant — and a purchase that would
reach the next plan's base storage is **rejected**. Cancellation is per block at
renewal, never deleting data (ADR-0053 Decision 4). Enterprise transitions are
sales-assisted.

### Internal service-recovery budget

`recovery budget = base-plan included-user slots × 1` — **Standard 3, Premium 10,
Enterprise 30** — per organization per renewal period, shared organization-wide,
and **never exposed to customers** (ADR-0052 Decision 5). **Purchased additional
user seats do not increase it**, and it does not vary with active-user count,
purchased Units or temporary membership changes. On exhaustion: stop automatic
recovery, do not auto-charge another Unit, release the reserved Unit, escalate
internally; an authorized operator may grant one manual free recovery.

Recovery from a terminal technical failure is an internal operator action — see
*Support tooling and privileged access* below.

## Service-level objectives

**Standard and Premium carry no contractual uptime SLA initially**; 99.9% is an
internal SLO target. **Enterprise targets a contractual 99.9% monthly uptime SLA**
with a service-credit model (10% / 25% / 50%, capped at the monthly fee),
excluding upstream provider availability, planned maintenance, customer
environment and force majeure where legally appropriate. **No AI generation
completion-time SLA is offered.** Closed Beta has no formal commercial SLA.
Details in ADR-0053 Decision 6.

Initial targets:

- API availability: 99.9% internal SLO
- normal management-page response: p95 under 2 seconds
- successful generation admission (durable `QUEUED` row): p95 under 5 seconds
- upload-to-first-preview target: under 10 minutes under normal provider conditions
- no admitted generation lost — a durable `QUEUED` row is the acknowledgement,
  and it is discovered by state rather than delivered (ADR-0024)
- RPO and RTO documented per production tier

Provider generation time is tracked separately from platform processing time.

## Observability

Use structured logs, metrics, traces, and correlation IDs across web, API,
worker, the AI provider adapter, storage, FFmpeg, and billing. On Google Cloud
this is Cloud Logging, Cloud Monitoring and Google Cloud Observability, which
also supports SLA measurement, exclusion accounting, monthly calculation and
service-credit determination (ADR-0053 Decision 6).

Key metrics:

- active organizations and users
- uploads and storage usage
- queued/running/failed generations
- time a generation waits in `QUEUED` before a worker claims it
- provider latency and failure rate by model
- composition/validation failure rate
- retry and dead-letter counts
- generation cost and margin per output
- Unit reservation/settlement discrepancies
- customer-regeneration rate, disclosure-mode change rate
- internal recovery-budget consumption and exhaustion events
- download/use behaviour
- Safety Guard refusals and route substitutions

Sensitive values and signed URLs are redacted.

## Worker operations

There is no queue to operate: work is discovered by scanning for
`state = 'QUEUED'` (ADR-0024), so the concerns below belong to the worker and to
the row's own state, not to a transport.

- bounded concurrency by model and account limit
- exponential backoff with jitter
- stale in-flight recovery driven by the row's state and timestamps
- dead-letter state with support tooling
- idempotent scene and composition steps
- graceful shutdown and lease release
- provider circuit breaker during sustained failure
- configurable emergency pause for new generation submissions

## AI provider outage handling

During provider degradation:

1. stop or slow new provider submissions,
2. keep accepted jobs in a visible queued state,
3. do not consume the final Unit before successful settlement,
4. preserve completed scene clips,
5. display provider-delay messaging without exposing internal details,
6. resume safely using stored prediction references,
7. allow support-controlled cancellation and Unit release **only where no paid
   Provider request has already been submitted**.

Provider replacement is an operationally tested capability, not an automatic silent switch unless output and pricing compatibility are verified.

### Completion evidence

**Authenticated webhook for low latency, mandatory polling as the guarantee**
(ADR-0054 Decision 4). A webhook whose authenticity cannot be verified is not
authoritative completion evidence, and polling becomes the normal authoritative
path; an unauthenticated internet callback is never proof that a paid generation
completed. Polling runs even when webhooks work, because a missed or delayed
webhook is indistinguishable from a provider that never finished. Operator
evidence is break-glass only. All three normalize into the provider-neutral
reconciliation contract before any durable state change, and provider "success"
alone never consumes a Unit. Polling cadence and timeouts are live-evidence
values.

## Storage operations

Production object storage is **Google Cloud Storage**, behind the existing
provider-neutral `ObjectStorage` port. The domain must not depend on Google Cloud
SDK types (ADR-0054 Decision 1).

Retention (ADR-0052 Decision 17): source and normalized images while the
property/project exists; scene videos 30 days after final completion; the
internal overlay-free **Clean Master** with its content's lifecycle (outside
customer quota, never customer-downloadable); composition temp files promptly;
current final video until the customer-content lifecycle deletes it; old final
versions 30 days; customer-deleted content 30-day trash then physical deletion;
Audit/Billing/Consent on the separate legal lifecycle. The Clean Master is a
VTaVision storage cost, not something the storage add-on buys.

Quota thresholds: 80% warn OWNER/ADMIN, 90% stronger warning plus creators, 100%
block new uploads and generation while preview/download/delete still work. **No
automatic deletion and no automatic storage-overage charge.**

- private buckets
- lifecycle policies by asset type and plan
- short-lived signed URLs
- encryption at rest and in transit
- object checksums and metadata validation
- scheduled deletion with retry and reconciliation
- backup/restore for metadata; originals follow documented retention policy

## Deployment

- infrastructure as code
- immutable container builds
- automated migrations with rollback/forward-fix procedure
- CI gates: typecheck, lint, unit, integration, security scan, build
- staging smoke/E2E before production
- canary or controlled rollout for worker/provider changes
- feature flags for model capability and pricing changes

## Support tooling and privileged access

Support users can search by public request/job ID, view sanitized status history,
release a stuck Unit reservation, retry eligible steps, and cancel a job where no
paid Provider request has been submitted. An authorized operator may grant one
manual free recovery after the internal budget is exhausted.

**Normal support staff must not have unrestricted cross-tenant browsing, and
generic customer impersonation is not implemented** (ADR-0054 Decision 6).
Inspecting customer content requires explicit privileged support access with: the
target organization, the operator identity, a recorded business/support reason, a
time limit that auto-expires, full audit, and least privilege. Normally obtain
OWNER/ADMIN authorization first.

**Break-glass** access is for exceptional cases such as a Sev1 security incident
only: explicit reason, highly restricted, fully audited, post-event review, and
customer notification/assessment where appropriate. **Routine direct-database
tenant bypass is not an acceptable support process.**

Support-content access, billing mutation and permission mutation remain
**separate privileges**.

### Recovery from terminal technical failure

**Customers cannot unblock an internal technical failure.** Not `OWNER`, not
`ADMIN`. It is an internal VTaVision operator action under the privileged-access
rules above, and it is **a privilege separate from every customer role template**
and from support-content access, billing mutation and permission mutation.

- the original `BLOCKED` row and the original `INVALID_MEDIA` /
  `INTEGRITY_MISMATCH` verdict are **immutable** — terminal evidence is never
  mutated back into a retryable state;
- recovery creates a **new** recovery/composition cycle;
- audit at minimum: operator identity, organization, target Job / Deliverable /
  row, recovery reason, the original block or verdict cause, timestamp, and the
  resulting new recovery-cycle identifier;
- every existing invariant still applies: no blind Provider POST retry,
  reconciliation first for an ambiguous submission, the Safety Guard, provider
  activation rules, bounded recovery, and the tenant boundary.

**The mutation unit is the individual row.** A future tool may offer cause-based
bulk *selection*, but it must enumerate candidate rows, re-evaluate eligibility
per row, act transactionally / CAS-safely per row, and audit per row. **No global
"unblock this cause and automatically revert all rows" operation** (ADR-0052
Decision 20).

Share-link revocation is reserved for the post-release share feature and has no
initial-release surface.

## Onboarding and support tiers

| Path | Onboarding |
| --- | --- |
| Web self-service | plan selection → Stripe payment → Organization → OWNER → email verification/MFA → company setup → logo → invite members → first property |
| Sales-assisted | contract → invoice/bank transfer → activation confirmation → Organization provisioning → OWNER invitation → assisted onboarding |

Support is **fundamentally online** for all plans: Standard self-service plus
normal online support; Premium adds one initial online onboarding session;
Enterprise adds assisted onboarding, administrator guidance and priority online
support; Closed Beta receives hands-on online onboarding.

### Staffed hours and initial-response targets

```text
Weekdays 10:00–18:00 JST
```

Excluded: Saturdays, Sundays, Japanese public holidays, and the designated
year-end / New Year closure. **Inquiries may be submitted 24 hours a day**, but
the response clock runs in staffed hours and business days.

| Plan | Initial-response target |
| --- | --- |
| Standard | within 2 business days |
| Premium | within 1 business day |
| Enterprise | within **4 staffed support hours** |
| Closed Beta | within 1 business day |

"Initial response" means acknowledgement, context review and next-action
guidance — **not** resolution within that period.

**These are support SLOs, not SLA service credits.** The Enterprise uptime credit
schedule must never be attached to support response time. **No 24/7 staffed
telephone support** is promised. Sev1 monitoring and incident response may run
outside staffed hours, but **that must not be presented to customers as 24/7
staffed support** (ADR-0053 Decision 11).

Responding to an ordinary security/procurement questionnaire is **not
chargeable**. Work materially exceeding ordinary SaaS due diligence is
Professional Services, **from ¥50,000 per engagement, tax-exclusive,
individually quoted** (ADR-0053 Decision 10).

## Business continuity

Document backups, restore testing, secret rotation, AI provider outage handling,
stalled-generation recovery, database failure, storage failure, billing webhook
backlog, security incident, and customer communication procedures.

## Launch checklist

- production infrastructure and domains
- monitoring and alerting
- backups and restore test
- billing reconciliation test
- AI provider production credentials and spending controls — **BLOCKED pending
  explicit CTO authorization** (ADR-0054 Decision 7)
- production scheduler activation — **BLOCKED pending explicit CTO
  authorization**
- Cost Safety Guard operative before any paid submission
- commercial-use/data-processing review
- counsel-reviewed terms, privacy policy, Mode C consent wording, AI disclosure,
  responsibility boundary, and support policy
- published subprocessor list (Google Cloud, Stripe, active AI provider(s),
  email delivery, other material processors) with a formal update mechanism
- versioned Terms/Privacy/Consent documents, with evidence of who accepted which
  version and when
- incident contacts and on-call rota
- load and failure-recovery test
- first-customer onboarding and rollback plan