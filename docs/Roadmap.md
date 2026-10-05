# Implementation Roadmap

Version: 2.0
Status: Approved initial-release contract (pre-Commercial-Launch)

Authority: ADR-0052, ADR-0053, ADR-0054.

Phases 0 through 5C are **complete and merged**; their records are in
`docs/phase-*-completion.md` and must not be rewritten. The scope statements below
for completed phases are kept as the plan they were delivered against. **Paid
Provider Activation and production scheduler activation remain BLOCKED**
(ADR-0054 Decision 7).

## Phase 0 — Engineering foundation

Scope:

- repository and monorepo structure
- TypeScript strict configuration
- local development environment
- CI pipeline
- minimal authenticated health-check application
- testing foundation
- architecture decision records
- environment/secret conventions
- WaveSpeedAI provider ADR and adapter contract
- gap analysis and completion report

Completion criteria:

- local setup works from documented steps,
- CI runs typecheck, lint, unit tests, and build,
- authenticated health endpoint and minimal UI work,
- no secrets committed,
- provider interface compiles with a fake adapter,
- Phase 0 completion report lists exact results.

Do not call the real WaveSpeedAI API in Phase 0.

## Phase 1 — Identity, organizations, and tenant isolation

Scope:

- PostgreSQL and Prisma foundation
- users, organizations, memberships, roles, invitations
- authentication/session implementation
- organization-scoped repositories
- audit log foundation
- tenant-isolation tests

Completion criteria: cross-tenant access is denied by automated tests and all writes produce required audit events.

## Phase 2 — Properties and secure media upload

Scope:

- property CRUD
- signed direct uploads
- file-content validation
- malware-scan integration boundary
- EXIF sanitization and image normalization
- private object storage
- asset retention/deletion states

Completion criteria: an authorized creator can upload valid photos and cannot access another organization’s assets.

## Phase 3 — AI analysis and storyboard

Scope:

- room classification adapter
- quality, duplicate, privacy, and safety analysis
- editable room labels and image order
- storyboard generation
- prompt compilation and moderation

Completion criteria: users can review and correct all AI decisions before generation.

## Phase 4 — WaveSpeedAI scene generation

Scope:

- `WaveSpeedVideoProvider`
- configurable model capabilities
- asynchronous prediction submission
- provider status mapping
- verified webhook and bounded polling fallback
- temporary output download and managed-storage copy
- retry, timeout, cancellation, and dead-letter behavior
- provider contract tests behind explicit spending controls

Completion criteria: a scene can be generated end-to-end without exposing API keys, provider IDs, or temporary URLs.

## Phase 5 — Video composition and delivery

Delivered as 5A (composition plan), 5B (composition execution and the managed
final object) and 5C (deliverable validation and the publication boundary). All
three are merged; see their completion reports.

Scope as delivered:

- FFmpeg composition and composition profile v1
- output validation
- the durable deliverable verdict and Transaction G — job `DELIVERABLE_READY`,
  the deliverable pointer, and exactly-once Unit consumption

**Superseded from the original plan:** "human review, approval, rejection" is
removed from the product (ADR-0052 Decision 2), and the original completion
criterion "cannot be shared before approval" no longer applies — customer share
links are not in the initial release at all (ADR-0052 Decision 12).

**Still unimplemented from this phase's scope:** the AI-generated disclosure
renders at no layer, and the company logo pipeline does not exist. Both are
required for the initial release and are tracked in `docs/decisions/TODO.md`.

Completion criteria as met: a composed deliverable is proved technically valid,
and publication and Unit consumption are one atomic, replay-safe commit.

## Phase 6 — Billing and commercial controls

Scope:

- the approved plans, Units, packages and storage quotas (ADR-0053)
- Unit ledger, including added-package blocks and the base → oldest → newest
  consumption order
- estimate, reservation, settlement and release
- **no automatic overage**; customer-approved Unit purchase
- Stripe checkout/webhooks for web self-service; invoice/bank transfer for
  sales-assisted contracts, representable **without** a Stripe object
- disclosure-mode change accounting (3 free per video, then 1 Unit per block of 3)
- the internal service-recovery budget
- the **Cost Safety Guard** decision point before any paid submission (ADR-0054
  Decision 3)
- billing reconciliation and admin controls

Completion criteria: generation and billing remain idempotent under retries,
duplicate webhooks and worker crashes; no route is knowingly submitted at a loss.

## Phase 7 — SaaS operations and production readiness

Scope:

- observability and alerts
- dashboards and support tooling
- backups and restore tests
- retention/deletion automation
- **defense-in-depth rate limiting** (account / organization / IP / endpoint),
  with login brute-force protection
- **real malware scanning**; `PassthroughMalwareScanner` removed from production
- **Google Cloud** deployment: Cloud Run, Cloud Run Jobs, Cloud SQL, Google Cloud
  Storage adapter behind the existing port, Secret Manager, Artifact Registry,
  Cloud Logging/Monitoring, IAM (ADR-0054 Decision 1)
- privileged support access and break-glass, without generic impersonation
- security hardening and threat-model review
- counsel-reviewed terms, privacy, Mode C consent, responsibility boundary,
  versioned legal documents and a published subprocessor list
- provider outage playbooks

Completion criteria: staging production-readiness review passes and
rollback/recovery procedures are tested.

**The production scheduler is not activated by this phase.** Cloud Scheduler
requires explicit CTO activation approval, and the timing values it needs —
stale-`SUBMITTING` threshold, signed-URL TTL, cadence, batch size, worker
concurrency — must come from measured production evidence rather than guesses
(ADR-0054 Decision 4).

## Phase 8 — Closed Beta and launch

Scope:

- **3–5 real-estate companies** in Closed Beta, with hands-on online onboarding
- onboarding and support process
- generation quality and cost tuning
- performance/load testing, which is also what sets the production scheduler's
  timing values
- user feedback and defect closure
- launch metrics and **validation of provisional pricing** — notably the
  additional-storage figure (ADR-0053 Decision 4)

Completion criteria (ADR-0053 Decision 12): 3 companies actively using the
system, 30+ real properties, 100+ completed videos, technically valid deliverable
success rate ≥ 98%, manual operator intervention < 5%, and the core generation
flow completable without support — with these **zero-tolerance** gates:
erroneous/double Unit consumption 0, duplicate Provider charging from blind retry
0, cross-tenant data exposure 0, Sev1 incidents 0, loss-making Jobs 0.

**Customer aesthetic satisfaction is useful feedback but is not a technical
launch gate.** Zero-tolerance gates are not negotiable against percentage KPIs.

## Post-release roadmap

Explicitly deferred, and explicitly retained so none of it is lost:

**Authentication**

- Microsoft Entra ID SSO
- Google SSO
- organization-level SSO-required mode
- possible password-login disablement for SSO-enforced organizations

**Product modes**

- virtual staging
- renovation proposal

**Sharing**

- customer-facing share links: `video.share`, version-fixed links, expiry
  24h/7d/30d (default 7d), optional or organization-required password, view-only
  default, download only when the creator holds `video.download`, manual revoke,
  invalidation on new-version replacement, audit, a VTaVision-hosted share page
  that shows the AI disclosure **even for Mode C** videos, and a traffic Safety
  Guard

**Branding**

- multi-brand, branch-specific logos and templates

**Support knowledge base and assisted triage**

Not in the initial release, and not to be implemented early. The approved
direction:

- maintain a customer-facing **product manual / Knowledge Base**;
- **classify incoming support and incident requests automatically**, triaging on
  severity, security relevance, billing relevance and support topic;
- let routine product and how-to questions be answered by a **support chatbot
  grounded in the approved manual / Knowledge Base**;
- **escalate anything requiring human judgment or privileged action** to support
  staff.

Cases that must generally escalate to a human: suspected security incidents;
possible tenant-boundary or data exposure; billing disputes or billing mutation;
legal and contractual requests; account or permission recovery requiring
privileged action; Sev1 incidents; and any case where the chatbot lacks adequate
authoritative documentation.

**The chatbot must not obtain privileged tenant access merely because it is a
support interface.** A support surface is not a support privilege — the
privileged-access rules of ADR-0054 Decision 6 apply to it exactly as they apply
to a human operator, and nothing about it may reach the operator-recovery
privilege of ADR-0052 Decision 20.

**Other**

- restore-old-version-as-current
- additional Provider routes beyond one primary and one defined fallback

## Delivery rules

Each phase requires:

1. repository inspection and gap analysis,
2. smallest viable vertical milestone,
3. implementation on a dedicated branch,
4. automated checks,
5. phase completion report,
6. focused commits,
7. Pull Request review and merge before the next phase.

Do not mark a phase complete based only on screenshots or documentation. Completion requires working code, test evidence, and merged changes.