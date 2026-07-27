# ADR-0008: Object storage abstraction and media-processing pipeline

- Status: Accepted
- Date: 2026-07-27
- Phase: 2

## Context

Phase 2 requires secure photo upload with short-lived signed URLs, an object
storage abstraction, tenant-scoped storage paths, content-based MIME
validation, size/count/dimension limits, a malware-scanning hook with a
quarantine state, EXIF removal, orientation correction, normalization,
thumbnails, perceptual hashing, and a duplicate-detection foundation — without
binding the platform to one storage vendor.

## Decision

### 1. ObjectStorage port

`ObjectStorage` (in `@app/domain`) exposes
`createSignedUploadUrl` / `createSignedDownloadUrl` / `putObject` /
`getObject` / `deleteObject` / `exists`. Domain services depend only on this
port. `@app/storage` provides `LocalObjectStorage` (in-process, used for local
development and tests); an S3/Azure adapter implements the same port without
touching domain code.

### 2. Signed URLs are short-lived and single-purpose

Access is granted only via an HMAC-SHA256 token binding **one storage key** to
**one purpose** (`upload` XOR `download`) and an expiry. An upload token cannot
be replayed as a download token, tampering with the key invalidates the
signature, and expired tokens are rejected. TTLs: upload 600s, download 300s.
The signing secret (`STORAGE_SIGNING_SECRET`) is server-side only.

### 3. Tenant-scoped, opaque storage keys

Keys are `org/{organizationId}/properties/{propertyId}/assets/{assetId}/{variant}.{ext}`.
They contain only internal ids — never customer names, addresses, or secrets.
Raw storage keys are never returned to the browser; clients only ever receive
signed URLs.

### 4. Content-based MIME validation

The declared filename/Content-Type is untrusted. `sniffMimeType` derives the
type from magic bytes and only `image/jpeg`, `image/png`, `image/webp` are
accepted. A script or SVG payload named `photo.jpg` is rejected. Byte size is
re-checked against the stored object, not the client's claim.

### 5. Malware scanning hook and quarantine

`MalwareScanner` is an integration boundary. Phase 2 ships
`PassthroughMalwareScanner`, which detects the EICAR test signature so the
quarantine path is exercisable. `INFECTED` → `QUARANTINED` (never downloadable);
`SCAN_FAILED` → `FAILED` (retryable by a human).

### 6. Image processing with sharp

`SharpImageProcessor` implements the `ImageProcessor` port: `rotate()` applies
EXIF orientation, re-encoding drops all EXIF/GPS metadata (`withMetadata()` is
deliberately never called), the master copy is normalized to a bounded long
edge, and a WebP thumbnail is produced. Perceptual hashing uses a 64-bit
average hash (aHash) from an 8×8 greyscale reduction, rendered as 16 hex chars;
a DCT-based pHash can replace it behind the same interface.

Because `sharp` is a native module, it is declared as an explicit dependency of
`apps/web` and listed in `serverExternalPackages` so Next leaves it external and
Node can resolve its platform binary under pnpm's isolated layout.

### 7. Upload lifecycle

```text
PENDING_UPLOAD → UPLOADED → SCANNING → PROCESSING → READY
                               ↓           ↓
                          QUARANTINED  REJECTED / FAILED
READY → DELETION_PENDING → DELETED
```

`retryUpload` re-issues a signed URL for a `PENDING_UPLOAD`/`FAILED` asset
without creating a second row (failed-upload recovery). Deleting a property moves
its assets to `DELETION_PENDING` (retention foundation; the physical-deletion job
is Phase 7).

## Consequences

- `LocalObjectStorage` keeps objects in process memory, so it is not durable
  across restarts and is unsuitable for production or multi-instance
  deployments. A real S3/Azure adapter is required before launch (tracked in
  `docs/decisions/TODO.md`).
- Image processing currently happens inline in the upload-completion request.
  Moving it to the async worker is the natural follow-up once the queue lands in
  Phase 4.
- Duplicate detection stores hashes and reports near-duplicates; the UI decision
  (block vs warn) belongs to Phase 3's analysis-review step.
