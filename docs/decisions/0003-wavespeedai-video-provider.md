# ADR-0003: WaveSpeedAI video provider, adapter boundary, and provider replacement

- Status: Accepted
- Date: 2026-07-27
- Phase: 0 (skeleton); real calls in Phase 4

## Context

`CLAUDE.md`, `docs/WaveSpeedAIIntegration.md`, and `docs/SystemArchitecture.md`
require WaveSpeedAI as the initial image-to-video provider while keeping the
architecture provider-replaceable. Phase 0 must establish and prove the adapter
boundary but must **not** call the real WaveSpeedAI API.

## Decision

### 1. WaveSpeedAI is the initial provider

Implemented as `WaveSpeedVideoProvider` in `packages/video-providers`. Default
configuration (from `docs/WaveSpeedAIIntegration.md`):

- base URL `https://api.wavespeed.ai/api/v3`
- model `wavespeed-ai/open-video/image-to-video`
- model ID, pricing, limits, and poll timings are **configuration data**, not
  hard-coded constants.

### 2. Adapter boundary

The only seam is the `VideoGenerationProvider` interface
(`createGeneration`, `getStatus`, `cancelGeneration`, `estimateCost`,
`normalizeError`). Domain and UI code depend on this interface and on
normalized internal types only (`ProviderGenerationInput/Ref/Status`,
`ProviderError`, `Money`). No WaveSpeed-specific payload shape crosses the
boundary; request/response mapping lives in `packages/video-providers/src/wavespeed`.

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
period. (Wired end-to-end in Phase 4.)

### 5. Managed-storage copy

Completed provider outputs are downloaded from the temporary provider URL,
validated, and copied into organization-scoped managed object storage. Temporary
provider URLs and prediction IDs are never exposed to customers. (Implemented in
Phase 4 with `packages/storage`.)

### 6. Provider replacement strategy

Adding or switching providers means implementing `VideoGenerationProvider`
again; selection is via the `VIDEO_PROVIDER` env and the `createVideoProvider`
factory. `FakeVideoProvider` is the offline default used in Phase 0, local dev,
and tests. Replacement is an operationally tested capability, not an automatic
silent switch (`docs/SaaSOperations.md`).

### 7. Phase 0 safety

All WaveSpeed HTTP access goes through an injected `HttpClient`; tests inject a
stub, and the factory only constructs a real `fetch` client when
`VIDEO_PROVIDER=wavespeed` with a key present. The Phase 0 default is `fake`, so
no real WaveSpeedAI request is possible.

## Consequences

- The exact WaveSpeedAI request/response shapes, model capabilities, pricing,
  and commercial-use terms are treated as **candidates** and must be verified
  against official documentation before Phase 4 / production (tracked in
  `docs/decisions/TODO.md`).
- Cost estimation currently uses placeholder pricing.
- Provider errors are normalized so retry/settlement logic never branches on
  vendor-specific error shapes.
