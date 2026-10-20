# API Changes — DS-4

The Clean Master record and its internal location (ADR-0074). **Migration 30.
No route, page, export to customers, command or environment variable is
added.** The two signed storage routes now refuse a token for an internal key,
which nothing issues; every other request is answered as before.

## HTTP

| Route | Change |
| --- | --- |
| `GET /api/storage/download` | a token naming a key under `org/{organizationId}/internal/` is answered `401 Unauthorized`, as a forged token is |
| `PUT /api/storage/upload` | the same, and nothing is written |

## Internal API

### Added: `@app/domain` Clean Master key

| Export | Shape |
| --- | --- |
| type `ManagedCleanMasterKey` | a branded string, distinct from `ManagedGenerationOutputKey` and `ManagedDeliverableOutputKey` |
| `managedCleanMasterKey({ organizationId, deliverableVersionId })` | `org/{organizationId}/internal/clean-masters/{deliverableVersionId}`; throws `VALIDATION_FAILED` for a blank identifier or one containing `/` |
| `INTERNAL_STORAGE_SEGMENT` | `"internal"`, the third segment of every internal-only key |
| `isInternalStorageKey(key)` | `true` for `org/{organizationId}/internal/…`, exact and case-sensitive |
| `assertSignableStorageKey(key)` | throws `INTERNAL_ERROR` (500) for an internal key; its message names no key |

### Changed: `@app/storage` signing

| Name | Change |
| --- | --- |
| `signStorageToken` | throws for an internal key, for either purpose |
| `verifyStorageToken` | returns `null` for a token naming an internal key |
| `LocalObjectStorage.createSignedUploadUrl` / `createSignedDownloadUrl` | reject for an internal key; a refusal is now a rejected promise rather than a synchronous throw |

## Database

`generation_deliverable_clean_masters`, `GenerationDeliverableCleanMaster` in
Prisma, with `GenerationDeliverableVersion.cleanMaster`. Nothing writes it yet.
See `docs/migration-notes.md`, *DS-4*.
