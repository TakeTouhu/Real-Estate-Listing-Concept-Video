# WaveSpeedAI Integration

Version: 2.0
Status: Primary candidate — **NOT ACTIVATED**

Authority: ADR-0054 Decision 2 and Decision 7.

> **WaveSpeedAI is the primary candidate for the initial commercial release.
> This document is not authorization to activate it.** Paid Provider Activation,
> production provider credentials and production paid calls all remain
> **BLOCKED** and require explicit CTO authorization in a future work package.
>
> Before any paid production activation, every item in the re-verification list
> below must be checked against current reality rather than against this
> document. Only verified production routes may be enabled.

## Purpose

Define the candidate production integration with WaveSpeedAI for image-to-video
generation while preserving a provider-replaceable architecture.

**Provider and model identity never reaches a customer-facing surface.**
Customers choose only Normal (720p) or HQ (1080p); VTaVision maps that to a
verified route internally by quality, cost, availability and Safety Guard
(ADR-0052 Decision 6).

## Re-verification required before activation

- commercial-use rights and terms
- current pricing
- 720p support
- 1080p support
- supported durations
- the image-to-video contract
- concurrency and rate limits
- provider retention
- webhook / auth mechanism
- cancellation capability
- actual output quality
- observed failure rate
- observed latency
- Unit economics

A **Cost Safety Guard** decision must precede every paid submission: no route may
knowingly run at a loss, and if none qualifies, admission is safely rejected or
paused rather than submitted (ADR-0054 Decision 3).

Initial release prefers **one primary provider and at most one defined fallback
candidate**. Unconstrained automatic multi-provider routing is out of scope.

## Configuration

Required server-side configuration:

```text
WAVESPEED_API_KEY
WAVESPEED_API_BASE_URL=https://api.wavespeed.ai/api/v3
WAVESPEED_VIDEO_MODEL_ID=wavespeed-ai/open-video/image-to-video
WAVESPEED_WEBHOOK_SECRET
WAVESPEED_POLL_INITIAL_MS
WAVESPEED_POLL_MAX_MS
WAVESPEED_POLL_TIMEOUT_MS
```

Never expose secrets to the browser or commit them. Current endpoint shapes, model capabilities, pricing, limits, and commercial terms must be verified against official WaveSpeedAI documentation during implementation and before production launch.

## Adapter boundary

Implement `WaveSpeedVideoProvider` behind `VideoGenerationProvider`. Domain services receive normalized internal types only.

Provider responsibilities:

- map internal scene request to current WaveSpeedAI request payload,
- submit prediction with Bearer authentication,
- return an internal provider reference,
- query and normalize prediction status,
- cancel when supported,
- estimate cost from configured model capabilities,
- normalize provider errors,
- redact sensitive fields from logs.

## Asynchronous flow

1. Create a short-lived signed URL for the normalized source image.
2. Submit an image-to-video prediction to the configured model endpoint.
3. Store provider, model ID, prediction ID, request hash, and timestamps internally.
4. Receive a verified webhook or poll status using exponential backoff with jitter.
5. Stop polling on terminal states or configured timeout.
6. On success, download the output from the temporary provider URL.
7. Validate MIME type, size, duration, codec, and safety.
8. Copy to organization-scoped managed object storage.
9. Delete or expire temporary references and expose only an application-signed download URL.

## Status normalization

Map provider-specific states into:

- `QUEUED`
- `PROCESSING`
- `SUCCEEDED`
- `FAILED_RETRYABLE`
- `FAILED_TERMINAL`
- `CANCELLED`
- `TIMED_OUT`

Unknown states are treated as non-terminal for a short bounded period, then moved to manual investigation.

## Webhook security

- Verify the current provider-supported authentication/signature mechanism.
- Reject invalid, expired, or replayed events.
- Deduplicate using provider event ID or stable payload hash.
- Do not trust tenant or customer identifiers from webhook payloads; resolve from stored prediction records.
- Return quickly; record the event and let the worker pick the affected
  generation up by state. There is no enqueue step (ADR-0024).

## Polling fallback

Use exponential backoff with jitter, a maximum interval, a hard deadline, and cancellation awareness. Do not poll from browser code. Polling must be restart-safe after worker failure.

## Input URL security

WaveSpeedAI may require a reachable image URL. Use a single-purpose, short-lived signed URL with minimum permissions. Do not include customer names, addresses, or secrets in object keys or query parameters.

## Error policy

Retry network failures, rate limits, and supported transient provider errors within configured limits. Do not automatically retry moderation failures, invalid input, unsupported options, or repeated quality failures. Preserve a sanitized failure reason for customer support.

## Cost and billing

Store configured estimated provider cost and observed actual cost separately. Provider submission and internal credit settlement use idempotency controls. Reusing a completed provider clip after an internal composition failure must not create a second provider charge.

## Testing

- request mapping fixtures,
- status normalization,
- error normalization,
- secret and URL redaction,
- webhook verification/deduplication,
- polling timeout/recovery,
- output download and managed-storage copy,
- exact-once settlement,
- optional spending-limited contract test in a protected environment.