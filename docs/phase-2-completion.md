# Phase 2 Completion Report

Version: 2.0
Date: 2026-07-27
Phase: 2 — Properties and secure media upload
Status: **Merged.** PR #3 squash-merged into `main` as
`653372a54d72d8dacc38fb7103ad32f15041cc2f`; tagged `phase-2-complete` locally
(remote tag publication blocked — see below).
Governance: prepared against `CLAUDE.md` v1.3

## Summary

Phase 2 adds property CRUD, the media-asset domain, and a secure photo-upload
pipeline: short-lived single-purpose signed URLs, a vendor-neutral object-storage
abstraction with tenant-scoped keys, content-based MIME validation, size/count/
dimension limits, a malware-scanning hook with quarantine, EXIF/GPS removal,
orientation correction, normalization, WebP thumbnails, perceptual hashing with a
duplicate-detection foundation, a ten-state upload lifecycle with failed-upload
recovery, an upload-progress UI, signed download/preview URLs, tenant isolation,
audit logging, and a retention/deletion-state foundation.

## Milestone PRs

`CLAUDE.md` v1.3 requires this section. Phase 2 was implemented **before** the
v1.3 milestone policy existed, so it is a single PR rather than a milestone set.

| Milestone | PR | Merge commit | Status |
| --- | --- | --- | --- |
| Phase 2 (single PR — one-time exception, see deviation below) | [#3](https://github.com/TakeTouhu/Real-Estate-Listing-Concept-Video/pull/3) | `653372a54d72d8dacc38fb7103ad32f15041cc2f` | ✅ Reviewed, CI green, merged |

### Deviation from the ~500-line PR guideline — disclosed

PR #3 contains **5,110 changed lines across 62 files** excluding the lockfile and
generated migrations (5,448 / 64 files including them; ~45% of the line count is
documentation). That is well above the ~500-line target in `CLAUDE.md` v1.3.

- **Why:** the work was completed under v1.2, which asked for one PR per phase.
  The milestone policy arrived afterwards.
- **Why it was not retro-split:** the reviewer instructed that the current
  implementation be treated as the review candidate and that no new Phase 2
  functionality be added before review. Re-slicing merged-quality work into
  three PRs would rewrite history the reviewer has already been pointed at.
- **How it is reviewable anyway:** the diff separates cleanly by package —
  `packages/domain/src/property/*` (domain), `packages/storage/*` (adapters),
  `packages/database/*` (persistence), `apps/web/*` (HTTP + UI), `docs/*`
  (documentation, ~40% of the line count).
- **Commitment:** Phase 3 will ship as **Phase 3A / 3B / 3C** milestone PRs,
  each reviewed, CI-green, and merged before the next begins.

## Completion criterion (docs/Roadmap.md)

> "An authorized creator can upload valid photos and cannot access another
> organization's assets."

**Met**, proven from both directions:

- **Positive:** `media-pipeline.integration.test.ts` uploads a real JPEG carrying
  EXIF, GPS, and orientation 6 through a signed URL, drives it to `READY`, and
  reads the normalized object back — asserting the metadata is gone and the
  orientation was applied (1600×1200 → 1200×1600).
- **Negative:** `property.test.ts` asserts `FORBIDDEN` on cross-tenant **reads**
  (`list`, `get`, asset `list`, `createDownloadUrl`) **and writes** (`update`,
  `remove`, `requestUpload`, `retryUpload`, `requestDeletion`), and `NOT_FOUND`
  when another tenant's ids are addressed from inside a legitimate organization
  scope.

## Requirement coverage

| Requirement | Status | Where |
| --- | --- | --- |
| Property CRUD | ✅ | `PropertyService`, `/api/properties`, dashboard |
| Media Asset domain | ✅ | `MediaAsset` entity + Prisma model/migration |
| Secure upload via short-lived signed URLs | ✅ | `requestUpload` (600 s), `/api/storage/upload` |
| Object storage abstraction | ✅ | `ObjectStorage` port + `LocalObjectStorage` |
| Tenant-scoped storage paths | ✅ | `buildAssetStorageKey` (`org/{orgId}/…`) |
| MIME validation from file content | ✅ | `sniffMimeType` (magic bytes) |
| File-size / count / dimension limits | ✅ | `DEFAULT_UPLOAD_LIMITS`; size re-checked on real bytes |
| Malware scan hook + quarantine | ✅ | `MalwareScanner`, `QUARANTINED` |
| EXIF / sensitive metadata removal | ✅ | `SharpImageProcessor`; asserted in tests |
| Image orientation correction | ✅ | `rotate()`; asserted (dimensions swap) |
| Image normalization | ✅ | bounded long edge + JPEG re-encode |
| Thumbnail generation | ✅ | WebP thumbnail under its own key |
| Perceptual hash generation | ✅ | 64-bit aHash, 16 hex chars |
| Duplicate detection foundation | ✅ | `hammingDistanceHex`, `duplicateOf` |
| Upload lifecycle & status management | ✅ | ten-state machine (ADR-0008) |
| Upload progress UI | ✅ | `UploadPanel` (drag-drop, XHR progress) |
| Failed-upload recovery | ✅ | `retryUpload` + UI retry |
| Secure signed download & preview URLs | ✅ | `createDownloadUrl` (300 s), hardened headers |
| Tenant isolation (properties & assets) | ✅ | org-scoped repos + `authorizeOrganization` |
| Audit logging for property/asset ops | ✅ | 11 new audit actions |
| Retention & deletion-state foundation | ✅ | `DELETION_PENDING`, `deletionRequestedAt`, `retentionExpiresAt` |
| Unit tests | ✅ | 45 (media helpers, property/asset services, production guard) |
| Integration tests | ✅ | 15 (real `sharp` pipeline, signed tokens, end-to-end flow) |
| Tenant-isolation tests | ✅ | read + write denial |
| Upload security tests | ✅ | disguised content, size, quarantine, dimensions, count, token misuse |
| Production build | ✅ | `next build`, 16 routes |
| Phase 2 completion report | ✅ | this document |

## Required phase documentation (CLAUDE.md v1.3)

| Required item | Status | Location |
| --- | --- | --- |
| Architecture diagram | ✅ | `docs/architecture.md` (Mermaid) |
| Entity-relationship diagram | ✅ | `docs/er-diagram.md` (Mermaid) |
| Critical sequence diagram | ✅ | `docs/sequence-upload-lifecycle.md` (Mermaid: happy path, failure paths, state machine) |
| OpenAPI spec or API change summary | ✅ | `docs/api-changes-phase-2.md` (summary + OpenAPI 3.1 fragment). Full document deferred — recorded in TODO |
| Change log | ✅ | `CHANGELOG.md` |
| Release notes | ✅ | `docs/release-notes-phase-2.md` |
| Database migration notes | ✅ | `docs/migration-notes.md` |
| Phase completion report | ✅ | this document |

## Exact test results

Environment: Node.js v22.22.2, pnpm 10.33.0, Prisma 5.22.0, sharp 0.33.5,
TypeScript 5.7.3, Vitest 3.2.7. Re-run after merging `origin/main` (CLAUDE.md v1.3).

```text
pnpm typecheck   → PASS   tsc --noEmit across 10 workspace projects
pnpm lint        → PASS   eslint . — 0 problems
pnpm test        → PASS   17 files, 131 tests, 0 failed
pnpm build       → PASS   next build — compiled successfully, 16 routes
```

Per-file test results:

| Test file | Tests | Result |
| --- | --- | --- |
| `packages/domain/src/property/property.test.ts` | 25 | ✅ |
| `packages/video-providers/src/wavespeed/mapping.test.ts` | 16 | ✅ |
| `packages/domain/src/identity/identity.test.ts` | 12 | ✅ |
| `packages/storage/src/media-pipeline.integration.test.ts` | 9 | ✅ |
| `packages/domain/src/property/media.test.ts` | 8 | ✅ |
| `packages/shared/src/security.test.ts` | 8 | ✅ |
| `packages/shared/src/crypto.test.ts` | 6 | ✅ |
| `packages/observability/src/redact.test.ts` | 6 | ✅ |
| `packages/storage/src/production-guard.test.ts` | 12 | ✅ |
| `packages/storage/src/signing.test.ts` | 6 | ✅ |
| `packages/shared/src/env.test.ts` | 5 | ✅ |
| `packages/video-providers/src/wavespeed/wavespeed-provider.test.ts` | 5 | ✅ |
| `packages/video-providers/src/fake/fake-provider.test.ts` | 4 | ✅ |
| `apps/web/src/lib/health.test.ts` | 3 | ✅ |
| `apps/web/src/lib/auth.test.ts` | 2 | ✅ |
| `apps/worker/src/bootstrap.test.ts` | 2 | ✅ |
| `packages/video-providers/src/factory.test.ts` | 2 | ✅ |
| **Total** | **131** | **✅ 0 failures** |

Phase 2 added 60 tests (71 → 131), including 14 added during post-review
hardening (2 download-denial + 12 production-guard).

Build output routes: `/`, `/login`, `/properties/[propertyId]`, `/_not-found`,
`/api/auth/{register,login,logout}`, `/api/organizations`, `/api/properties`,
`/api/properties/[propertyId]/assets/upload-url`,
`/api/assets/[assetId]/{complete,retry,download-url}`,
`/api/storage/{upload,download}`, `/api/health`, `/api/health/ready`.

## Migrations

| Migration | Phase | Nature | Applied by |
| --- | --- | --- | --- |
| `00000000000000_init` | 1 | Identity foundation | `pnpm --filter @app/database run db:migrate` |
| `00000000000001_phase2_properties_media` | 2 | **Additive only** — 3 enums, 2 tables, 3 indexes | same |

- Additive only: no column altered, renamed, or dropped; safe on a populated
  Phase 1 database; no backfill required.
- New enums: `PropertyStatus`, `PropertyType`, `MediaAssetStatus`.
- New tables: `properties`, `media_assets` (unique `storageKey`, cascade from
  `properties`).
- New indexes: `properties(organizationId, status)`,
  `media_assets(organizationId, propertyId, status)`,
  `media_assets(organizationId, sha256)`.
- **Parity verified offline:** the combined migrations reproduce the schema
  exactly (207 non-empty DDL lines on both sides, no drift).
- Rollback and the canonical shadow-database check: `docs/migration-notes.md`.

## Security checks performed

| Check | Result |
| --- | --- |
| No secrets, keys, certs committed | ✅ only `.env.example` with placeholders (`replace-with-…`) or empty values |
| No local database files committed | ✅ no `*.db`, `*.sqlite*` tracked |
| No generated media committed | ✅ no image/video files tracked; test fixtures are generated in-memory by `sharp` |
| No temp/build artifacts committed | ✅ no `.next/`, `node_modules/`, `dist/`, `coverage/`, `*.log`, `*.tmp`, `next-env.d.ts` |
| `DATABASE_URL` never client-side | ✅ referenced only in the server env schema, `@app/database/client.ts`, and a server-only comment |
| `WAVESPEED_API_KEY` server-side only | ✅ server env schema + `video-providers` factory only |
| `STORAGE_SIGNING_SECRET` server-side only | ✅ server env schema + `@app/storage`; validated at startup (min 16 chars) |
| No `NEXT_PUBLIC_*` secret exposure | ✅ no `NEXT_PUBLIC_` identifier exists in the codebase |
| CI uses non-secret test values | ✅ `ci-…-0000` literals, clearly non-production |
| Declared MIME/filename not trusted | ✅ type from magic bytes; allowlist JPEG/PNG/WebP |
| Real byte size re-verified | ✅ re-checked after upload, independent of the client's claim |
| Storage keys not exposed to the browser | ✅ only signed URLs are returned |
| Storage keys free of PII | ✅ internal ids only |
| Signed URLs short-lived | ✅ upload 600 s, download 300 s |
| Signed URLs single-purpose | ✅ upload token rejected for download and vice versa (tested) |
| Token tampering detected | ✅ key substitution invalidates the HMAC (tested) |
| Expired tokens rejected | ✅ tested |
| Quarantined/rejected assets undownloadable | ✅ `createDownloadUrl` requires `READY` (tested) |
| Filename sanitization | ✅ path components and control characters stripped (traversal tested) |
| Download response hardening | ✅ `private, no-store`, `nosniff`, sandbox CSP |
| Request body hard cap | ✅ 32 MB at the storage endpoint, independent of domain limits |
| Tenant isolation (read + write) | ✅ automated denial tests |
| Audit coverage of writes | ✅ all 11 property/asset write paths emit events |
| Secrets absent from logs | ✅ redacting logger covers keys, tokens, secrets, signed URLs, prediction ids |
| TypeScript strict / no `any` | ✅ enforced by config and lint |
| Non-production adapters blocked in production | ✅ `LocalObjectStorage` and `PassthroughMalwareScanner` throw `NonProductionAdapterError` under `NODE_ENV=production` |
| Guard error message free of secrets | ✅ signing secret absent from message, stack, and serialized properties (asserted) |
| Download denial for every non-`READY` status | ✅ `REJECTED` and `DELETION_PENDING` now individually asserted, alongside `PENDING_UPLOAD`, `FAILED`, `QUARANTINED` |

## Changed files (62 excluding lockfile and generated migration)

**Domain — `packages/domain` (12)**
`src/property/types.ts` (A), `src/property/ports.ts` (A),
`src/property/media.ts` (A), `src/property/audit.ts` (A),
`src/property/property-service.ts` (A), `src/property/asset-service.ts` (A),
`src/property/index.ts` (A), `src/property/media.test.ts` (A),
`src/property/property.test.ts` (A/M), `src/testing/in-memory-property.ts` (A),
`src/testing/index.ts` (M), `src/index.ts` (M), `src/identity/audit.ts` (M)

**Storage — `packages/storage` (10)**
`src/signing.ts` (A), `src/local-storage.ts` (A/M), `src/image-processor.ts` (A),
`src/scanner.ts` (A/M), `src/production-guard.ts` (A),
`src/production-guard.test.ts` (A), `src/signing.test.ts` (A),
`src/media-pipeline.integration.test.ts` (A), `src/index.ts` (M),
`package.json` (M)

**Persistence — `packages/database` (4)**
`prisma/schema.prisma` (M),
`prisma/migrations/00000000000001_phase2_properties_media/migration.sql` (A),
`src/property-repositories.ts` (A), `src/index.ts` (M)

**Web — `apps/web` (13)**
`src/app/api/properties/route.ts` (A),
`src/app/api/properties/[propertyId]/assets/upload-url/route.ts` (A),
`src/app/api/assets/[assetId]/complete/route.ts` (A),
`src/app/api/assets/[assetId]/retry/route.ts` (A),
`src/app/api/assets/[assetId]/download-url/route.ts` (A),
`src/app/api/storage/upload/route.ts` (A),
`src/app/api/storage/download/route.ts` (A),
`src/app/properties/[propertyId]/page.tsx` (A),
`src/app/properties/[propertyId]/upload-panel.tsx` (A),
`src/lib/property.ts` (A), `src/app/page.tsx` (M),
`src/app/globals.css` (M), `next.config.mjs` (M), `package.json` (M),
`src/lib/health.test.ts` (M)

**Shared / providers / worker (4)**
`packages/shared/src/env.ts` (M), `packages/shared/src/env.test.ts` (M),
`packages/video-providers/src/factory.test.ts` (M),
`apps/worker/src/bootstrap.test.ts` (M)

**Root config (4)**
`package.json` (M — pnpm build allowlist), `vitest.config.ts` (M — subpath
aliases), `.env.example` (M), `.github/workflows/ci.yml` (M)

**Documentation (12)**
`docs/architecture.md` (A), `docs/er-diagram.md` (A),
`docs/sequence-upload-lifecycle.md` (A), `docs/api-changes-phase-2.md` (A),
`docs/migration-notes.md` (A), `docs/release-notes-phase-2.md` (A),
`CHANGELOG.md` (A), `docs/progress.md` (A),
`docs/gap-analysis-phase-2.md` (A), `docs/phase-2-completion.md` (A),
`docs/decisions/0008-object-storage-and-media-pipeline.md` (A),
`docs/decisions/TODO.md` (M), `README.md` (M)

## Release tag status

Per the `CLAUDE.md` v1.3 release-tag policy, a phase tag is created only after
review approval, green CI, merge into `main`, and verification of the merged
commit.

| Tag | Target commit | Type | Tag object SHA | Local verification | Published on GitHub? |
| --- | --- | --- | --- | --- | --- |
| `phase-0-complete` | `5185fea6fdf5458b72a316ec94fcd0fe9cc54443` | annotated | `76d36045934a97bc4a997a64dcd1e932cfe837de` | ✅ target == Phase 0 merge commit | ❌ **No** |
| `phase-1-complete` | `62259776f88fa1010736e8a365618b7c20c38902` | annotated | `7d8bc81b460568becc82bc49cfc15b345d23d5a6` | ✅ target == Phase 1 merge commit | ❌ **No** |
| `phase-2-complete` | `653372a54d72d8dacc38fb7103ad32f15041cc2f` | annotated | `b13e5490f2014dc43a3815c3570795c955a2089a` | ✅ target == Phase 2 merge commit | ❌ **No** |

All three tags were created on `main`, never on a feature branch, and none has
been moved, overwritten, or reused.

### Tag publication blocker — the remote tags do NOT exist

`git push` of tag refs fails in this environment with `HTTP 403`
(`error: RPC failed; HTTP 403`, then `send-pack: unexpected disconnect`),
retried six times with backoff. The available GitHub tooling exposes only
read APIs for tags (`get_tag`, `list_tags`) and no create-ref capability.
`git ls-remote --tags origin` returns **empty**. Re-attempted after the Phase 2
merge with three invocations (explicit refspecs, `--tags`, a single tag) — all
failed identically. Branch pushes to the same remote succeed, so the proxy
rejects tag refs specifically.

To be unambiguous: **`phase-0-complete`, `phase-1-complete`, and
`phase-2-complete` exist only in the local clone. They are not published, and
this report does not claim otherwise.**

Exact manual command for a maintainer with direct push access:

```bash
git push origin refs/tags/phase-0-complete \
               refs/tags/phase-1-complete \
               refs/tags/phase-2-complete
```

Then verify:

```bash
git ls-remote --tags origin
```

## Deferred items

Carried forward with owner phase. Full list in `docs/decisions/TODO.md`.

| Deferred item | Reason | Target |
| --- | --- | --- |
| Durable S3/Azure `ObjectStorage` adapter | Phase 2 scope was the abstraction; `LocalObjectStorage` proves the port | **Production blocker** |
| Move image processing to the async worker | The queue does not exist until Phase 4 | Phase 4 |
| Real malware-scanning engine | Integration boundary only in Phase 2 | Before launch |
| Live-PostgreSQL CI integration job | Isolation/audit proven with in-memory adapters (ADR-0007) | Phase 3 |
| Full OpenAPI document + `/api/v1` prefix | API still moving; fragment published instead | Before external consumers |
| `Idempotency-Key` on commands | No generation/billing command exists yet | Phases 4 / 6 |
| Reconcile `Credential` table with `docs/DataModel.md` | Added in ADR-0006 | Doc update |
| Near-duplicate UX (block vs warn) | Belongs to the analysis-review screen | Phase 3 |
| DCT-based pHash | aHash sufficient for the foundation | If accuracy requires |
| Publish `phase-*-complete` tags | Environment blocks tag refs (above) | Maintainer action |
| OAuth (Entra ID / Google) + MFA | Phase 1 deferral | Later |

## Production-safety guard (post-review hardening)

Added at review request. Both development-only adapters refuse construction when
`NODE_ENV=production`:

| Adapter | Guarded reason | Required action in the message |
| --- | --- | --- |
| `LocalObjectStorage` | objects held in process memory; uploads lost on restart, not shared between instances | configure a durable S3/Azure `ObjectStorage` adapter |
| `PassthroughMalwareScanner` | no real malware analysis; only recognises EICAR | configure a real malware-scanning engine behind the `MalwareScanner` port |

- Throws `NonProductionAdapterError`, naming the adapter and the required action.
- **No secrets in the error**: the signing secret is absent from the message,
  stack, and serialized own properties (asserted by test).
- `development`, `test`, and unset `NODE_ENV` are unaffected — local development
  and the test suite behave exactly as before.
- `next build` is unaffected: routes are `force-dynamic`, so the adapters are
  constructed lazily per request rather than at build time (verified — build
  passes).
- `allowInProduction: true` is an explicit escape hatch for staging smoke tests
  against a production-like `NODE_ENV`; it must never be set in production.
- **Scope:** the guard fires on first adapter construction (first request to a
  property/asset route), not at process boot. Boot-time validation of the whole
  adapter set is a Phase 7 hardening item, recorded in
  `docs/decisions/TODO.md`.

Implementation: `packages/storage/src/production-guard.ts`.
Tests: `packages/storage/src/production-guard.test.ts` (12 tests).

## Remaining production blockers

These must be resolved before any production launch. The production-safety guard
above prevents an *accidental* production deployment with the stub adapters, but
does not supply the missing capabilities.

1. **In-process object storage.** `LocalObjectStorage` loses uploaded bytes on
   restart and cannot be shared across instances. A durable S3/Azure adapter is
   mandatory. (Production use is now blocked by the guard.)
2. **Malware scanning is a stub.** Only the EICAR signature is detected; a real
   engine must be wired into the existing `MalwareScanner` port. (Production use
   is now blocked by the guard.)
3. **Inline image processing.** CPU-heavy work runs in the request path with no
   queue, retry, or backpressure.
4. **No live-database integration testing** in CI, so Prisma adapter regressions
   would not be caught automatically.
5. **Retention job not implemented.** Assets reach `DELETION_PENDING` but nothing
   physically deletes objects after the recovery window (Phase 7).
6. **WaveSpeedAI commercial terms unverified**, and no rate limiting, CSP, or
   security headers beyond the storage-download endpoint (Phase 7).

## Next steps

**Phase 3 has not been started.** PR #3 is merged and `phase-2-complete` is
created and locally verified, but the remote tag is **not** published (blocker
above). A proposed milestone split is recorded in
`docs/phase-3-milestone-plan.md`; no Phase 3 branch or code exists. Each
milestone (`Phase 3A` / `3B` / `3C`) will be reviewed, CI-green, and merged
before the next begins.
