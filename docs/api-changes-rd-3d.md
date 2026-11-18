# API Changes — RD-3d

Google Cloud Storage in the web app (ADR-0159). **No migration, no new route
and no page.** The web app keeps its objects in Google's own Cloud Storage
when a production environment names a bucket, and in the Cloud Storage
emulator when a development or CI environment names a bucket and an
endpoint.

## HTTP

No change to any route or page. Readiness's storage check names the new
choices:

| Environment | `storage` check's detail |
| --- | --- |
| a bucket, no endpoint (production) | `adapter=gcs, answers` or `adapter=gcs, does not answer` |
| a bucket and an endpoint (development, CI) | `adapter=gcs-emulator, …` |
| `SHARED_STORAGE_DIR`, or nothing | `adapter=shared-folder, …` or `adapter=memory, …`, as before |

## Environment

| Variable | Rule |
| --- | --- |
| `GOOGLE_CLOUD_STORAGE_BUCKET` (new, optional) | 3 to 63 lowercase letters, digits, `.`, `-` or `_`, beginning and ending with a letter or a digit; not beside `SHARED_STORAGE_DIR`; outside production, only with an endpoint |
| `GOOGLE_CLOUD_STORAGE_ENDPOINT` (new, optional) | an `http` or `https` origin with no user, path, query or fragment; only with a bucket; refused in production; outside production, refused at `googleapis.com` or any name below it |
| `NODE_DEBUG` (now read) | refused in production when not empty |

Each refusal is one line of the schema's error, naming the variable and the
rule and never the value. A production start of the web app reports it and
ends with exit code 1 (ADR-0151); the worker ends too, as for any invalid
setting.

## The production start check

`PRODUCTION_ADAPTERS.storage` is `["gcs"]`. A production start with a bucket
is refused only for malware scanning and email; one with the emulator, the
shared folder or memory is refused for object storage, as before.

## Internal API

### New: `@app/shared`

| Export | What it is |
| --- | --- |
| `GOOGLE_CLOUD_STORAGE_ORIGIN` | `https://storage.googleapis.com`, Google's store, the one origin the adapter sends a token to; moved from the adapter |
| `isCloudStorageBucketName(name)` | whether `name` is 3 to 63 lowercase letters, digits, `.`, `-` or `_`, beginning and ending with a letter or a digit: every Cloud Storage name of at most 63 characters, and a few Cloud Storage refuses (ADR-0156); the schema's and the adapter's |

### Changed: `apps/web`

| Module | Change |
| --- | --- |
| `adapter-choice.ts` | `WebAdapterChoice["storage"]` gains `"gcs"` and `"gcs-emulator"` |
| `adapters.ts` | builds Google's store on `GOOGLE_CLOUD_STORAGE_ORIGIN` only where both `NODE_ENV` values say production, else `CONFIGURATION_ERROR`; builds the emulator on the endpoint, refused with `NonProductionAdapterError` where either says production, and with `CONFIGURATION_ERROR` at Google's origin |
| `startup.ts` | `PRODUCTION_ADAPTERS.storage` is `["gcs"]` |

### Unchanged

`@app/storage/google-cloud-storage`'s exports and behaviour; `@app/storage`'s
exports. `LocalObjectStorage`'s production refusal names the Google Cloud
Storage adapter as the action, in place of an S3 or Azure adapter.
