# API Change Summary — Phase 3A-1

Version: 1.0

## Not applicable

**Phase 3A-1 introduces no HTTP API changes.** No endpoint was added, removed,
modified, or deprecated, and no request or response shape changed.

Reason: 3A-1 delivers the internal analysis contract layer only — domain types,
the `ImageAnalysisProvider` interface, normalization and ordering/duplicate
rules, and the deterministic offline adapter. None of it is reachable over HTTP
because the orchestrating `AnalysisService` and its persistence land in Phase
3A-2, and the user-facing review surface is Phase 3B.

The complete Phase 2 API surface documented in `docs/api-changes-phase-2.md`
remains unchanged and is still accurate.

## Configuration change (not an API change)

One server-side environment variable was added:

| Variable | Values | Default | Notes |
| --- | --- | --- | --- |
| `ANALYSIS_PROVIDER` | `deterministic` | `deterministic` | Server-side only. Accepts `deterministic` only in Phase 3; the factory throws `CONFIGURATION_ERROR` for any other value rather than degrading silently (ADR-0009). Not a secret. |

## Expected API changes in later milestones

Recorded here so reviewers know what is deliberately absent:

| Milestone | Anticipated endpoints |
| --- | --- |
| 3A-2 | none required (service is called internally; HTTP exposure deferred) |
| 3B | `GET /api/properties/{propertyId}/analyses`, `PATCH /api/analyses/{analysisId}`, bulk reorder |
| 3C | `POST /api/video-projects/{projectId}/storyboard/generate`, storyboard read/patch |
