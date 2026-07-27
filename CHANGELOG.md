# Changelog

All notable changes to this project. Phases correspond to `docs/Roadmap.md`.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — Phase 2: Properties and secure media upload

Under review in PR #3. Not merged.

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
