# Changelog

All notable changes to this project. Phases correspond to `docs/Roadmap.md`.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — Phase 3B-2: review HTTP endpoints

Under review. Not merged. Exposes the review decisions over HTTP — see
`docs/phase-3b2-completion.md` and `docs/api-changes-phase-3b2.md`.

### Added

- **Two endpoints**, both requiring `video:review` (CREATOR denied):
  - `POST /api/properties/{propertyId}/assets/{assetId}/analysis/approve`
  - `POST /api/properties/{propertyId}/assets/{assetId}/analysis/reject`
  Separate routes rather than one endpoint with a decision field: they are
  distinct consequential actions, and rejection also mutates asset status.
- **Nested `review` object** on the analysis representation — `status`, `note`,
  `reviewedAt`, `reviewedBy`, `analysisRevision`. `reviewedBy` is the reviewer's
  **user id only**, never expanded into name or email. Additive: no previously
  returned field changed name, type, or position, so the Phase 3A-3 endpoints
  gain the object without breaking clients.
- **15 route tests** covering both decisions, the revision travelling with the
  response, duplicate-group refusals, authentication, CREATOR denial, tenant
  isolation, malformed input, and response hygiene.

### Notes

- Route handlers stay thin adapters: **`AnalysisService` has a zero-line diff**.
  Whether a reason is required, whether `primaryAssetId` is needed or matches,
  and whether a revision was already reviewed are all domain rules the routes
  never re-check.
- Duplicate-group conflicts remain **`422`**, asserted by a test to be `422` and
  not `409`. A future `409` needs a distinct domain error kind and is out of
  scope.
- One Phase 3A-3 assertion ("`reviewedBy` never appears") is **superseded** by
  the decision to expose it, and was rewritten rather than deleted: an unreviewed
  analysis must now report `reviewedBy: null`, and no user name or email may
  appear in any body.

### Not included (deliberately)

- No review UI (Phase 3B-3), no rate limiting, no domain change, no Prisma
  schema change, no migration.

## [phase-3b1b-complete] — Phase 3B-1b: review domain logic

Merged in PR #10 as `2f2f3d76d54bc0a6a0d9e8a0f60c3713d3a8cc05`.
Tagged `phase-3b1b-complete` locally; the remote tag is **not** yet published
(see `docs/progress.md`). Makes human review executable — see
`docs/phase-3b1b-completion.md`.

### Added

- **`AnalysisService.approve` / `.reject`**, gated on `video:review` (OWNER,
  ADMIN, REVIEWER). **CREATOR is denied**: whoever runs an analysis is not
  whoever approves it.
- **Blocking findings cannot be approved.** An analysis carrying a `BLOCKING`
  safety flag can only be rejected.
- **Immutable decisions per revision.** A reviewed analysis refuses further
  decisions; refreshing clears the review state and makes it reviewable again.
- **Duplicate groups are a soft block.** With more than one member in the group,
  `primaryAssetId` is required and must equal the asset being approved. Whether
  another member is already approved is decided by the PostgreSQL partial unique
  index — the service performs **no pre-check read**, which would be a
  check-then-act race. The violation is recognized in the Prisma adapter and
  handed to the domain as a neutral `DuplicateApprovalConflictError`, mapped to
  `VALIDATION_FAILED`, and never retried or reconciled.
- **Rejection is transactional**: the analysis review update and
  `MediaAsset.status = REJECTED` commit together or not at all. Rejected assets
  are then excluded downstream by the existing status checks.
- **Reason handling**: required and non-blank for rejection, optional for
  approval, recorded as `null` when absent.
- **`analysisRevision` transitions**: first successful analysis → 1, successful
  refresh → previous + 1, failed refresh → unchanged. Keyed on whether the run
  was a refresh, never inferred from the row reaching `SUCCEEDED`, since an
  initial analysis and a refresh both end there.
- **Audit** `analysis.approved` / `analysis.rejected` carrying `analysisId`,
  `assetId`, `propertyId`, `organizationId`, `actorId`, `reason`, and
  `analysisRevision`.
- **32 new tests** covering revision semantics, approval and rejection,
  immutability, duplicate rules, authorization, tenant isolation, transactional
  failure consistency, and audit payloads.

### Notes

- No Prisma schema or migration change; everything needed shipped in 3B-1a.
- **Database error interpretation lives in the adapter.** The domain reacts to a
  neutral `DuplicateApprovalConflictError` and imports nothing from Prisma;
  recognizing the underlying constraint violation is the repository's job.
- **A live-PostgreSQL test covers the whole runtime path** — service → Prisma
  repositories → PostgreSQL → adapter translation → `AppError`. It caught a real
  defect: the adapter matched the violation by index name, which Prisma never
  reports (it identifies the constraint by covered fields), so the translation
  would silently never have fired in production.
- `InMemoryAssetAnalysisRepository` mirrors the partial unique index and raises
  the same neutral error, so unit tests exercise the mapping rather than passing
  against a permissive double.
- Audit atomicity remains outside the transaction — still the transactional-
  outbox item in `docs/decisions/TODO.md`.

### Not included (deliberately)

- No HTTP endpoints (Phase 3B-2) and no review UI (Phase 3B-3).

## [phase-3b1a-complete] — Phase 3B-1a: review infrastructure

Merged in PR #9 as `0a7818f10371bcf8072b6b8cc2f501c9b5868f97`.
Tagged `phase-3b1a-complete` locally; the remote tag is **not** yet published
(see `docs/progress.md`). Persistence and the transaction boundary for human
review — see `docs/phase-3b1a-completion.md`.

### Added

- **Review columns on `asset_analyses`**: `reviewStatus` (`UNREVIEWED` /
  `APPROVED` / `REJECTED`, default `UNREVIEWED`), `reviewNote`, and
  `analysisRevision` (default 1), plus an index on
  `(organizationId, reviewStatus)`. Additive migration, no backfill.
- **A partial unique index** making the database authoritative for "at most one
  `APPROVED` analysis per duplicate group", so concurrent approvals of two
  members of a group cannot both succeed. Prisma cannot express a partial index,
  so it is hand-written in the migration under **ADR-0011 — database constraints
  beyond the Prisma schema**; the CI drift check still passes, and the
  `prisma migrate dev` caveat is recorded in `docs/migration-notes.md`.
- **`ReviewTransaction` port** with Prisma and in-memory implementations. The
  Prisma implementation rebuilds both repositories against the transaction
  client *inside* `run`, so both writes of a rejection go through the same
  transaction; the in-memory implementation snapshots and restores state on
  throw, giving the double real rollback semantics.
- **Domain review types**: `ReviewStatus`, `REVIEW_STATUSES`, `isReviewStatus`,
  `isReviewed`. `analysisRevision` identifies the persisted *result* — it starts
  at 1 and increments only on a successful refresh, so a failed refresh leaves
  it unchanged.
- **12 new tests**: 8 live-PostgreSQL (partial-index behaviour across five
  cases, transaction commit and rollback, review-column round-trip) and 4 for
  the in-memory transaction double.

### Not included (deliberately)

- No `approve` / `reject` service methods, no audit events, no HTTP surface and
  no UI — Phase 3B-1b onward.
- Audit atomicity is **not** covered by `ReviewTransaction`; it remains the
  transactional-outbox item in `docs/decisions/TODO.md`.

## [phase-3a3-complete] — Phase 3A-3: analysis HTTP endpoints

Merged in PR #8 as `e3fcc7410052ded01e936f75b00dbec239ac2e3e`.
Tagged `phase-3a3-complete` locally; the remote tag is **not** yet published
(see `docs/progress.md`). Closes Phase 3A — see
`docs/phase-3a3-completion.md` and `docs/api-changes-phase-3a3.md`.

### Added

- **Four analysis endpoints**, making `AnalysisService` reachable from the web
  app for the first time:
  - `POST /api/properties/{propertyId}/assets/{assetId}/analysis`
  - `POST /api/properties/{propertyId}/assets/{assetId}/analysis/refresh`
  - `GET  /api/properties/{propertyId}/assets/{assetId}/analysis`
  - `GET  /api/properties/{propertyId}/analyses`
- **Analysis DTO** that omits `organizationId`, the internal `provider` name and
  the unwritten review columns, and adds `lowConfidence` / `hasBlockingFlag`
  derived server-side so clients cannot drift from the documented thresholds.
- **`@app/ai-providers` barrel exports** for `DeterministicImageAnalysisProvider`
  and `createImageAnalysisProvider`. The barrel still held only the Phase 0
  placeholder, so the adapter shipped in 3A-1 was unreachable outside its package.
- **13 route tests** that stub only session resolution and run against a real
  `AnalysisService`, covering idempotency, refresh, eligibility, authentication,
  authorization, tenant isolation, validation, and response hygiene.

### Notes

- Route handlers are thin adapters: authenticate, validate shape, delegate, map.
  No business decision lives in the web layer, and `AnalysisService` is unchanged
  by this milestone.
- `organizationId` is caller-supplied and membership-verified, matching the
  Phase 1/2 convention — the session has no active-organization concept. The
  convention is recorded in **ADR-0010 — organization context resolution**.
- `POST` returns `200` rather than `201`, and a non-`READY` asset is `422` rather
  than `409`: distinguishing those cases in the route would require it to
  interpret why the service refused. See `docs/api-changes-phase-3a3.md`.

### Not included (deliberately)

- **No rate limiting.** No rate limiter exists anywhere in the codebase yet;
  adding one for analysis alone would leave login, registration and upload
  unprotected. Recorded in `docs/decisions/TODO.md` as a cross-cutting milestone.
- No review UI or approval endpoints (Phase 3B), no Prisma schema change, and no
  real vision provider (ADR-0009).

## [phase-3a2c-complete] — Phase 3A-2c: refresh, duplicate grouping, ordering, reads

Merged in PR #7 as `e49ae6aa3466fdeaf8d616084c7163a15f9466f5`.
Tagged `phase-3a2c-complete` locally; the remote tag is **not** yet published
(see `docs/progress.md`). Completes `AnalysisService` to the full Phase 3A-2
contract — see `docs/phase-3a2c-completion.md`.

### Added

- **`refresh` option** on `analyzeAsset`. Recomputes an analysis that already
  `SUCCEEDED`, reusing the same row and calling the provider again, and emits
  `analysis.refreshed`. Without it, an existing `SUCCEEDED` row is still
  returned untouched with no provider call.
- **Stale-state clearing on reservation.** A refresh resets the row to `PENDING`
  with every result field cleared — room type, all four scores, duplicate group,
  detected objects, safety flags, suggested order, failure reason — *before* the
  provider runs, so a refresh that fails ends in `FAILED` with nothing from the
  previous run surviving.
- **Duplicate grouping wired into the success path.** `resolveDuplicateGroup`
  now runs against same-organization assets that carry a perceptual hash,
  excluding the subject asset, and the result is persisted. Both the asset and
  analysis lookups are tenant-scoped, so a cross-tenant photo can never
  influence a group.
- **`suggestedOrder` persisted** via `roomOrderRank`, following the documented
  room sequence; `OTHER` ranks after every recognized room type.
- **Organization-scoped read methods** `listForProperty` and `getForAsset`, with
  read-level authorization — any member may read, including `REVIEWER`, who
  cannot start or refresh an analysis. `getForAsset` throws `NOT_FOUND` when no
  analysis exists.
- **18 new unit tests** covering refresh semantics, stale-state clearing,
  duplicate grouping (identical, distant, cross-tenant, and null hashes), room
  ordering, and read scoping/authorization.

### Not included (deliberately)

- No Prisma schema or migration change — the columns already existed.
- No HTTP endpoints (Phase 3A-3), no review UI (Phase 3B).
- No transactional outbox and no concurrent provider-call deduplication; both
  remain open TODO items.
- **No real vision provider** — offline deterministic adapter only (ADR-0009).

## [phase-3a2b-complete] — Phase 3A-2b: AnalysisService orchestration

Merged in PR #6 as `40580866469b3d891f719cb9d83f17bf8b692081`.
Tagged `phase-3a2b-complete` locally; the remote tag is **not** yet published
(see `docs/progress.md`). Merged as a one-time size exception — see
`docs/phase-3a2b-completion.md`.

### Added

- **`AnalysisService.analyzeAsset`** (`@app/domain`): authorizes
  `property:write`, accepts READY assets only, reserves a `PENDING` row before
  calling the provider, merges provider safety flags with platform-derived
  quality flags keeping the most severe per code, persists `SUCCEEDED`, and
  emits `analysis.requested` / `analysis.succeeded` / `analysis.failed`.
- **Failure-consistent, retry-safe, idempotent at the persisted analysis-row
  level.** Every write is a single-row status transition. A provider failure can
  only produce `FAILED`, never a completed record. A failed terminal write leaves
  the row `PENDING` with null result fields and surfaces the error. Retries reuse
  the existing row and converge on the same result. This is **not** full
  transactional atomicity: the analysis row and its audit entry are written
  separately (see the consistency boundary below).
- **Documented consistency boundary.** The analysis row is persisted *before*
  its audit event, so an audit-sink failure can return an error while the
  analysis remains `SUCCEEDED`. This is intentional — the alternative, losing a
  completed analysis because its audit write failed, is worse. Strict atomicity
  between analysis persistence and audit persistence would require a shared
  database transaction or a transactional outbox; recorded in
  `docs/decisions/TODO.md`.
- **Concurrency reconciliation.** The unique index on `asset_analyses.assetId`
  is the concurrency control: a request whose insert loses the race re-reads and
  adopts the winner's row instead of creating a second one. A create failure
  that is not a uniqueness conflict is rethrown.
- **`InMemoryAssetAnalysisRepository`** (`@app/domain/testing`): organization-
  scoped test double that mirrors the unique-`assetId` constraint and rejects
  asynchronously, the way a real constraint violation surfaces.
- **28 new unit tests**, including the six required resilience cases: provider
  timeout, provider exception, repository write failure, audit write failure,
  repeated retry after failure, and concurrent duplicate requests.

### Not included (deliberately)

- No `refresh` option, so a `SUCCEEDED` analysis cannot yet be recomputed
  (Phase 3A-2c).
- No duplicate-group resolution or `suggestedOrder` persistence, though both
  pure functions exist from 3A-1 (Phase 3A-2c).
- No read APIs (`listForProperty`, `getForAsset`) and no HTTP endpoint, so the
  service is not yet reachable from the web app (Phase 3A-2c / 3A-3).
- **No real vision provider** — offline deterministic adapter only (ADR-0009).

### Known limitation

Concurrent requests for the same asset each perform their own provider call.
The row is never duplicated and both converge on the same result, but
deduplicating the work needs a lease or conditional status update, which belongs
with the job queue in Phase 4.

## [phase-3a2a-complete] — Phase 3A-2a: analysis persistence and live-PostgreSQL CI

Merged in PR #5 as `8d1bed31e4d3744865d1a09a1fc08feb3da3e16f`.
Tagged `phase-3a2a-complete` locally; the remote tag is **not** yet published
(see `docs/progress.md`). Scoped to persistence and its verification only — see
`docs/phase-3a2a-completion.md`.

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
