# Real Estate Virtual Tour AI - Claude Code Guide

Version: 1.2

## Role

Implement a commercial multi-tenant SaaS that generates real-estate interior walkthrough-style videos from uploaded property photos. This is not a demo-only application. Design for tenant isolation, billing, auditability, failure recovery, security, and provider replacement.

## Source of truth

Read before implementation:

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

Priority: explicit user instruction > security/compliance > product requirements > WaveSpeedAI integration > architecture/API > existing implementation.

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
- Queue-based workers
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
├── queue/
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
→ Reserve credits
→ Create idempotent job
→ Enqueue
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
- DB/storage/queue/billing integration tests
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

## Implementation sequence

Implement one phase at a time from `docs/Roadmap.md`. Before each phase: inspect, write a gap analysis, choose the smallest vertical milestone, implement, run checks, write a completion report, commit, push, and open a PR.

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