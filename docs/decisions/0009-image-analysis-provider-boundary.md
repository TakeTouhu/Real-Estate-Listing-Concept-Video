# ADR-0009: Image-analysis provider boundary

- Status: Accepted
- Date: 2026-07-28
- Phase: 3A

## Context

Phase 3 introduces AI analysis of uploaded photos (room classification, quality,
duplicate, privacy, and safety findings). `docs/AIVideoPipeline.md` requires that
vision work sit behind a stable adapter, and the reviewer directed that Phase 3
use **offline/deterministic adapters only** with **no real vision vendor
integrated**.

## Decision

### 1. A single provider seam

`ImageAnalysisProvider` (in `@app/domain`) is the only way the platform performs
image analysis:

```ts
interface ImageAnalysisProvider {
  readonly name: string;
  analyze(request: AnalysisRequest): Promise<AnalysisResult>;
  normalizeError(error: unknown): AnalysisProviderError;
}
```

This mirrors the `VideoGenerationProvider` pattern established in ADR-0003, so
both AI seams behave the same way.

### 2. Normalized request and result only

`AnalysisRequest` carries internal identifiers, image bytes, dimensions, MIME
type, and the Phase 2 perceptual hash — never customer names or addresses.
`AnalysisResult` carries a `RoomType` from the fixed 15-value vocabulary,
normalized 0..1 scores, detected objects, and safety flags. No vendor payload
shape crosses the boundary.

### 3. Defensive normalization is platform-owned

`normalizeAnalysisResult` runs for **every** provider:

- unknown room types collapse to `OTHER` with confidence `0`;
- scores are clamped to 0..1, and **any non-finite value becomes 0** so
  malformed provider output can never inflate a quality score;
- detected objects are capped at 50 and safety flags at 20.

`deriveQualityFlags` adds resolution, blur, and exposure warnings from platform
rules rather than provider claims, so findings are consistent across providers.

### 4. Errors are normalized, and retryability is explicit

`AnalysisProviderError` classifies failures into
`INVALID_INPUT | UNSUPPORTED | RATE_LIMITED | TIMEOUT | PROVIDER | UNKNOWN`.
Only `RATE_LIMITED`, `TIMEOUT`, and `PROVIDER` default to retryable;
`messageSanitized` is safe for logs and support and never contains a raw
provider payload.

### 5. Ordering and duplicate rules live in the domain

`roomOrderRank` encodes the documented sequence (exterior → entrance → hallway →
living → dining → kitchen → bedroom → wet areas → storage → balcony) and
`resolveDuplicateGroup` reuses the Phase 2 perceptual hash plus hamming distance
to assign stable duplicate groups. Providers do not decide ordering or grouping.

### 6. Phase 3 ships one deterministic offline adapter

`DeterministicImageAnalysisProvider` (in `@app/ai-providers`) performs **no
network I/O**. Room type and per-asset scores derive from a SHA-256 of the asset
id, and brightness is measured from the actual image bytes, so results are stable
per asset, vary across a property, and are reproducible in CI.

`ANALYSIS_PROVIDER` selects the provider and accepts only `deterministic`; the
factory throws a configuration error for anything else rather than silently
degrading.

### 7. Low confidence never proceeds silently

`LOW_CONFIDENCE_THRESHOLD` (0.6) and `isLowConfidence` mark records that require
human confirmation. Phase 3A only records the signal; enforcing confirmation is
Phase 3B's review UI.

## Consequences

- **The deterministic adapter is a structural stand-in, not a classifier.** It
  makes no claim about the real content of a photo, so its room labels must not
  be presented to customers as accurate until a real provider is integrated.
  Phase 3B makes every decision correctable, which is the safeguard.
- Integrating a real vision vendor is a separate decision requiring its own ADR,
  cost controls, data-processing review, and — per the ADR-0008 precedent — a
  production-safety guard on any non-production adapter.
- Because normalization and rules are platform-owned, swapping providers changes
  one class and no domain or UI code.
