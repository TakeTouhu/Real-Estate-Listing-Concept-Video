# System Architecture

Version: 1.0
Status: Draft

## Architecture policy

Start as a modular monolith with independently scalable asynchronous video-generation workers.

- Web/API: TypeScript + Next.js
- Database: PostgreSQL + Prisma
- Object storage: S3-compatible or Azure Blob Storage
- Queue: Redis/BullMQ, SQS, or Azure Service Bus
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
  ├── PostgreSQL
  ├── Object Storage
  └── Job Queue
          ↓
Generation Worker / Orchestrator
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

Generation APIs return immediately after validation, credit reservation, idempotent job creation, and enqueueing. Workers emit progress and terminal status. Credit settlement is transactional and exact-once.

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