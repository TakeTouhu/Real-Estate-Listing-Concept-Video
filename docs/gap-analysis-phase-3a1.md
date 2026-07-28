# Phase 3A-1 Gap Analysis

Version: 1.0
Status: Complete
Scope: Phase 3A-1 — analysis contracts and deterministic offline provider
Parent: `docs/phase-3-milestone-plan.md` (Phase 3A, split — see below)

## Why Phase 3A was split

Phase 3A as scoped by the reviewer measured **~2,058 changed lines** before
documentation (~2,950 with docs) — roughly 4–6× the ~500-line guideline in
`CLAUDE.md` v1.3. The governance instruction is explicit: *"If the milestone
exceeds the guideline, split Phase 3A before continuing."*

Phase 3A is therefore delivered as three sequential milestones:

| Milestone | Content | Size (excl. lockfile/migration SQL) | Status |
| --- | --- | --- | --- |
| **3A-1** | Analysis contracts, normalization, ordering/duplicate rules, deterministic offline provider, `ANALYSIS_PROVIDER` config | **869 lines** | **This PR** |
| 3A-2 | Prisma `AssetAnalysis` model + migration + tenant-scoped repository, in-memory repository, `AnalysisService` (authorization, audit, idempotency, READY-only validation) | ~790 lines | Implemented and held, not pushed |
| 3A-3 | Live PostgreSQL CI job, migration-from-empty and repository tenant-isolation integration tests | ~462 lines | Implemented and held, not pushed |

3A-2 and 3A-3 are already written and verified locally (including the live
PostgreSQL suite passing from an empty database), but are **withheld from this
branch** so each milestone is reviewed independently, per the governance rule
against adding later-milestone code to an earlier milestone's branch.

## Starting state (after Phase 2 merge, `653372a`)

- Properties, media assets, secure upload, object storage, image processing, and
  perceptual hashing were in place.
- `packages/ai-providers` was still a placeholder; no analysis entity, provider
  seam, or room vocabulary existed.

## Requirement-by-requirement analysis (3A-1 subset)

| Phase 3A requirement | Before | Delivered in 3A-1 |
| --- | --- | --- |
| `AssetAnalysis` domain entity | Missing | ✅ `analysis/types.ts` — full record shape per `docs/DataModel.md` |
| Room-type classification result | Missing | ✅ 15-value `RoomType` vocabulary + `isRoomType` guard |
| Confidence score | Missing | ✅ normalized 0..1, `LOW_CONFIDENCE_THRESHOLD`, `isLowConfidence` |
| Quality score | Missing | ✅ normalized 0..1 |
| Brightness score | Missing | ✅ normalized 0..1, measured from real bytes by the adapter |
| Blur score | Missing | ✅ normalized 0..1 |
| Duplicate-group reference | Missing | ✅ `resolveDuplicateGroup` over Phase 2 perceptual hashes |
| Detected-object metadata | Missing | ✅ `DetectedObject[]`, capped and clamped |
| Safety and privacy flags | Missing | ✅ 8 flag codes × `BLOCKING`/`WARNING`, `hasBlockingFlag` |
| Suggested display order | Missing | ✅ `roomOrderRank` implementing the documented sequence |
| Analysis status and failure reason | Missing | ✅ `AnalysisStatus` (`PENDING`/`SUCCEEDED`/`FAILED`) + `failureReason` field |
| `ImageAnalysisProvider` interface | Missing | ✅ `analysis/ports.ts` (ADR-0009) |
| Deterministic offline analysis adapter | Missing | ✅ `DeterministicImageAnalysisProvider`, no network I/O |
| Provider request/result normalization | Missing | ✅ `normalizeAnalysisResult`, `deriveQualityFlags`, `analysisProviderError` |
| No real external AI calls | n/a | ✅ `ANALYSIS_PROVIDER` accepts `deterministic` only; factory fails fast otherwise |
| Prisma model and migration | Missing | ⏭ **3A-2** |
| Tenant-scoped repository | Missing | ⏭ **3A-2** |
| Analysis service with authorization | Missing | ⏭ **3A-2** |
| Audit logging | Missing | ⏭ **3A-2** (audit action vocabulary is in 3A-1) |
| Idempotent creation or refresh | Missing | ⏭ **3A-2** |
| READY-only eligibility validation | Missing | ⏭ **3A-2** |
| Live PostgreSQL CI | Missing | ⏭ **3A-3** |
| No review UI / storyboard / prompt compilation | n/a | ✅ none added |

## Deliberately not in 3A-1

- No persistence: no Prisma model, migration, or repository — so this milestone
  cannot write an analysis anywhere yet. That is intentional; 3A-1 is the
  contract layer plus the offline adapter.
- No `AnalysisService`, therefore no authorization, audit emission, or
  idempotency behaviour to test yet. The audit **action vocabulary**
  (`analysis/audit.ts`) ships here so 3A-2 adds no new constants.
- No user-facing UI, no storyboard generation, no prompt compilation
  (Phase 3B/3C).
- No real vision provider (reviewer decision; ADR-0009).

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` all pass.
- 162 unit tests (was 131): +21 contract tests, +10 provider tests.
- Unit tests require **no database** — verified by running with `DATABASE_URL`
  unset.

## Known limitations carried forward

- The deterministic adapter is a structural stand-in and makes no claim about
  real photo content; its labels must not be shown to customers as accurate
  until a real provider exists. Phase 3B makes every decision correctable.
- `packages/queue` remains a placeholder; analysis still runs synchronously when
  wired in 3A-2 (moving it to the worker is a Phase 4 follow-up).
