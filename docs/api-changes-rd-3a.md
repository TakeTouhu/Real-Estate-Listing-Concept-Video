# API Changes — RD-3a

The Google Cloud Storage adapter's object model, over the Cloud Storage JSON
API, and the Cloud Storage emulator in CI (ADR-0156). **No migration, no new
route and no page.** Nothing in either application constructs the adapter.

## HTTP

No change. Every route and page answers as before, with the same adapters
from the same environment.

## Internal API

### Added: `@app/storage/google-cloud-storage`

A subpath of its own, so nothing that loads `@app/storage` loads gaxios.

| Export | Shape |
| --- | --- |
| `createGoogleCloudStorage(options)` | the port's operations but the streamed read, over one bucket: `createSignedUploadUrl`, `createSignedDownloadUrl`, `putObject`, `getObject`, `deleteObject`, `exists`; throws `CONFIGURATION_ERROR`, naming nothing given, for a bucket or an endpoint it cannot use |
| `GoogleCloudStorageOptions` | `bucket` (Cloud Storage's naming rules, 3 to 63 characters), `endpoint` (an `http` or `https` origin), `secret` (signs the application's own links), `basePath` (default `/api/storage`), `now` |
| `GoogleCloudStorageObjects` | `ObjectStorage` without `readObject` |
| `GoogleCloudStorageError` | a refusal whose `code` and message are one code: `STORAGE_TIMEOUT`, `STORAGE_FORBIDDEN`, `STORAGE_RATE_LIMITED`, `STORAGE_UNAVAILABLE`, `STORAGE_BUCKET_MISSING`, `STORAGE_REFUSED`, `STORAGE_UNEXPECTED_ANSWER`, the transport's one-word code, or `STORAGE_UNREACHABLE` |
| `GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS` | `3000`: gaxios's own limit on a list (`exists`, and the list after a `404`) |
| `GOOGLE_CLOUD_STORAGE_MAX_KEY_BYTES` | `1024`: the longest key sent |

### What each operation asks

| Operation | Request | Absent when |
| --- | --- | --- |
| `exists` | `GET /storage/v1/b/{bucket}/o?prefix={key}&maxResults=1`, limited | the first name listed is not the key |
| `getObject` | `GET /storage/v1/b/{bucket}/o/{key}?alt=media` | it answers `404` and the list then answers |
| `deleteObject` | `DELETE /storage/v1/b/{bucket}/o/{key}` | it answers `404` and the list then answers |
| `putObject` | `POST /upload/storage/v1/b/{bucket}/o?uploadType=media&name={key}` | never: a `404` is the bucket's |

Each is sent once, with no credential; a redirect is not followed.

## Scripts

| Script | What |
| --- | --- |
| `pnpm test:gcs` | the suites under `tests/storage/` (`vitest.gcs.config.ts`), against the emulator named by `GOOGLE_CLOUD_STORAGE_TEST_ENDPOINT` |

## CI

A fifth job, `storage`, runs `pnpm test:gcs` beside the emulator
(`fsouza/fake-gcs-server` 1.56.1, pinned by its digest).
