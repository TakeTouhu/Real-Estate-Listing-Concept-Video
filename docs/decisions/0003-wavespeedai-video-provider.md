# ADR-0003: WaveSpeedAI video provider, adapter boundary, and provider replacement

- Status: Accepted
- Date: 2026-07-27
- Phase: 0 (interface + ADR only); `WaveSpeedVideoProvider` implemented in Phase 1

## Context

`CLAUDE.md`, `docs/WaveSpeedAIIntegration.md`, and `docs/SystemArchitecture.md`
require WaveSpeedAI as the initial image-to-video provider while keeping the
architecture provider-replaceable. Phase 0 must establish and confirm the
adapter boundary and record the decision, but must **not** call the real
WaveSpeedAI API and must **not** contain provider integration code, webhook
handlers, or polling workers. `WaveSpeedVideoProvider` implementation begins in
Phase 1 after Phase 0 is merged.

## Decision

### 1. WaveSpeedAI is the initial provider

The concrete `WaveSpeedVideoProvider` will be implemented in
`packages/video-providers` in **Phase 1**, behind the `VideoGenerationProvider`
interface, using the configuration in `docs/WaveSpeedAIIntegration.md`:

- base URL `https://api.wavespeed.ai/api/v3`
- model `wavespeed-ai/open-video/image-to-video`
- model ID, pricing, limits, and poll timings are **configuration data**, not
  hard-coded constants.

### 2. Adapter boundary (established in Phase 0)

The only seam is the `VideoGenerationProvider` interface
(`createGeneration`, `getStatus`, `cancelGeneration`, `estimateCost`,
`normalizeError`). Domain and UI code depend on this interface and on
normalized internal types only (`ProviderGenerationInput/Ref/Status`,
`ProviderError`, `Money`). No provider-specific payload shape will cross the
boundary; WaveSpeed request/response mapping will live inside
`packages/video-providers` when implemented. In Phase 0 the boundary is proven
by `FakeVideoProvider`, the offline default.

### 3. Server-side secrets

`WAVESPEED_API_KEY` (and webhook secret) are server-side only, validated via the
Zod server-env schema, never imported by client code, and never logged — the
observability logger redacts authorization headers, keys, signed URLs, and
prediction IDs.

### 4. Asynchronous processing

Generation is submitted as an asynchronous prediction; the provider prediction
ID is stored internally. Status is obtained via verified webhook (preferred) or
bounded exponential-backoff polling (fallback), normalized into
`QUEUED / PROCESSING / SUCCEEDED / FAILED_RETRYABLE / FAILED_TERMINAL /
CANCELLED / TIMED_OUT`. Unknown states are treated as non-terminal for a bounded
period. (Implemented in Phase 1.)

### 5. Managed-storage copy

Completed provider outputs are downloaded from the temporary provider URL,
validated, and copied into organization-scoped managed object storage. Temporary
provider URLs and prediction IDs are never exposed to customers. (Implemented in
Phase 1 with `packages/storage`.)

### 6. Provider replacement strategy

Adding or switching providers means implementing `VideoGenerationProvider`
again; selection is via the `VIDEO_PROVIDER` env and the `createVideoProvider`
factory. `FakeVideoProvider` is the offline default used in Phase 0, local dev,
and tests. Replacement is an operationally tested capability, not an automatic
silent switch (`docs/SaaSOperations.md`).

### 7. Phase 0 safety

The Phase 0 default is `VIDEO_PROVIDER=fake`; the factory throws a configuration
error if `wavespeed` is selected, because that provider is not implemented until
Phase 1. No real WaveSpeedAI request is possible in Phase 0.

## Consequences

- The current WaveSpeedAI public API contract was verified against the official
  documentation on 2026-07-27; it matches `docs/WaveSpeedAIIntegration.md`, so
  that document was not changed. The verification snapshot is recorded in
  ADR-0005.
- Remaining items to confirm before Phase 1 completion / production (webhook
  signature mechanism, cancellation support, real pricing, commercial-use
  terms) are tracked in `docs/decisions/TODO.md`.
- Provider errors are normalized so retry/settlement logic never branches on
  vendor-specific error shapes.
