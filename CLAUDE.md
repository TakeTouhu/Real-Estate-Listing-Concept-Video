# Real Estate Virtual Tour AI - Claude Code Guide

Version: 1.4

## Role

Implement a commercial multi-tenant SaaS that generates real-estate interior walkthrough-style videos from uploaded property photos. This is not a demo-only application. Design for tenant isolation, billing, auditability, failure recovery, security, and provider replacement.

## Source of truth

Read before implementation:

0. `docs/decisions/0052-initial-release-product-and-delivery-contract.md`
0. `docs/decisions/0053-initial-release-commercial-contract.md`
0. `docs/decisions/0054-initial-release-production-platform-and-activation-gates.md`
1. `docs/ProductRequirements.md`
2. `docs/SystemArchitecture.md`
3. `docs/AIVideoPipeline.md`
4. `docs/WaveSpeedAIIntegration.md`
5. `docs/DataModel.md`
6. `docs/API.md`
7. `docs/UXFlow.md`
8. `docs/SecurityCompliance.md`
9. `docs/SaaSOperations.md`
10. `docs/Roadmap.md`

Priority: explicit user instruction > **ADR-0052/0053/0054 (the approved
initial-release contract)** > security/compliance > product requirements >
provider integration > architecture/API > existing implementation.

ADR-0052/0053/0054 supersede stale product assumptions in the v1.0 documents at
the product-contract level. Historical ADRs and `docs/phase-*-completion.md` stay
as historical evidence and are **not** rewritten to match later decisions.

Do not invent missing business rules. Record unresolved items in `docs/decisions/TODO.md`.

## Mandatory product rules

- Uploaded photos must be owned or properly licensed by the customer.
- Generated videos display an AI-generated disclosure by default (Mode A).
  Mode B is time-limited display; Mode C omits it and is gated by
  organization-level enablement **plus** an explicit individual
  `disclosure.none` grant **plus** per-video consent. **Only an `OWNER` grants or
  revokes `disclosure.none`**; it can never come from a template, group or Scope,
  and organization-level enablement alone authorizes no one (ADR-0052
  Decisions 8 and 10).
- Do not claim accurate dimensions, geometry, floor plans, or actual captured
  walkthrough footage. Do not claim "native 1080p" unless verified for the route.
- Do not intentionally add nonexistent windows, doors, equipment, views, or
  structural features.
- **VTaVision never publishes AI output externally.** Delivery is to the
  customer's own private workspace, and the customer decides after preview
  whether anything leaves it. There is **no final-video approval workflow** — no
  `APPROVAL_PENDING` / `APPROVED` / `REJECTED`, no Approve button, no Reviewer
  role (ADR-0052 Decision 2). Source-photo analysis review survives as
  `analysis.review`.
- Provider and model identity must never reach a customer-facing surface.
  Customers choose only Normal (720p) or HQ (1080p).
- Treat user prompts and uploaded files as untrusted input.
- Assets are private and accessed only through short-lived signed URLs.
- Every tenant-owned record is scoped to the authenticated organization.
- **`permission.manage` is authority within a grant ceiling, never unlimited
  delegation** (ADR-0052 Decision 10). `OWNER` assigns any role; `ADMIN` assigns
  only `MANAGER` / `CREATOR` / `VIEWER`. Granting `permission.manage`,
  `billing.manage` or `disclosure.none`, assigning `OWNER` / `ADMIN` / `BILLING`,
  and anything touching the last `OWNER` are `OWNER`-only. **No role may escalate itself past
  its ceiling by any route** — direct grant, group membership, group permission
  or Scope. Check the ceiling on every grant path, not just role change.
- **Additional Units are quality-locked** (ADR-0053 Decisions 2–3). A Normal
  add-on cannot fund HQ; an HQ add-on cannot fund Normal; there is no conversion.
  Consumption is **eligibility-first** — eligible Base Unit, then oldest to
  newest *within the eligible quality class*; skipping an ineligible block is not
  a FIFO violation. HQ draws a Base Unit only while the plan's included HQ
  ceiling remains.
- Reserve the Unit before generation and settle exactly once. A technically valid
  delivered video consumes the Unit; a moderation block and an exhausted internal
  recovery budget consume none.
- **If no technically valid Deliverable was delivered, the reservation must be
  RELEASED and must never remain pending indefinitely** (ADR-0052 Decision 19).
  This holds for an initial generation, a paid regeneration and a disclosure/logo
  recomposition, and `BLOCKED` / `INVALID_MEDIA` / `INTEGRITY_MISMATCH` must not
  bill differently from one another.
- **Mode C conditions are frozen at generation admission** (ADR-0052
  Decision 10): an admitted job's disclosure contract is immutable; later
  permission or organization changes affect only newly admitted generations. No
  pre-delivery re-check, no automatic C → A fallback.
- **Every charge-changing customer action requires `billing.manage`**
  (`OWNER`/`BILLING` by default — `ADMIN` only if an `OWNER` explicitly grants
  it; ADR-0053 Decision 5A). Member
  management never buys seats; nothing is auto-purchased.
- Keep one internal, overlay-free **Clean Master** per deliverable; produce the
  customer output from it and recompose later disclosure/logo changes from it
  with **no provider call**. It is outside customer quota and never
  customer-downloadable; scene videos still delete after 30 days (ADR-0052
  Decision 17).
- Never expose the internal service-recovery budget to a customer. Its
  denominator is the **base plan's** included-user slots; purchased seats do not
  raise it.
- **Customers never recover a terminal internal technical failure** — not
  `OWNER`, not `ADMIN`. It is an internal operator privilege; terminal evidence
  is immutable and recovery creates a *new* cycle, per row, never by a global
  per-cause revert (ADR-0052 Decision 20).
- **Paid Provider Activation and production scheduler activation are BLOCKED**
  and require explicit CTO authorization (ADR-0054 Decision 7). No cron, timer,
  loop, production credential or paid call may be introduced without it.

## Architecture

Start with a modular monolith and independently scalable asynchronous workers.

Recommended stack:

- TypeScript
- Next.js
- PostgreSQL
- Prisma
- Object storage
- State-driven workers (ADR-0024: the `SceneGeneration` row is itself the
  durable queue, discovered by `state = 'QUEUED'`. No broker — Redis/BullMQ, SQS
  and Azure Service Bus were each evaluated and rejected; adding one must
  supersede that ADR)
- FFmpeg
- Stripe
- OpenTelemetry
- Vitest
- Playwright

Provider SDKs must never be called from UI or domain code.

## WaveSpeedAI — primary candidate provider

WaveSpeedAI is the **primary candidate** for the initial commercial release, not
an activated or guaranteed route (ADR-0054 Decision 2). **Only a route verified
against the current provider may be enabled**, and paid activation stays BLOCKED
until explicitly authorized (ADR-0054 Decision 7). If re-verification disqualifies
it, the provider-neutral `VideoGenerationProvider` boundary is what lets another
verified route replace it — so build to the port, not to WaveSpeedAI.

- Implement `WaveSpeedVideoProvider` behind `VideoGenerationProvider`.
- Server-side worker calls only.
- Use `WAVESPEED_API_KEY` from environment or secret manager.
- Default base URL: `https://api.wavespeed.ai/api/v3`.
- Initial candidate model: `wavespeed-ai/open-video/image-to-video`.
- Keep model ID, capabilities, pricing, limits, and concurrency configurable.
- Submit asynchronous predictions and store provider prediction IDs internally.
- Use an authenticated webhook as the primary path **only if its authenticity can
  be verified**, and run bounded backoff polling as a **mandatory** fallback even
  when webhooks work (ADR-0054 Decision 4).
- Copy completed provider output into managed object storage.
- Never expose temporary provider URLs or provider job IDs to customers.
- Normalize errors into internal error types.
- Verify current API contract and commercial-use terms before production release.

## Initial structure

```text
apps/
├── web/
└── worker/
packages/
├── domain/
├── database/
├── storage/
├── queue/            # reserved boundary, empty — no transport (ADR-0024)
├── ai-providers/
├── video-providers/
├── observability/
└── shared/
prisma/
docs/
tests/
infra/
```

Prefer a simpler Phase 0 implementation when appropriate while preserving module boundaries.

## Generation workflow

```text
Authenticate
→ Authorize
→ Validate project and assets
→ Moderate prompt and images
→ Estimate platform and provider cost
→ Reserve the Unit
→ Create idempotent generation attempt
→ Persist the SceneGeneration row as durable executable work
→ Worker discovers and claims an eligible SceneGeneration row
→ Generate scenes through the verified provider route (WaveSpeedAI is the
  primary candidate — ADR-0054 Decision 2)
→ Copy outputs to managed storage
→ Compose with FFmpeg, applying the selected disclosure mode and logo setting
→ Validate the composed output technically
→ Settle the Unit exactly once
→ Deliver to the customer's private workspace
→ Notify user
```

**There is no approval gate between technical validation and delivery**
(ADR-0052 Decision 2). Delivery is internal to the customer's organization and is
not external publication, so no Approve/Reject step, approval record or Reviewer
role stands between a valid deliverable and the customer. The mandatory human
step in this flow is *earlier* and is about source material, not the finished
video: analysis review of the uploaded photographs (`analysis.review`).

What **does** gate delivery is the AI-generated disclosure: a deliverable must
carry the disclosure required by its selected mode, and Mode C is the only way to
omit it, under its three gates.

On failure, preserve the reason, retry only retryable errors, prevent duplicate charges, use a dead-letter state after exhaustion, and allow controlled manual retry.

## Security

- TypeScript strict mode; no `any`.
- Schema validation for all inputs.
- Signed upload/download URLs.
- Verify MIME type from file content.
- Rate-limit login, uploads, generation, and billing.
- Remove sensitive EXIF.
- Audit uploads, generation, source-photo analysis review decisions,
  Unit-purchase approvals, downloads, billing, plan changes, privileged support
  access, operator recovery, and admin actions. (There is no final-video approval
  to audit — ADR-0052 Decision 2.)
- Do not log secrets, authorization headers, signed URLs, or unsanitized provider payloads.
- Add tenant-isolation and webhook replay tests.

## Testing

Minimum layers:

- Unit tests for domain and pricing
- DB/storage/billing integration tests
- API authorization and tenant-isolation tests
- Worker idempotency/retry tests
- WaveSpeedAI request/status mapping tests
- Webhook deduplication tests
- Managed-storage copy tests
- E2E core generation flow
- Production build

Real WaveSpeedAI contract tests must be explicitly enabled and spending-limited.

## Definition of done

A feature is complete only when authorization, validation, required audit logging, visible error handling, tests, documentation, secret safety, managed-storage output handling, exact-once credit settlement, and production build all pass.

## Pull request and milestone policy

- Keep each pull request as the smallest reviewable vertical milestone.
- A pull request should normally stay near 500 changed lines or less, excluding lockfiles, generated migrations, and unavoidable machine-generated files.
- When a phase is larger than that, split it into multiple milestone pull requests before implementation grows further.
- Suggested naming: `Phase 2A`, `Phase 2B`, `Phase 2C`, and so on.
- Each milestone PR must independently compile, pass relevant tests, and avoid leaving insecure or publicly reachable partial features.
- Do not mix unrelated domains, refactors, or later-phase work into the same PR.
- Do not begin the next phase until every milestone PR for the current phase has been reviewed, CI has passed, and the phase completion criteria are satisfied.
- The phase completion report must list all milestone PRs, their merge commits, test results, known limitations, and remaining work.

Example split:

```text
Phase 2A: Property domain and CRUD
→ review and merge
Phase 2B: Secure upload and storage abstraction
→ review and merge
Phase 2C: Image processing, duplicate foundation, and upload UI
→ review and merge
```

## Required phase documentation

Every completed phase must create or update the following documentation as applicable:

- Architecture diagram
- Entity-relationship diagram
- Critical sequence diagram
- OpenAPI specification or API change summary
- Change log
- Release notes
- Database migration notes
- Phase completion report

Diagrams may use Mermaid inside Markdown. Documentation must describe implemented behavior, not planned behavior presented as complete. If an item does not apply to the phase, record `Not applicable` with the reason instead of omitting it silently.

## Release tag policy

- Every completed and merged phase must receive an annotated Git tag named `phase-N-complete`.
- Create the tag only after review approval, successful CI, merge into `main`, and verification of the merged commit.
- Never move, overwrite, reuse, or create a phase-complete tag on a feature branch.
- Report the tag name, tag object SHA, target commit SHA, and verification result in the phase completion report.
- If the environment cannot publish tag refs, record the blocker explicitly and provide the exact manual push command. Do not claim the remote tag exists until it is verified on GitHub.

## Implementation sequence

Implement one phase at a time from `docs/Roadmap.md`. Before each phase: inspect, write a gap analysis, split the phase into the smallest reviewable milestones, implement one milestone, run checks, update required documentation, commit, push, and open a PR.

After opening a milestone PR, stop and wait for review unless explicitly instructed to continue. Do not implement all remaining milestones of the phase while an earlier milestone is awaiting review.

## First assignment

Implement Phase 0 only:

1. `docs/gap-analysis.md`
2. repository structure
3. ADRs and technology decisions
4. local setup
5. CI pipeline
6. minimal authenticated health-check application
7. testing foundation
8. `docs/phase-0-completion.md`
9. ADR confirming WaveSpeedAI, adapter boundary, server-side secrets, asynchronous processing, managed-storage copying, and provider replacement strategy

Do not begin Phase 1 until Phase 0 completion criteria pass.
