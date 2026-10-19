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
- Unit ledger, including **quality-tagged** added-package blocks and the
  **eligibility-first** consumption order — eligible Base Unit → oldest eligible
  add-on → newest eligible add-on, FIFO within the eligible quality class, with
  the included HQ ceiling enforced inside the Base pool (ADR-0053 Decisions 2
  and 3)
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

**Phase 6A — Unit entitlement / ledger foundation** (ADR-0055, migration 17):
entitlement periods with a frozen plan snapshot, quality-tagged add-on blocks,
multi-source eligibility-first allocation frozen at reservation, all-or-nothing
funding, and Transaction G spending the frozen set. Implemented and dormant; the
stale 12-month / 5% constants are removed.

**Phase 6B — the organization subscription and period renewal** (ADR-0056,
migration 18): one subscription per organization (plan, `SELF_SERVICE` or
`SALES_ASSISTED` channel, renewal anchor, commercial reference; Enterprise
sales-assisted only), monthly periods derived from the anchor, and renewal that
opens the period containing an instant on demand and idempotently — no
scheduler. Implemented and dormant.

**Phase 6C — the role templates and the role-assignment ceiling** (ADR-0057,
migration 19): the six ADR-0052 templates and the 27-permission matrix replace
`OWNER`/`ADMIN`/`CREATOR`/`REVIEWER`; every membership path asks the
role-assignment ceiling of every role it touches and audits each refusal;
`REVIEWER` became `VIEWER`; every existing check moved to its specific
permission, reads included. Built first because every commercial mutation
requires `billing.manage`, which did not exist.

**Phase 6D — individual permission grants** (ADR-0058, migration 20): a
member's effective permissions are its template plus its individual grants, with
`property.create` never effective for `VIEWER` or `BILLING`; grants and
revocations go through the grant ceiling (`permission.manage`, the target's role,
`OWNER`-only `permission.manage` / `billing.manage` / `disclosure.none`, delegate
only what you hold), each refusal audited. Dormant: no route or page grants.

**Phase 6E — membership changes made atomic and race-free** (ADR-0059, no
migration): invitation, acceptance, role change and removal each commit with
their audit entry in one transaction; a role change or removal applies only to
the role its ceiling saw; demoting or removing an `OWNER` counts the `OWNER`s
under a lock, so the last one can never be taken away; an invitation is accepted
once. Built before groups, which reuse the pattern.

**Phase 6F — groups and group membership** (ADR-0060, migration 21): an
organization's groups (unique, trimmed names) and their members, with both of a
member row's foreign keys carrying the organization; `group.manage` to change,
`group.view` to list; deletion `OWNER`/`ADMIN`-only even where another role holds
`group.manage`; adding or removing a member under the role-assignment ceiling;
each change committed with its audit entry, each refusal audited. Dormant: a
group confers no permission and no row access yet.

**Phase 6G — group permissions** (ADR-0061, migration 22): a group carries
permissions every member then holds, additively; a CHECK makes `disclosure.none`
impossible on a group, and `property.create` stays ineffective for `VIEWER` and
`BILLING`. Every group change that gives or takes a permission (a grant or
revocation on the group, adding or removing a member of a group that carries
any, deleting such a group) is checked as a direct grant or revocation to each
member it reaches, on the group as locked when the change commits. Changing a
group's permissions needs `permission.manage`. Dormant: no route or page gives a
group a permission.

**Phase 6H — Property assignment** (ADR-0062, migration 23): a Property's
responsible user (for `OWN`) and its group (for `GROUP`), each kept inside the
organization by a foreign key that refuses deletion. Creation sets them by the
creator's role (an `OWNER` or `ADMIN` chooses; a `MANAGER` is its own
responsible user in one of its own groups; a `CREATOR` is its own responsible
user, ungrouped); only an `OWNER` or `ADMIN` changes them later. A group's
deletion ungroups its Properties and a member's removal unassigns theirs, each
counted in its audit entry. Creation and every assignment change commit with
their audit entries. Dormant: no route or page assigns, and reach is not
enforced.

**Near-duplicate rule removal** (ADR-0063, migration 24, before 6I): look-alike
photos are the customer's responsibility (ADR-0052 Decision 14). Each photo is
approved on its own, with no cluster or primary choice; the one-approved-per-group
index is dropped; storyboards admit approved look-alikes; and no response or
screen carries look-alike data. The perceptual hash and duplicate group stay,
internally.

**Phase 6I-1 — Property reach on Properties and photos** (ADR-0064, no
migration): a member reaches the Properties its role's scope selects (every
Property for `OWNER`, `ADMIN` and `BILLING`; its groups' for a `MANAGER`; those it
is responsible for as a `CREATOR` or `VIEWER`). The Property list is filtered in
the query, and every Property and photo path answers a Property out of reach
exactly as one that does not exist.

**Phase 6I-2 — Property reach on analyses, video projects and storyboards**
(ADR-0064, no migration): analyses and their review, video projects,
storyboards and generation admission are reached exactly when their Property
is, and out of reach they are answered as rows that do not exist. A deleted
Property takes no new video project and lists none.

**MFA-1 — authenticator-app MFA, foundation** (ADR-0065, migration 25):
TOTP and recovery codes, the sealed secret, who must use MFA, and `MfaService`,
each change audited. Dormant: no route calls it yet.

**MFA-2 — the security page and two-step sign-in** (ADR-0065, no migration):
anyone may turn on authenticator-app MFA at `/security`, keep recovery codes,
move to a new device and turn it off when their role allows. Once it is on,
signing in asks for a code after the password.

**MFA-3 — mandatory MFA** (ADR-0065 Decisions 15 to 17, no migration): an
`OWNER`, `ADMIN`, `BILLING` or other holder of `permission.manage` or
`billing.manage` who has not set up MFA sets it up at their next request,
before reaching anything else. There is no grace period. The readiness probe
reports a missing `MFA_SECRET_KEY`.

**MFA-4 — an organization's requirement for all members** (ADR-0065 Decisions
18 and 19, migration 26): an `OWNER` or `ADMIN` may require MFA of every member
from the dashboard. Members without MFA set it up at their next request. Off
for every organization until turned on.

**UP-1 — plan provisioning and the Units page** (ADR-0066, no migration): the
first of four Unit purchase pull requests. An operator command gives an
organization the sales-assisted plan its contract names, naming the operator and
the reason in the audit entry. Every member with `unit.view` can see the plan,
the period and the Units left on a new Units page; `billing.view` adds how the
plan is paid. The page writes nothing.

**UP-2 — the Unit purchase record** (ADR-0067, migration 27): the approved
package prices in the catalog, and a purchase approved by a `billing.manage`
holder written with its block and both audit entries in one transaction,
bought once per idempotency key, re-checked under the period's lock.

**UP-3 — the Unit purchase screen** (ADR-0068, no migration): a holder of
`billing.manage` in an invoice-paid Standard or Premium organization can buy one
additional Unit package at a time from the Units page. The confirmation step
states the Units and their quality lock, the price excluding tax, the date they
expire with no carry-over or refund, and that the purchase is invoiced; one
button approves it and the Units are usable at once. Enterprise packages are
listed as bought through sales. The purchase route refuses a post from another
origin.

**UP-4 — this period's purchases and the invoicing export** (ADR-0069, no
migration): a holder of `billing.view` sees each package bought this period on
the Units page, with its price excluding tax, when it was approved and by whom.
An operator command writes the invoice-paid purchases approved in a window to a
new CSV file, per organization and contract, for invoicing; each organization
listed is audited.

**UP-5 — cancelling a mistaken purchase** (ADR-0070, migration 28): an operator
command cancels a purchase made by mistake, after showing it and only with
`--confirm`. Only VTaVision's own mistake is free: its unused Units are
withdrawn at once, Units already used stay used, and the purchase is not
invoiced. The customer's mistake is charged, unless it is cancelled within 10
hours of its approval with none of its Units used. The export marks a
cancelled purchase with nothing to invoice, and the Units page says so.

**Not yet built in Phase 6:** Stripe and sales-assisted billing, subscription cancellation, seats and
storage blocks, upgrade/downgrade, charged disclosure recomposition, the internal
recovery budget, the Cost Safety Guard threshold, and reconciliation/admin
controls. Two decision gates are open: what a customer regeneration costs in
Units, and what happens to a self-service renewal whose payment fails.

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