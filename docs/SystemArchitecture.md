# System Architecture

Version: 2.0
Status: Approved initial-release contract (pre-Commercial-Launch)

Authority: ADR-0054 for the production platform. Historical ADRs keep their
original platform reasoning as history.

## Architecture policy

Start as a modular monolith with independently scalable asynchronous video-generation workers.

- Web/API: TypeScript + Next.js
- Database: PostgreSQL + Prisma
- Object storage: **Google Cloud Storage** in production (ADR-0054 Decision 1),
  behind the provider-neutral `ObjectStorage` port. The port is the architecture;
  the cloud is a deployment choice. **The domain must not depend on Google Cloud
  SDK types.** The earlier "S3-compatible or Azure Blob Storage" statement is
  superseded for the initial production deployment; ADR-0008's port decision is
  unchanged and is what makes the substitution cheap.
- Queue: **none — superseded 2026-08-18 by ADR-0024.** The `scene_generations`
  row is the durable queue: work is discovered by `state = 'QUEUED'` over the
  existing index, not delivered by a transport. Redis/BullMQ, SQS and Azure
  Service Bus were each evaluated and rejected there; adding one later is a
  decision that must supersede that ADR, not a default to fall back on
- Worker: containerized process
- Video composition: FFmpeg
- Authentication: email/password with mandatory verification and TOTP MFA in the
  initial release. **Entra ID and Google SSO are post-release**, and explicitly
  retained on the roadmap (ADR-0052 Decision 18).
- Billing: Stripe for web self-service; invoice/bank transfer for sales-assisted
  contracts. **Stripe is a payment processor, not the pricing authority**
  (ADR-0053 Decision 5).
- Observability: OpenTelemetry, surfaced through Cloud Logging / Cloud Monitoring
  / Google Cloud Observability in production
- Production compute: Cloud Run for web/API, Cloud Run Jobs or equivalent worker
  execution for asynchronous and FFmpeg workloads; Cloud SQL for PostgreSQL;
  Secret Manager; Artifact Registry; Google Cloud IAM
- Scheduling: **Cloud Scheduler only after explicit CTO activation approval** —
  activation remains BLOCKED (ADR-0054 Decision 7)

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
Technical Validation
          ↓
Private-workspace delivery → customer Preview → Download
```

**There is no approval stage.** Delivery is internal to the customer's own
organization and is not external publication, so no Approve/Reject step stands
between a technically valid deliverable and the customer (ADR-0052 Decision 2).
The human step that *does* exist is earlier and concerns source material:
**source-photo analysis review** (`analysis.review`), between AI analysis and
storyboard.

## Domain modules

- Identity and Organization
- Property
- Media Asset
- AI Analysis
- Storyboard
- Video Project
- Scene Generation Attempt
- Video Output
- Billing and Credits
- Audit and Compliance

## Multi-tenancy

Every tenant-owned aggregate is organization-scoped. **Scope is not always a column.** A table either carries `organizationId` directly, or inherits authoritative scope through a required parent relation — both are first-class, and the second is what several tables actually do.

- `SceneGeneration` → `VideoProject` → `organizationId`. The generation row carries **no** `organizationId` of its own; its tenant is whichever organization owns the parent project, resolved as a join predicate inside every query rather than as an application-side check that could be forgotten.
- Data-access boundaries enforce tenant scope: tenant-facing repository methods take `organizationId` as an addressing argument, so a read that forgets to scope is a missing predicate rather than a silently unfiltered result.
- Automated isolation tests cover it.

Organization scope is resolved from the authenticated session. Storage keys are organization-prefixed. Signed URLs are short-lived.

## Asynchronous generation

Generation APIs return immediately after validation, credit reservation, and durable creation of the generation row. Workers emit progress and terminal status. Credit settlement is transactional and exact-once.

**Superseded 2026-08-18 by ADR-0024:** there is no enqueue step. Admission is `create → audit`, and the durable row in `QUEUED` *is* the acceptance condition — a worker discovers executable work by scanning for that state. Nothing is handed to a transport, so nothing can be lost between admission and execution, and no recovery sweep is owed for work that was persisted but never delivered.

## Provider abstraction

```ts
interface VideoGenerationSubmissionProvider {
  createGeneration(input: ProviderGenerationInput): Promise<ProviderSubmissionOutcome>;
  normalizeError(error: unknown): ProviderError;
}

interface VideoGenerationProvider extends VideoGenerationSubmissionProvider {
  getStatus(ref: ProviderGenerationRef): Promise<ProviderGenerationStatus>;
  cancelGeneration(ref: ProviderGenerationRef): Promise<void>;
  estimateCost(input: ProviderGenerationInput): Promise<Money>;
}
```

**Amended 2026-09-02 by ADR-0035:** submission returns a certainty outcome —
`ACCEPTED`, `DEFINITIVELY_REJECTED` or `SUBMISSION_UNKNOWN` — rather than a bare
ref, and does not throw for expected provider or transport failures. It is split
into its own port because it is the only call whose failure is financial: a
create POST that fails may already have been billed, and `retryable` describes
the transport rather than the provider's decision. Status and cancellation keep
their exception behaviour; neither can incur a charge.

WaveSpeedAI is the initial *adapter implementation* and the **primary candidate** route — not an activated or guaranteed one; only a verified route may be enabled (ADR-0054 Decision 2). Provider-specific SDKs and payloads stay inside `packages/video-providers`, which is what keeps the route replaceable.

## Environments

- local
- development
- staging
- production

Each environment uses separate identity configuration, database, storage, billing keys, and WaveSpeedAI secrets. Production customer data must not be copied into development.