# API Changes — GS-3

A shared folder holds development and CI objects (ADR-0085). **No migration,
no route and no page.** One optional environment variable is added, refused in
production.

## HTTP

No change. The signed upload and download routes serve whichever store the web
app was given, exactly as before.

## Environment

| Variable | Shape | Effect |
| --- | --- | --- |
| `SHARED_STORAGE_DIR` | optional; an absolute path; refused when `NODE_ENV=production` | the web app stores objects in this folder, shared with the worker; unset, it keeps them in its own memory as before |

## Internal API

### Added: `@app/storage`

| Export | Shape |
| --- | --- |
| `createSharedFolderStorage({ root, secret, basePath?, now?, nodeEnv? })` | opens an absolute folder, readable by this user alone; throws `NonProductionAdapterError` when the process's or the given `NODE_ENV` is `production` (no escape hatch), and `CONFIGURATION_ERROR` for a relative path or a folder it cannot open or adopt (the message carries a code, never the path); returns `{ objectStorage, objectClient }` and holds the objects folder open for its life |
| `SharedFolderStorage.objectStorage` | the domain's `ObjectStorage` port: put, get, delete, exists, signed upload and download URLs; refuses a key that is not canonical with `INTERNAL_ERROR`, and a read or check it cannot prove with `INTERNAL_ERROR` and a code |
| `SharedFolderStorage.objectClient` (`SharedFolderObjectClient`) | `S3MultipartClient` and `DeliverableObjectClient`: multipart create, upload part, conditional complete, abort, streaming get, `putObjectIfAbsent` |
| `SHARED_FOLDER_STORAGE_BUCKET` | `"shared-folder"`, the one bucket `objectClient` accepts |
| `SHARED_FOLDER_READ_CHUNK_BYTES` | 1 MiB, the most one streamed read returns |
| `SharedFolderStorageError` | a refusal with `$metadata.httpStatusCode` and a fixed name: `404 NoSuchBucket`, `403 AccessDenied` (an owner check was asked for), `400 InvalidKey`, `400 BadDigest`, `400 InvalidArgument`, `400 MalformedXML`, `400 InvalidPartOrder`, `400 InvalidPart`, `404 NoSuchUpload`, `412 PreconditionFailed` (a losing completion), `501 NotImplemented` (an unconditional completion), `500 BodyCancelled`, `500 BodyReadFailed`, `500 InternalError (CODE)` |
| The store's own codes | `FOLDER_NOT_PRIVATE` (a folder is a link or another user's), `FOLDER_MISSING` (the objects folder was deleted or replaced, so absence cannot be proved), `NOT_AN_OBJECT` (a device or pipe at a key), `SHORT_WRITE` (a completion's staged file is not the bytes appended) |
| `signedStorageUrl({ key, purpose, ttlSeconds, secret, basePath, now })` | the one helper both stores make signed URLs with; it calls `signStorageToken`, which refuses an internal-only key |

### Changed

- `LocalObjectStorage` makes its signed URLs through `signedStorageUrl`. Same
  URLs, same refusals.
- `apps/web/src/lib/property.ts`: `PropertyServices.storage` is typed as the
  `ObjectStorage` port, and the new `createObjectStorage(env)` picks the store.

### Unchanged on purpose

- The `ObjectStorage` port and the S3-shaped seam. Every existing caller runs
  over the folder without a change.
- The worker. Nothing in it uses storage yet; GS-9's pipeline command opens the
  folder.

## Database

No migration, no schema change. See `docs/migration-notes.md`.
