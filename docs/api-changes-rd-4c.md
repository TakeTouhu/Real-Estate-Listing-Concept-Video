# API Changes — RD-4c

The development pipeline beside the Cloud Storage emulator (ADR-0162).
**No migration, no route, no page and no new setting.** The development
pipeline keeps its objects in the shared folder or, in its place, in a
bucket of the Cloud Storage emulator, where the web app keeps its photos.

## HTTP

No change.

## Environment

The pipeline command now reads the web app's two Cloud Storage settings,
whose rules are unchanged (ADR-0159):

| The command's environment | The pipeline |
| --- | --- |
| `SHARED_STORAGE_DIR` alone | runs on the folder, as before |
| `GOOGLE_CLOUD_STORAGE_BUCKET` and `GOOGLE_CLOUD_STORAGE_ENDPOINT`, no folder | runs on the emulator's bucket |
| anything else | refused before any step runs, exit 2 |

New refusals of the pipeline's assembly, each a `CONFIGURATION_ERROR`, for
an environment the schema may not have parsed:

| Message | When |
| --- | --- |
| The development pipeline needs SHARED_STORAGE_DIR, or a Cloud Storage emulator's bucket and endpoint | no store is named; it replaces "The development pipeline needs SHARED_STORAGE_DIR" |
| The development pipeline takes SHARED_STORAGE_DIR or the Cloud Storage settings, not both | the folder beside a bucket or an endpoint |
| The development pipeline needs GOOGLE_CLOUD_STORAGE_BUCKET with GOOGLE_CLOUD_STORAGE_ENDPOINT | an endpoint without a bucket |
| The development pipeline uses a Cloud Storage emulator, never Google's own store | a bucket without an endpoint, or an endpoint whose host is `googleapis.com` or a name below it |

An endpoint that is not an http(s) origin, or a bucket Cloud Storage
cannot name, is refused by the adapter as it is built, with its own
messages (ADR-0156).

The settings still refuse a bucket beside `SHARED_STORAGE_DIR`. Only that
refusal's reason changes, since the worker no longer looks for objects in
the folder when a bucket is set:

| Message | Was |
| --- | --- |
| GOOGLE_CLOUD_STORAGE_BUCKET and SHARED_STORAGE_DIR must not both be set: the web app and the development pipeline keep their objects in one store | … must not both be set: the web app would keep objects in the bucket, and the worker look for them in the folder |

## Internal API

### New

| Export | What it is |
| --- | --- |
| `isGoogleApiAddress(value)` from `@app/shared` | whether an address's host is `googleapis.com` or a name below it, with a final dot or not; `false` for text that is not an address. The settings' own rule, now shared with the pipeline |

### Changed

| Export | Change |
| --- | --- |
| `DevelopmentPipelineEnv` (worker) | gains `GOOGLE_CLOUD_STORAGE_BUCKET` and `GOOGLE_CLOUD_STORAGE_ENDPOINT` |
| `assembleDevelopmentPipeline(env, options, deps)` (worker) | builds on the folder or on the emulator's views, `createGoogleCloudStorageViews` with the pipeline's signing base, and gives every seam that store's bucket |
| `USAGE` (worker's command) | names the emulator's settings |

### Unchanged

`@app/storage` and its Cloud Storage subpath, and the photo reader, but for
comments that name the emulator; the web app's adapters; the command's
arguments and exit codes; the browser test, which keeps its folder.
