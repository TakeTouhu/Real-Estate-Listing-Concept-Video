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
- a **technically valid delivered video consumes the Unit** regardless of whether
  the customer likes, downloads or uses it (ADR-0052 Decision 4),
- release the Unit where the generation must not consume one: moderation block,
  and recovery-budget exhaustion,
- **no automatic overage charge** — customer approval is required to buy Units,
- consumption order is base Units → oldest added Units → newest added Units,
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

### Internal service-recovery budget

`recovery budget = plan maximum user limit × 1`, per organization per renewal
period, based on plan user **slots**, shared organization-wide, and **never
exposed to customers** (ADR-0052 Decision 5). On exhaustion: stop automatic
recovery, do not auto-charge another Unit, release the reserved Unit, escalate
internally; an authorized operator may grant one manual free recovery.

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

## Storage operations

Production object storage is **Google Cloud Storage**, behind the existing
provider-neutral `ObjectStorage` port. The domain must not depend on Google Cloud
SDK types (ADR-0054 Decision 1).

Retention (ADR-0052 Decision 17): source and normalized images while the
property/project exists; scene videos 30 days after final completion;
composition temp files immediately; current final video until the customer
deletes it; old final versions 30 days; customer-deleted content 30-day trash
then physical deletion; Audit/Billing/Consent on the separate legal lifecycle.

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
support; Closed Beta receives hands-on online onboarding. **No 24/7 telephone
support** unless separately approved.

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