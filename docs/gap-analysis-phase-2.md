# Phase 2 Gap Analysis

Version: 1.0
Status: Complete
Scope: Phase 2 — Properties and secure media upload (`docs/Roadmap.md`)

## Starting state (after Phase 1 merge, tag `phase-1-complete`)

- Identity, organizations, memberships, RBAC, invitations, sessions, audit log,
  Prisma persistence, and the WaveSpeed adapter were in place.
- `packages/storage` was still a placeholder; there were no properties, media
  assets, uploads, or image processing.

## Requirement-by-requirement analysis

| Phase 2 requirement | Before | Delivered |
| --- | --- | --- |
| Property CRUD | Missing | `PropertyService` (create/get/list/update/soft-delete) + `/api/properties` + dashboard forms |
| Media Asset domain | Missing | `MediaAsset` entity, lifecycle statuses, repository port, Prisma model + migration |
| Secure upload via short-lived signed URLs | Missing | `requestUpload` issues a 600s single-purpose signed PUT URL; `/api/storage/upload` accepts only a valid token |
| Object storage abstraction | Missing | `ObjectStorage` port + `LocalObjectStorage`; S3/Azure adapter drops in unchanged (ADR-0008) |
| Tenant-scoped storage paths | Missing | `org/{orgId}/properties/{propId}/assets/{assetId}/{variant}.{ext}`; ids only, no PII |
| MIME validation from file content | Missing | `sniffMimeType` magic-byte detection; allowlist JPEG/PNG/WebP |
| File-size, count, dimension limits | Missing | `DEFAULT_UPLOAD_LIMITS` (25 MB, 20/property, 480–12000 px); size re-checked against real bytes |
| Malware scan hook + quarantine | Missing | `MalwareScanner` port, `PassthroughMalwareScanner` (EICAR), `QUARANTINED` status |
| EXIF / sensitive metadata removal | Missing | `SharpImageProcessor` re-encodes without `withMetadata()`; verified by integration test |
| Image orientation correction | Missing | `rotate()` applies EXIF orientation; verified (orientation 6 swaps dimensions) |
| Image normalization | Missing | bounded long edge (default 2560px), JPEG re-encode |
| Thumbnail generation | Missing | WebP thumbnail (default 400px), stored under its own key |
| Perceptual hash generation | Missing | 64-bit aHash → 16 hex chars |
| Duplicate detection foundation | Missing | `hammingDistanceHex` + `listWithPerceptualHash`; `completeUpload` returns `duplicateOf` |
| Upload lifecycle & status management | Missing | 10-state machine (see ADR-0008) |
| Upload progress UI | Missing | `UploadPanel` client component: drag-drop, per-file XHR progress, processing/ready/error states |
| Failed-upload recovery | Missing | `retryUpload` re-issues a URL for the same asset row; UI retry button |
| Secure signed download & preview URLs | Missing | `createDownloadUrl` (300s) + `/api/storage/download` with `no-store`, `nosniff`, sandbox CSP |
| Tenant isolation for properties & assets | Missing | org-scoped repository lookups + `authorizeOrganization`; read **and** write denial tested |
| Audit logging for property/asset ops | Partial (identity only) | 11 new audit actions across property and asset writes |
| Retention & deletion-state foundation | Missing | `DELETION_PENDING`/`DELETED`, `deletionRequestedAt`, `retentionExpiresAt`; property delete cascades to assets |
| Unit / integration / isolation / security tests | Identity only | +55 tests (see completion report) |
| Production build | Passing | Still passing, 16 routes |
| Phase 2 completion report | Missing | `docs/phase-2-completion.md` |

## Completion criterion (Roadmap)

> "An authorized creator can upload valid photos and cannot access another
> organization's assets."

Met: the end-to-end integration test uploads a real JPEG through signed URLs to
`READY` and reads it back; the tenant-isolation test asserts `FORBIDDEN` on
cross-tenant reads and writes and `NOT_FOUND` when another tenant's ids are used
inside a legitimate organization scope.

## Known limitations (tracked in docs/decisions/TODO.md)

- `LocalObjectStorage` is in-process and not durable → real S3/Azure adapter
  required before launch.
- Image processing runs inline in the completion request; move to the async
  worker when the queue lands (Phase 4).
- No live-PostgreSQL CI job yet; isolation/audit are proven with in-memory
  adapters (ADR-0007).

## Not started

Phase 3 (AI analysis and storyboard) and later phases. No Phase 3 code is
included in this change.
