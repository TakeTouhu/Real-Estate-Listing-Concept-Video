# System Architecture

Version: 1.0
Status: Draft

## Architecture policy

Start as a modular monolith with independently scalable asynchronous video-generation workers.

- Web/API: TypeScript + Next.js
- Database: PostgreSQL + Prisma
- Object storage: S3-compatible or Azure Blob Storage
- Queue: **none — superseded 2026-08-18 by ADR-0024.** The `scene_generations`
  row is the durable queue: work is discovered by `state = 'QUEUED'` over the
  existing index, not delivered by a transport. Redis/BullMQ, SQS and Azure
  Service Bus were each evaluated and rejected there; adding one later is a
  decision that must supersede that ADR, not a default to fall back on
- Worker: containerized process
- Video composition: FFmpeg
- Authentication: email and optional Entra ID / Google
- Billing: Stripe
- Observability: OpenTelemetry

## Logical architecture

```text
Browser
  ↓
Next.js Web / BFF
  ├── PostgreSQL  (also the durable work queue — ADR-0024)
  └── Object Storage
          ↓
Generation Worker / Orchestrator  (discovers work by scanning for QUEUED rows)
  ├── Vision Adapter
  ├── WaveSpeedVideoProvider
  └── FFmpeg Composer
          ↓
Managed Video Output
          ↓
Review / Approval / Download
```

## Domain modules

- Identity and Organization
- Property
- Media Asset
- AI Analysis
- Storyboard
- Video Project
- Generation Job
- Video Output
- Billing and Credits
- Audit and Compliance

## Multi-tenancy

Every tenant-owned business table contains `organization_id`. Organization scope is resolved from the authenticated session, enforced in the application/data-access layer, and covered by automated isolation tests. Storage keys are organization-prefixed. Signed URLs are short-lived.

## Asynchronous generation

Generation APIs return immediately after validation, credit reservation, and durable creation of the generation row. Workers emit progress and terminal status. Credit settlement is transactional and exact-once.

**Superseded 2026-08-18 by ADR-0024:** there is no enqueue step. Admission is `create → audit`, and the durable row in `QUEUED` *is* the acceptance condition — a worker discovers executable work by scanning for that state. Nothing is handed to a transport, so nothing can be lost between admission and execution, and no recovery sweep is owed for work that was persisted but never delivered.

## Provider abstraction

```ts
interface VideoGenerationProvider {
  createGeneration(input: ProviderGenerationInput): Promise<ProviderGenerationRef>;
  getStatus(ref: ProviderGenerationRef): Promise<ProviderGenerationStatus>;
  cancelGeneration(ref: ProviderGenerationRef): Promise<void>;
  estimateCost(input: ProviderGenerationInput): Promise<Money>;
  normalizeError(error: unknown): ProviderError;
}
```

WaveSpeedAI is the initial implementation, but provider-specific SDKs and payloads stay inside `packages/video-providers`.

## Environments

- local
- development
- staging
- production

Each environment uses separate identity configuration, database, storage, queues, billing keys, and WaveSpeedAI secrets. Production customer data must not be copied into development.