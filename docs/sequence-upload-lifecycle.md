# Upload Lifecycle — Sequence Diagram

Version: 1.0 (as implemented in Phase 2)
Status: Describes **implemented** behavior.

## Happy path: request → upload → process → READY → preview

```mermaid
sequenceDiagram
  autonumber
  actor U as Creator (browser)
  participant W as Next.js routes
  participant AS as AssetService (domain)
  participant AZ as authorizeOrganization
  participant R as Asset repository (Prisma)
  participant S as ObjectStorage
  participant MS as MalwareScanner
  participant IP as ImageProcessor (sharp)
  participant AL as AuditLog

  U->>W: POST /api/properties/{id}/assets/upload-url<br/>{organizationId, filename, sizeBytes}
  W->>AS: requestUpload(actor, input)
  AS->>AZ: require membership + property:write
  AZ-->>AS: AuthContext (else FORBIDDEN)
  AS->>R: property in org? active?
  AS->>AS: check declared size + per-property count limit
  AS->>R: create asset (PENDING_UPLOAD, org-prefixed key)
  AS->>S: createSignedUploadUrl(key, 600s)
  S-->>AS: signed URL (single-purpose, expiring)
  AS->>AL: asset.upload_requested
  AS-->>W: {assetId, uploadUrl, expiresAt}
  W-->>U: signed URL only (never the storage key)

  U->>W: PUT /api/storage/upload?token=... (raw bytes, XHR progress)
  W->>W: verifyStorageToken(purpose=upload)
  Note over W: 401 if invalid, expired,<br/>tampered, or a download token
  W->>S: putObject(token.key, bytes)
  W-->>U: 200 {bytes}

  U->>W: POST /api/assets/{assetId}/complete {organizationId}
  W->>AS: completeUpload(actor, org, assetId)
  AS->>AZ: require membership + property:write
  AS->>S: getObject(key)
  AS->>R: status = UPLOADED, sizeBytes = actual
  AS->>AS: re-check real size vs limit
  AS->>AS: sniffMimeType(bytes) → allowlist check
  AS->>R: status = SCANNING, mimeType = sniffed
  AS->>MS: scan(bytes)
  MS-->>AS: CLEAN
  AS->>R: status = PROCESSING
  AS->>IP: process(bytes)
  IP-->>AS: normalized + thumbnail + w/h + pHash<br/>(EXIF/GPS stripped, orientation applied)
  AS->>AS: enforce min/max dimensions
  AS->>S: putObject(normalized key), putObject(thumbnail key)
  AS->>R: listWithPerceptualHash → hamming distance
  AS->>R: status = READY (keys, dims, sha256, pHash)
  AS->>AL: asset.upload_completed, asset.ready
  AS-->>W: {status: READY, duplicateOf[]}
  W-->>U: ready + duplicate hints

  U->>W: GET /api/assets/{id}/download-url?variant=thumbnail
  W->>AS: createDownloadUrl(...)
  AS->>AS: require status == READY
  AS->>S: createSignedDownloadUrl(key, 300s)
  AS->>AL: asset.download_url_issued
  AS-->>U: short-lived signed URL
  U->>W: GET /api/storage/download?token=...
  W->>W: verifyStorageToken(purpose=download)
  W-->>U: bytes (private, no-store, nosniff, sandbox CSP)
```

## Rejection, quarantine, failure, and recovery

```mermaid
sequenceDiagram
  autonumber
  actor U as Creator
  participant AS as AssetService
  participant MS as MalwareScanner
  participant IP as ImageProcessor
  participant AL as AuditLog

  U->>AS: completeUpload
  alt real bytes are not an allowed image
    AS->>AL: asset.rejected (reason)
    AS-->>U: REJECTED — "Unsupported or mismatched file type"
  else actual bytes exceed size limit
    AS->>AL: asset.rejected
    AS-->>U: REJECTED — "File exceeds the maximum size"
  else scanner reports INFECTED
    AS->>MS: scan
    AS->>AL: asset.quarantined
    AS-->>U: QUARANTINED — never downloadable
  else scanner cannot complete
    AS->>AL: asset.failed
    AS-->>U: FAILED — retryable
  else image cannot be decoded
    AS->>IP: process → throws
    AS->>AL: asset.failed
    AS-->>U: FAILED — retryable
  else dimensions outside limits
    AS->>AL: asset.rejected
    AS-->>U: REJECTED — too small / too large
  end

  Note over U,AS: Failed-upload recovery
  U->>AS: POST /api/assets/{id}/retry
  AS->>AS: allow only PENDING_UPLOAD or FAILED
  AS->>AS: reset key to original.bin, status = PENDING_UPLOAD
  AS->>AL: asset.upload_requested (retry: true)
  AS-->>U: fresh signed upload URL (same asset row — no duplicate)
```

## State machine

```mermaid
stateDiagram-v2
  [*] --> PENDING_UPLOAD : requestUpload
  PENDING_UPLOAD --> UPLOADED : completeUpload finds bytes
  UPLOADED --> SCANNING : MIME + size accepted
  UPLOADED --> REJECTED : bad type / oversize
  SCANNING --> PROCESSING : scan CLEAN
  SCANNING --> QUARANTINED : scan INFECTED
  SCANNING --> FAILED : scan could not complete
  PROCESSING --> READY : normalized + thumbnail + pHash
  PROCESSING --> REJECTED : dimensions out of range
  PROCESSING --> FAILED : decode error
  FAILED --> PENDING_UPLOAD : retryUpload
  READY --> DELETION_PENDING : requestDeletion / property delete
  QUARANTINED --> DELETION_PENDING : requestDeletion
  REJECTED --> DELETION_PENDING : requestDeletion
  DELETION_PENDING --> DELETED : retention job (not implemented, Phase 7)
  READY --> [*]
  DELETED --> [*]
```

`READY`, `QUARANTINED`, `REJECTED`, `FAILED`, and `DELETED` are treated as
terminal by `isTerminalAssetStatus`. `PENDING_UPLOAD`, `UPLOADED`, `SCANNING`,
`PROCESSING`, and `READY` occupy a slot against the per-property file count.

> **Implementation note.** Steps 3–5 (scan, normalize, hash) currently run
> inline inside the `complete` request. Moving them onto the async worker is a
> tracked follow-up for Phase 4 (`docs/decisions/TODO.md`).
