# ADR-0054 — Initial-release production platform, provider policy, and activation gates

Status: Accepted (CTO decision, pre-Commercial-Launch)
Scope: production cloud, object storage, AI provider policy, cost safety guard,
scheduler and retry invariants, reconciliation evidence sources, production
security operations, privileged support access, and the activation gates that
remain **BLOCKED**.

Supersedes, **for the initial production deployment choice only**, the
S3/Azure-oriented production-storage statements in `docs/SystemArchitecture.md`
v1.0, `docs/architecture.md` and the ADR-0008 follow-up TODO.

Does **not** supersede ADR-0008 or any other historical ADR as a historical
record. ADR-0008's *port* decision — storage behind an `ObjectStorage`
abstraction — is not merely preserved but is the reason this ADR can choose a
cloud at all.

Companion ADRs: ADR-0052 (product and delivery), ADR-0053 (commercial contract).

**This ADR is documentation. It activates nothing. See Decision 7.**

---

## Context

Phases 0–5C were built deliberately cloud-neutral and provider-neutral, and
deliberately dormant: no scheduler, no production credential, no paid provider
call. That left two questions open — *which* cloud, and *which* provider route —
and left a third unasked: what prevents the system from knowingly running a
generation at a loss once it is switched on.

This ADR answers the first two as decisions, the third as an invariant, and then
states explicitly that none of it is permission to switch anything on.

---

## Decision 1 — Production cloud is Google Cloud

Approved initial commercial production platform: **Google Cloud.**

Target services and concepts:

| Concern | Service |
| --- | --- |
| Web / API | Cloud Run |
| Asynchronous / FFmpeg workloads | Cloud Run Jobs, or suitable Cloud Run worker execution |
| Relational database | Cloud SQL for PostgreSQL |
| Durable media / object storage | Google Cloud Storage |
| Secrets | Secret Manager |
| Container images | Artifact Registry |
| Logs / metrics / traces | Cloud Logging, Cloud Monitoring, Google Cloud Observability |
| Scheduling | Cloud Scheduler — **only after explicit CTO activation approval** |
| Access control | Google Cloud IAM |
| Backup / lifecycle | managed mechanisms as appropriate |

### The architecture stays cloud-neutral

This is a **deployment** choice, not an architectural one.

- The application keeps its Ports/Adapters structure.
- The `ObjectStorage` abstraction is preserved.
- **The domain must not depend on Google Cloud SDK types.** A Google Cloud
  Storage adapter is written behind the existing port, exactly as an S3 adapter
  would have been.

So: **Production Cloud = Google Cloud. Production object storage = Google Cloud
Storage adapter. Domain and application ports remain provider-neutral.**

## Decision 2 — AI provider and model policy

**WaveSpeedAI is the PRIMARY CANDIDATE for the initial commercial release.**

**This is not authorization to activate it.**

Before any paid production activation, re-verify, against current reality rather
than against documentation written earlier:

- commercial-use rights and terms
- current pricing
- 720p support
- 1080p support
- supported durations
- the image-to-video contract
- concurrency and rate limits
- provider retention
- webhook / auth mechanism
- cancellation capability
- actual output quality
- observed failure rate
- observed latency
- Unit economics

Rules:

- **only verified production routes may be enabled**;
- Normal and HQ (ADR-0052 Decision 6) map internally to verified routes;
- **Provider and model choices are never exposed to customers**;
- prefer **one Primary Provider and at most one defined fallback candidate**;
- **do not introduce unconstrained automatic multi-provider routing** in this
  initial work.

## Decision 3 — Cost Safety Guard

The financial invariant:

> **No production route may knowingly operate at a loss, and each accepted route
> must preserve sufficient positive profit.**

**No CTO-approved minimum gross-margin percentage is hard-coded at this
documentation stage.** A number will come from a later measured business
decision; inventing one now would encode a guess as a control.

The Safety Guard must ultimately account for the meaningful variable-cost stack,
including as applicable:

- AI Provider cost
- retry / recovery expected cost
- Google Cloud variable compute, storage and egress cost
- payment processing cost (ADR-0053 Decision 5)
- FX risk / buffer
- composition / transcoding cost
- other material per-generation variable costs

Mechanics:

- Provider pricing is represented by **CTO-approved internal pricing snapshots**.
- A request **binds to an applicable immutable pricing/cost snapshot at
  admission/reservation time** where needed for deterministic accounting. This is
  the behaviour the existing pricing-snapshot and FX-snapshot rows already
  implement.
- **FX uses a trusted source with an internal snapshot and a safety buffer**, not
  a live external request during every Provider POST.
- The authoritative selling-price catalog lives inside VTaVision's own commercial
  model; **Stripe is a payment processor, not the pricing authority.**

The Safety Guard decision occurs **before a paid Provider submission**. If a
route no longer satisfies profitability constraints:

1. do not submit that expensive route;
2. use an approved alternative route if one exists;
3. otherwise **safely reject or pause admission** rather than deliberately submit
   a loss-making job.

## Decision 4 — Production scheduler and retry policy

**Do not guess operational timing values before measured Provider evidence
exists.** The values below that are marked unmeasured stay unmeasured until
production evidence sets them.

Permanent invariants:

- **no blind automatic retry of a Provider POST**;
- submission certainty and retryability are **separate concepts**;
- an ambiguous submission enters **reconciliation**, never an immediate re-POST;
- only conclusively safe retry cases may requeue;
- recovery must be **bounded**;
- permanent failure must reach a **customer-safe settlement**;
- the stale `SUBMITTING` threshold must derive from **observed real Provider
  submission latency, including p99**;
- signed source-URL TTL must be **validated against measured Provider fetch
  behaviour** with sufficient buffer;
- scheduler cadence, batch size and worker concurrency must be determined through
  **load / production-readiness testing**;
- production policy values must be **configurable and versioned**, not casually
  hard-coded;
- the **Safety Guard must be able to stop unsafe or costly execution.**

### Reconciliation evidence source — decision gate CLOSED

The approved initial-production design is **authenticated webhook plus mandatory
polling fallback.**

**Webhook — primary, when and only when it can be trusted.** If the active
provider offers a webhook whose authenticity can be verified, it is the primary
low-latency notification path. It must be authenticated and verified,
replay-safe, deduplicated, resolved to an internal tenant-scoped request, and
normalized before any domain mutation.

**If provider webhook authenticity cannot be verified, that webhook is not
authoritative completion evidence, and polling becomes the normal authoritative
path.** An unauthenticated internet callback is never accepted as proof that a
paid generation completed — that is an endpoint anyone can call to assert someone
else's spend succeeded.

**Polling — mandatory fallback even when authenticated webhooks are in use.** It
covers the missed webhook, the delayed webhook, transport failure, uncertain
delivery, and reconciliation after a restart or operator investigation. A webhook
is an optimization; polling is the guarantee.

**Operator evidence — exceptional only.** Operator-supplied evidence is
recovery / break-glass evidence, never the normal provider-completion path.

**All three sources normalize into the provider-neutral reconciliation contract
before any durable state transition.** Every existing invariant survives
unchanged: no blind Provider POST retry; an ambiguous submission reconciles
first; duplicate evidence must not cause duplicate completion; provider
"success" alone **does not** consume a Unit; managed-output ingestion, SHA/byte
verification, media validation and final Deliverable validation all still occur;
and Transaction G remains the authoritative customer-delivery boundary.

**Exact polling cadence and timeouts remain live-evidence values** and are not
set here. **The provider's webhook authentication contract is itself unverified**
until checked against the live provider, and is on the Decision 2
re-verification list.

**Nothing in this ADR activates the production scheduler.**

## Decision 5 — Production security operations

### Rate limiting

Production requires **defense-in-depth** rate limiting across dimensions that may
include account, organization, IP, and endpoint/action type.

Sensitive areas: login, password reset, MFA recovery, uploads, generation,
downloads, billing.

- Login failures use **progressive cooldown / brute-force protection**.
- A working starting value such as **5 failures / 15 minutes** may be documented
  as a **configurable starting point, not an immutable commercial contract**.
- Return safe 429-style behaviour where appropriate.
- **A rate-limited request must not accidentally consume a Unit or cause a
  Provider POST.**
- **Plan generation concurrency (ADR-0052 Decision 7) and abuse rate limiting are
  separate controls** and must not be implemented as one mechanism.

### Upload safety

**Production malware scanning is mandatory. `PassthroughMalwareScanner` is not
allowed in production.** Use a real engine behind the existing `MalwareScanner`
port — ClamAV or an approved vendor.

Uploads stay **quarantined** until required validation and scanning succeed.

Defense in depth: allowed formats; MIME validation; magic-byte validation; size
limits; malware scanning.

**Failed or unscanned prohibited input must not be sent to the AI Provider.**

## Decision 6 — Privileged support access

**Normal VTaVision support staff must not have unrestricted cross-tenant
browsing, and generic customer impersonation is not implemented in the initial
release.**

When customer content must be inspected for support:

- use **explicit privileged support access**;
- identify the target organization;
- identify the operator;
- record a business/support reason;
- time-limit the grant and **auto-expire** it;
- audit all relevant access and actions;
- apply least privilege.

**Normally obtain OWNER/ADMIN authorization before support access.**

Emergency **break-glass** access is permitted only for exceptional cases such as
a Sev1 security incident, and must: require an explicit reason; be highly
restricted; be fully audited; trigger appropriate post-event review; and support
customer notification/assessment where appropriate.

**Routine direct-database tenant bypass is not an acceptable support process.**

Support-content access, billing mutation and permission mutation must remain
**separate privileges**.

### Operator recovery from terminal technical failure is one of these privileges

Recovering a terminally failed internal row — an internal technical `BLOCKED`
row, or a terminal `INVALID_MEDIA` / `INTEGRITY_MISMATCH` verdict — is an
**internal operator privilege under this decision**, not a customer capability.
**No customer role template reaches it**, including `OWNER` and `ADMIN`.

The semantics, the immutability of the original terminal evidence, the required
audit fields and the per-row (never per-cause-global) mutation rule are ADR-0052
Decision 20. This decision supplies the privilege it runs under: explicitly
authorized, identified, reasoned, time-limited, audited and least-privilege, and
**separate** from support-content access, billing mutation and permission
mutation.

## Decision 7 — Activation gates remain BLOCKED

The following remain explicitly **BLOCKED** and require **explicit CTO
authorization in a future work package**:

- Paid Provider Activation
- production Provider credentials
- production AI paid calls
- production scheduler activation

**Approval of this documentation is not activation authorization.**

Current measured state on `main`: the provider factory can construct
`WaveSpeedVideoProvider`, but `VIDEO_PROVIDER` defaults to `fake`, no production
credential exists in the repository, and nothing in production code constructs a
cloud storage client, a composition runner, a deliverable-validation runner, or
any timer, cron or scheduler. The gate is held by configuration and by the
absence of callers, and both are verified per phase.

---

## Consequences

The cloud question is settled without the architecture paying for it: because
storage was behind a port from ADR-0008, choosing Google Cloud is an adapter and
a deployment target rather than a rewrite.

**Accepted cost.** Writing a Google Cloud Storage adapter duplicates effort
already spent reasoning about S3 semantics — including the `NoSuchKey`-versus-
`AccessDenied` absence problem Phase 5B solved for S3. That reasoning must be
redone against GCS's own error model, and the `s3:ListBucket` production
prerequisite already recorded has a GCS equivalent to establish.

**Accepted cost.** Refusing to fix a minimum margin percentage now means the
Safety Guard cannot be fully implemented yet — only its inputs and its decision
point can be built. A guessed percentage would be worse: it would look like a
control while encoding an unmeasured assumption.

**Accepted cost.** Requiring polling even where an authenticated webhook works
means paying for reconciliation traffic that will usually find nothing. The
alternative is trusting a notification path whose silence is indistinguishable
from a provider that never finished, on work that has already been paid for.

**Deliberately unresolved, pending measurement.** The stale-`SUBMITTING`
threshold, the signed-URL TTL, scheduler cadence, batch size, worker concurrency,
the polling interval and timeouts, the provider's webhook authentication
contract, and the rate-limit constants are all gated on production evidence. They
are recorded as gates in `docs/decisions/TODO.md` rather than guessed here.

**Still blocked.** Paid Provider Activation, production credentials, paid
production calls, and production scheduler activation.
