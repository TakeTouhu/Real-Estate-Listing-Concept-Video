# Phase 2 Completion Report

Version: 1.0
Date: 2026-07-27
Phase: 2 — Properties and secure media upload

## Summary

Phase 2 adds property CRUD, the media-asset domain, and a secure photo-upload
pipeline: short-lived single-purpose signed URLs, a vendor-neutral object-storage
abstraction with tenant-scoped keys, content-based MIME validation, size/count/
dimension limits, a malware-scanning hook with quarantine, EXIF/GPS removal,
orientation correction, normalization, WebP thumbnails, perceptual hashing with a
duplicate-detection foundation, a 10-state upload lifecycle with failed-upload
recovery, an upload-progress UI, signed download/preview URLs, tenant isolation,
audit logging, and a retention/deletion-state foundation.

## Completion criterion (docs/Roadmap.md)

> "An authorized creator can upload valid photos and cannot access another
> organization's assets."

**Met.**
- Positive path: `media-pipeline.integration.test.ts` uploads a real JPEG (with
  EXIF + GPS + orientation 6) through a signed URL, drives it to `READY`, and
  reads the normalized object back — confirming metadata was stripped.
- Negative path: `property.test.ts` asserts `FORBIDDEN` for cross-tenant reads
  **and** writes, and `NOT_FOUND` when another tenant's ids are addressed from
  inside a legitimate organization scope.

## Requirement coverage

| Requirement | Status | Where |
| --- | --- | --- |
| Property CRUD | ✅ | `PropertyService`, `/api/properties`, dashboard |
| Media Asset domain | ✅ | `MediaAsset` entity + Prisma model/migration |
| Secure upload via short-lived signed URLs | ✅ | `requestUpload` (600s), `/api/storage/upload` |
| Object storage abstraction | ✅ | `ObjectStorage` port + `LocalObjectStorage` |
| Tenant-scoped storage paths | ✅ | `buildAssetStorageKey` (`org/{orgId}/…`) |
| MIME validation from file content | ✅ | `sniffMimeType` (magic bytes) |
| File-size / count / dimension limits | ✅ | `DEFAULT_UPLOAD_LIMITS`, re-checked on real bytes |
| Malware scan hook + quarantine | ✅ | `MalwareScanner`, `QUARANTINED` |
| EXIF / sensitive metadata removal | ✅ | `SharpImageProcessor`, verified by test |
| Image orientation correction | ✅ | `rotate()`, verified (dimensions swap) |
| Image normalization | ✅ | bounded long edge + JPEG re-encode |
| Thumbnail generation | ✅ | WebP thumbnail under its own key |
| Perceptual hash generation | ✅ | 64-bit aHash, 16 hex chars |
| Duplicate detection foundation | ✅ | `hammingDistanceHex`, `duplicateOf` result |
| Upload lifecycle & status management | ✅ | 10-state machine (ADR-0008) |
| Upload progress UI | ✅ | `UploadPanel` (drag-drop, XHR progress) |
| Failed-upload recovery | ✅ | `retryUpload` + UI retry |
| Secure signed download & preview URLs | ✅ | `createDownloadUrl` (300s), hardened response headers |
| Tenant isolation (properties & assets) | ✅ | org-scoped repos + `authorizeOrganization` |
| Audit logging for property/asset ops | ✅ | 11 new audit actions |
| Retention & deletion-state foundation | ✅ | `DELETION_PENDING`, `deletionRequestedAt`, `retentionExpiresAt` |
| Unit tests | ✅ | media helpers, property/asset services |
| Integration tests | ✅ | real `sharp` pipeline + end-to-end upload flow |
| Tenant-isolation tests | ✅ | read + write denial |
| Upload security tests | ✅ | disguised content, size, quarantine, dimensions, count, token misuse |
| Production build | ✅ | `next build`, 16 routes |
| Phase 2 completion report | ✅ | this document |

## Exact check results

Environment: Node.js v22, pnpm 10.33.0, Prisma 5.22.0, sharp 0.33.5.

- `pnpm run typecheck` — **passed**, 10 workspace projects.
- `pnpm run lint` — **passed**, 0 problems.
- `pnpm run test` — `vitest run` — **16 files, 117 tests, all passed**
  (was 71 at the end of Phase 1; +46 in Phase 2):
  - `packages/domain/src/property/property.test.ts` (23) — CRUD, lifecycle,
    upload security, tenant isolation, audit
  - `packages/domain/src/property/media.test.ts` (8) — MIME sniffing, storage
    keys, hamming distance
  - `packages/storage/src/media-pipeline.integration.test.ts` (9) — real image
    pipeline + end-to-end upload/download
  - `packages/storage/src/signing.test.ts` (6) — signed-token security
  - plus the 71 pre-existing Phase 0/1 tests
- `pnpm run build` — `next build` — **compiled successfully**; 16 routes.

## Release tag status

Per the release-tag policy, tags are created only after review, green CI, merge,
and verification of the pulled commit.

| Tag | Target commit | Type | Tag SHA | Verified |
| --- | --- | --- | --- | --- |
| `phase-0-complete` | `5185fea6fdf5458b72a316ec94fcd0fe9cc54443` | annotated | `76d36045934a97bc4a997a64dcd1e932cfe837de` | ✅ target == Phase 0 merge commit |
| `phase-1-complete` | `62259776f88fa1010736e8a365618b7c20c38902` | annotated | `7d8bc81b460568becc82bc49cfc15b345d23d5a6` | ✅ target == Phase 1 merge commit |
| `phase-2-complete` | — | — | — | ⏳ not yet created (awaits Phase 2 review, CI, merge) |

Both existing tags were created on `main` (never a feature branch) and neither
has been moved or overwritten.

**Publication caveat:** `git push origin phase-0-complete phase-1-complete`
currently fails in the development environment with `HTTP 403` on tag refs, and
the available GitHub tooling exposes no tag-creation API. The tags are correct
locally and verified; a maintainer with direct push access must publish them.
See `docs/progress.md`.

## Security posture added in Phase 2

- Upload/download URLs are HMAC-signed, expiring, and single-purpose; an upload
  token cannot be replayed for download and key tampering breaks the signature.
- The declared Content-Type/filename is never trusted; type comes from magic
  bytes and size is re-verified against stored bytes.
- Storage keys carry only internal ids (no names, addresses, or secrets) and are
  never returned to the browser.
- Quarantined, rejected, or failed assets are never downloadable.
- Download responses set `Cache-Control: private, no-store`,
  `X-Content-Type-Options: nosniff`, and a sandboxing CSP.
- Client filenames are stripped of path components and control characters.
- `STORAGE_SIGNING_SECRET` is server-side only and validated at startup.

## Remaining work / follow-ups

- Replace `LocalObjectStorage` with a durable S3/Azure adapter before launch
  (in-process storage is not multi-instance safe).
- Move image processing from the request path to the async worker (Phase 4).
- Add the live-PostgreSQL CI integration job (carried over from Phase 1).
- Reconcile the `Credential` table with `docs/DataModel.md` (carried over).
- Decide block-vs-warn UX for near-duplicates in Phase 3's analysis review.

**Phase 3 has not been started.** Per the release-tag policy it must not begin
until Phase 2 is reviewed, CI passes, the PR is merged, and `phase-2-complete`
is created and verified.
