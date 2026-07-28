# Changelog

All notable changes to this project. Phases correspond to `docs/Roadmap.md`.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — Phase 3A-2a: analysis persistence and live-PostgreSQL CI

Under review. Not merged. Second Phase 3A milestone; scoped to persistence and
its verification only — see `docs/phase-3a2a-completion.md`.

### Added

- **`asset_analyses` table** (`packages/database/prisma/schema.prisma`) with the
  `AnalysisStatus` and `RoomType` enums, a unique `assetId` foreign key to
  `media_assets` (`ON DELETE CASCADE`), `jsonb` columns for detected objects and
  safety flags, and indexes on `(organizationId, status)` and
  `(organizationId, duplicateGroup)`.
- **Migration `00000000000002_phase3a2_asset_analysis`** — additive only, no
  backfill, generated from the committed schema.
- **`createPrismaAnalysisRepository`** implementing the Phase 3A-1
  `AssetAnalysisRepository` port. Every read filters on `organizationId`, so
  another tenant's row is not found rather than merely forbidden.
- **Live-PostgreSQL CI job** (`database` in `.github/workflows/ci.yml`): applies
  the committed migrations to an empty PostgreSQL 16 service container, runs the
  shadow-database drift check with `--exit-code`, and executes the integration
  suite. Throwaway credentials only; no production data.
- **`tests/integration/analysis-repository.db.test.ts`** — real-database
  coverage for JSON round-tripping, cross-tenant invisibility, the one-analysis-
  per-asset unique constraint, list filtering, and cascade on asset deletion.
- **`pnpm test:db`** with `vitest.integration.config.ts`; `pnpm test` stays
  offline and requires no database.
- **Root `tsconfig.json`** so the Vitest configs and `tests/**` are typechecked
  (they previously were linted but not typechecked).

### Not included (deliberately)

- No `AnalysisService`: no authorization, audit emission, idempotency, or
  provider invocation yet (Phase 3A-2b).
- No in-memory analysis repository double — it ships with the service that
  consumes it (Phase 3A-2b).
- No HTTP endpoints, review UI, storyboard generation, or prompt compilation
  (Phase 3A-3 / 3B / 3C).
- **No real vision provider** — offline deterministic adapter only (ADR-0009).

## [phase-3a1-complete] — Phase 3A-1: analysis contracts and deterministic offline provider

Merged in PR #4 as `a2bbf473512c8f0c0df4121b1111e66b08699dd7`.
Tagged `phase-3a1-complete` locally; the remote tag is **not** yet published
(see `docs/progress.md`). First Phase 3A milestone — see
`docs/gap-analysis-phase-3a1.md` for why Phase 3A was split.

### Added

- **Analysis domain contracts (`@app/domain`)**
  - `AssetAnalysis` entity: room type, confidence, quality/brightness/blur
    scores, duplicate-group reference, detected objects, safety and privacy
    flags, suggested display order, status, and failure reason.
  - 15-value `RoomType` vocabulary with an `isRoomType` guard, and
    `AnalysisStatus` (`PENDING` / `SUCCEEDED` / `FAILED`).
  - Eight safety/privacy flag codes with `BLOCKING` / `WARNING` severity, plus
    `hasBlockingFlag` and `isLowConfidence` (threshold 0.6).
- **`ImageAnalysisProvider` boundary** with normalized `AnalysisRequest` /
  `AnalysisResult` / `AnalysisProviderError` types (ADR-0009).
- **Platform-owned normalization**: `normalizeAnalysisResult` (unknown room type
  → `OTHER` with zero confidence, scores clamped to 0..1 with any non-finite
  value mapped to 0, objects capped at 50, flags at 20), `deriveQualityFlags`
  (resolution, blur, exposure warnings), and `analysisProviderError` with
  explicit retryability.
- **Ordering and duplicate rules**: `roomOrderRank` implementing the documented
  room sequence, and `resolveDuplicateGroup` reusing Phase 2 perceptual hashes
  with hamming distance.
- **Deterministic offline adapter (`@app/ai-providers`)**:
  `DeterministicImageAnalysisProvider` performs no network I/O; room type and
  scores derive from the asset id, brightness is measured from real bytes.
- **Configuration**: `ANALYSIS_PROVIDER` (server-side, `deterministic` only;
  the factory fails fast on any other value).
- **Documentation**: ADR-0009, Phase 3A-1 gap analysis, analysis lifecycle
  sequence diagram, architecture and ER diagram updates, API change summary
  (not applicable), migration notes, and the Phase 3A-1 completion report.

### Not included (deliberately)

- No persistence: no Prisma model, migration, or repository (Phase 3A-2a).
- No `AnalysisService`, so no audit emission, authorization, or idempotency
  behaviour yet — only the audit action vocabulary (Phase 3A-2b).
- No live PostgreSQL CI job (Phase 3A-2a).
- No review UI, storyboard generation, or prompt compilation (Phase 3B / 3C).
- **No real vision provider** — offline deterministic adapter only (ADR-0009).

## [phase-2-complete] — Phase 2: Properties and secure media upload

Merged in PR #3 as `653372a54d72d8dacc38fb7103ad32f15041cc2f`.
Tagged `phase-2-complete` locally; the remote tag is **not** yet published
(see `docs/progress.md`).

### Added

- **Property management**
  - `Property` domain entity with `PropertyService`: create, get, list, update,
    and soft delete, all organization-scoped and permission-checked.
  - Mandatory photo-rights confirmation when creating a property.
  - `POST`/`GET /api/properties`, plus create forms on the dashboard.
- **Media asset domain**
  - `MediaAsset` entity with a ten-state upload lifecycle and `AssetService`
    (`requestUpload`, `completeUpload`, `retryUpload`, `createDownloadUrl`,
    `requestDeletion`, `list`).
  - Per-property file-count, file-size, and image-dimension limits as
    configuration (`DEFAULT_UPLOAD_LIMITS`).
- **Object storage abstraction (`@app/storage`)**
  - `ObjectStorage` port with `LocalObjectStorage` (in-process) implementation.
  - HMAC-SHA256 signed storage tokens that are expiring and **single-purpose**
    (upload XOR download), bound to exactly one storage key.
  - Tenant-scoped, opaque storage keys:
    `org/{orgId}/properties/{propertyId}/assets/{assetId}/{variant}.{ext}`.
  - `PUT /api/storage/upload` and `GET /api/storage/download`, authorized by
    token alone and never by a caller-supplied key.
- **Media processing pipeline**
  - `SharpImageProcessor`: EXIF/GPS metadata removal, EXIF orientation
    correction, normalization to a bounded long edge, and WebP thumbnails.
  - 64-bit average-hash perceptual hashing (16 hex chars) plus
    `hammingDistanceHex` for the duplicate-detection foundation.
  - `MalwareScanner` port with `PassthroughMalwareScanner` (EICAR-aware) and a
    `QUARANTINED` terminal state.
  - Content-based MIME validation from magic bytes (JPEG/PNG/WebP allowlist).
- **Upload UI**
  - Property detail page with a drag-and-drop `UploadPanel` showing real
    per-file progress via XHR, processing/ready/error states, duplicate hints,
    and a retry action for failed uploads.
- **Persistence**
  - Prisma `Property` and `MediaAsset` models, four new enums, tenant-first
    indexes, and migration `00000000000001_phase2_properties_media`.
  - Organization-scoped Prisma repositories for properties and assets.
- **Audit logging** — eleven new actions covering every property and asset write.
- **Retention foundation** — `DELETION_PENDING`/`DELETED` states,
  `deletionRequestedAt`, `retentionExpiresAt`; deleting a property cascades its
  assets to `DELETION_PENDING`.
- **Configuration** — `STORAGE_SIGNING_SECRET` (server-only, validated).
- **Documentation** — architecture diagram, ER diagram, upload-lifecycle
  sequence diagram, API change summary with an OpenAPI fragment, this changelog,
  release notes, migration notes, `docs/progress.md`, ADR-0008, Phase 2 gap
  analysis, and the Phase 2 completion report.

### Changed

- `recordAudit` now accepts a narrower `AuditSink` dependency so both the
  identity and property domains can emit audit events without coupling.
- `@app/domain` exports the property/media surface; `@app/storage` is no longer
  a placeholder.
- Vitest resolves workspace subpath exports (e.g. `@app/domain/testing`).
- `sharp` is declared in `apps/web` and listed in `serverExternalPackages` so
  Next leaves it external and its native binary resolves under pnpm.

### Security

- Declared filename and Content-Type are never trusted; the real type comes from
  magic bytes and the size is re-verified against the stored object.
- Storage keys contain only internal ids and are never returned to the browser.
- Upload tokens cannot be replayed as download tokens; key tampering invalidates
  the signature; expired tokens are rejected.
- Quarantined, rejected, and failed assets are never downloadable.
- Download responses set `Cache-Control: private, no-store`,
  `X-Content-Type-Options: nosniff`, and a sandboxing CSP.
- Client filenames are stripped of path components and control characters.
- **Production-safety guard:** `LocalObjectStorage` and
  `PassthroughMalwareScanner` throw `NonProductionAdapterError` when
  constructed under `NODE_ENV=production`. The message names the adapter and
  the required action and contains no secrets; development and test are
  unaffected.

### Known limitations

- `LocalObjectStorage` keeps objects in process memory: not durable and not
  multi-instance safe. A durable S3/Azure adapter is required before production.
- Image processing runs inline in the upload-completion request rather than on
  the async worker.
- No live-PostgreSQL integration job in CI yet.

## [phase-1-complete] — Identity, organizations, and tenant isolation

Merged in PR #2 as `62259776f88fa1010736e8a365618b7c20c38902`.

### Added

- PostgreSQL + Prisma persistence with organization-scoped repositories.
- Identity domain: users, organizations, memberships, RBAC roles, invitations.
- Email/password authentication (scrypt) with server-side sessions; session and
  invitation tokens stored only as SHA-256 hashes.
- Audit-log foundation with an event for every identity/organization write.
- Automated cross-tenant isolation tests.
- Real `WaveSpeedVideoProvider` behind `VideoGenerationProvider` with an injected
  HTTP client (no real API calls in tests).

## [phase-0-complete] — Engineering foundation

Merged in PR #1 as `5185fea6fdf5458b72a316ec94fcd0fe9cc54443`.

### Added

- pnpm monorepo, strict TypeScript, ESLint, Vitest, and GitHub Actions CI
  (typecheck, lint, test, build).
- `VideoGenerationProvider` abstraction with an offline `FakeVideoProvider`.
- Authenticated health-check application and worker bootstrap.
- Zod-validated server-only environment and a redacting structured logger.
- ADR-0001…0005, gap analysis, and the Phase 0 completion report.
