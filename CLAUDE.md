# Real Estate Virtual Tour AI - Claude Code Guide

Version: 1.3

## Role

Implement a commercial multi-tenant SaaS that generates real-estate interior walkthrough-style videos from uploaded property photos. This is not a demo-only application. Design for tenant isolation, billing, auditability, failure recovery, security, and provider replacement.

## Source of truth

製品仕様の最上位文書は `PRODUCT_SPEC.md`（製品ビジョン・事業要件・凍結仕様・
実装状況・次フェーズ）である。実装再開時は最初にこれを読む。

Read before implementation:

0. `PRODUCT_SPEC.md`
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

Priority: explicit owner / CTO instruction > security/compliance > product requirements
> current accepted ADR > WaveSpeedAI integration contract > architecture/API docs
> existing implementation.

ただし docs が stale の場合は、merged source + later ADR / completion report を
優先して現状を確定する。完全な定義は `PRODUCT_SPEC.md` 16.1 を参照。

Do not invent missing business rules. Record unresolved items in `docs/decisions/TODO.md`.

## Mandatory product rules

- Uploaded photos must be owned or properly licensed by the customer.
- Generated videos display an AI-generated disclosure by default.
- Do not claim accurate dimensions, geometry, floor plans, or actual captured walkthrough footage.
- Do not intentionally add nonexistent windows, doors, equipment, views, or structural features.
- Never publish AI output automatically. Human review and approval are mandatory.
- Treat user prompts and uploaded files as untrusted input.
- Assets are private and accessed only through short-lived signed URLs.
- Every tenant-owned record is scoped to the authenticated organization.
- Reserve credits before generation and settle exactly once.

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

## WaveSpeedAI requirement

WaveSpeedAI is the required initial video-generation provider.

- Implement `WaveSpeedVideoProvider` behind `VideoGenerationProvider`.
- Server-side worker calls only.
- Use `WAVESPEED_API_KEY` from environment or secret manager.
- Default base URL: `https://api.wavespeed.ai/api/v3`.
- Initial candidate model: `wavespeed-ai/open-video/image-to-video`.
- Keep model ID, capabilities, pricing, limits, and concurrency configurable.
- Submit asynchronous predictions and store provider prediction IDs internally.
- Prefer authenticated webhooks; use bounded backoff polling as fallback.
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
prisma/            # README.md only; actual schema/migrations live in packages/database/prisma/
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
→ Reserve credits
→ Create idempotent generation attempt
→ Persist the SceneGeneration row as durable executable work
→ Worker discovers and claims an eligible SceneGeneration row
→ Generate scenes through WaveSpeedAI
→ Copy outputs to managed storage
→ Compose with FFmpeg
→ Validate output
→ Require human review
→ Settle credits exactly once
→ Notify user
```

On failure, preserve the reason, retry only retryable errors, prevent duplicate charges, use a dead-letter state after exhaustion, and allow controlled manual retry.

## Security

- TypeScript strict mode; no `any`.
- Schema validation for all inputs.
- Signed upload/download URLs.
- Verify MIME type from file content.
- Rate-limit login, uploads, generation, and billing.
- Remove sensitive EXIF.
- Audit uploads, generation, approvals, downloads, billing, and admin actions.
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

Implement one milestone at a time. The phase-level roadmap is `docs/Roadmap.md`;
the authoritative sub-milestone breakdown and current position are `PRODUCT_SPEC.md`
section 9 and `docs/decisions/TODO.md`. Where they differ, the latter two govern.

Before each phase: inspect, write a gap analysis, split the phase into the smallest reviewable milestones, implement one milestone, run checks, update required documentation, commit, push, and open a PR.

After opening a milestone PR, stop and wait for review unless explicitly instructed to continue. Do not implement all remaining milestones of the phase while an earlier milestone is awaiting review.

## First assignment

Phase 0 から Phase 4C-3A-2b までは完了・マージ済みである。
現在地と次に着手すべきマイルストーンは `PRODUCT_SPEC.md` 9 章および
`docs/decisions/TODO.md` を参照して確定すること。
過去フェーズを再実装してはならない。
