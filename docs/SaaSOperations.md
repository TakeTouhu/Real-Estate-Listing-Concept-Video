# SaaS Operations

Version: 1.0
Status: Draft

## Operating model

Operate the service as a commercial multi-tenant SaaS with separate development, staging, and production environments. Production access follows least privilege and all privileged actions are audited.

## Plans and billing

Support subscription plans plus generation credits. Plans define users, storage, monthly credits, supported output quality, concurrency, retention, branding, and support level.

Billing rules:

- show estimated credits before generation,
- reserve credits transactionally before enqueueing,
- settle exactly once after terminal outcome,
- release or refund according to failure policy,
- record estimated platform cost, estimated provider cost, and actual provider cost,
- make Stripe webhooks idempotent and replay-safe,
- support manual invoice billing as a future enterprise option.

## Service-level objectives

Initial targets:

- API availability: 99.9% future target
- normal management-page response: p95 under 2 seconds
- successful job enqueue: p95 under 5 seconds
- upload-to-first-preview target: under 10 minutes under normal provider conditions
- no acknowledged generation job lost
- RPO and RTO documented per production tier

Provider generation time is tracked separately from platform processing time.

## Observability

Use structured logs, metrics, traces, and correlation IDs across web, API, queue, worker, WaveSpeedAI adapter, storage, FFmpeg, and billing.

Key metrics:

- active organizations and users
- uploads and storage usage
- queued/running/failed jobs
- queue wait time
- provider latency and failure rate by model
- composition/validation failure rate
- retry and dead-letter counts
- generation cost and margin per output
- credit reservation/settlement discrepancies
- approval and regeneration rate

Sensitive values and signed URLs are redacted.

## Queue and worker operations

- bounded concurrency by model and account limit
- exponential backoff with jitter
- job heartbeat and stale-job recovery
- dead-letter state with support tooling
- idempotent scene and composition steps
- graceful shutdown and lease release
- provider circuit breaker during sustained failure
- configurable emergency pause for new generation submissions

## WaveSpeedAI outage handling

During provider degradation:

1. stop or slow new provider submissions,
2. keep accepted jobs in a visible queued state,
3. do not consume final credits before successful settlement,
4. preserve completed scene clips,
5. display provider-delay messaging without exposing internal details,
6. resume safely using stored prediction references,
7. allow support-controlled cancellation and credit release.

Provider replacement is an operationally tested capability, not an automatic silent switch unless output and pricing compatibility are verified.

## Storage operations

- private buckets/containers
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

## Support tooling

Support users can search by public request/job ID, view sanitized status history, release a stuck credit reservation, retry eligible steps, cancel a job, and revoke a share link. Cross-tenant content access requires explicit approval and creates an audit event.

## Business continuity

Document backups, restore testing, secret rotation, WaveSpeedAI outage handling, queue recovery, database failure, storage failure, billing webhook backlog, security incident, and customer communication procedures.

## Launch checklist

- production infrastructure and domains
- monitoring and alerting
- backups and restore test
- billing reconciliation test
- WaveSpeedAI production credentials and spending controls
- commercial-use/data-processing review
- terms, privacy policy, AI disclosure, and support policy
- incident contacts and on-call rota
- load and failure-recovery test
- first-customer onboarding and rollback plan