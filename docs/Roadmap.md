# Implementation Roadmap

Version: 1.0
Status: Draft

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

## Phase 5 — Video composition and review

Scope:

- FFmpeg composition
- transitions, normalization, BGM, captions, logo, watermark
- AI-generated disclosure
- output validation
- scene-level regeneration
- human review, approval, rejection, and signed download

Completion criteria: approved final videos meet configured duration/format and cannot be shared before approval.

## Phase 6 — Billing and commercial controls

Scope:

- plans, subscriptions, usage limits
- credit ledger
- estimate, reservation, settlement, release, refund
- Stripe checkout/webhooks
- billing reconciliation and admin controls

Completion criteria: generation and billing remain idempotent under retries, duplicate webhooks, and worker crashes.

## Phase 7 — SaaS operations and production readiness

Scope:

- observability and alerts
- dashboards and support tooling
- backups and restore tests
- retention/deletion automation
- rate limits and abuse controls
- deployment infrastructure
- security hardening and threat-model review
- terms, privacy, disclosure, and subprocessor documentation
- provider outage playbooks

Completion criteria: staging production-readiness review passes and rollback/recovery procedures are tested.

## Phase 8 — Beta and launch

Scope:

- pilot organizations
- onboarding and support process
- generation quality and cost tuning
- performance/load testing
- user feedback and defect closure
- launch metrics and pricing validation

Completion criteria: agreed beta KPIs are met, critical defects are zero, billing reconciles, and legal/operational launch approval is recorded.

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