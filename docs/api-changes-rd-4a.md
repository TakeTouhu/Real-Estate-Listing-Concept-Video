# API Changes — RD-4a

The worker's reads and first-wins writes in Google Cloud Storage
(ADR-0160). **No migration, no route, no page and no setting.** The Google
Cloud Storage adapter gains the worker's view of its bucket; nothing
constructs it yet.

## HTTP and environment

No change.

## Internal API

### New: `@app/storage/google-cloud-storage`

| Export | What it is |
| --- | --- |
| `createGoogleCloudStorageViews(options)` | `{ objectStorage, objectClient }` on one bucket, one set of connections and one token; the options are `createGoogleCloudStorage`'s |
| `GoogleCloudStorageViews` (type) | those two views |
| `GoogleCloudStorageObjectClient` (type) | the worker's view: `@app/storage`'s `DeliverableObjectClient`, so also an `S3ManagedObjectReader` |

The worker's view:

| Call | What it does |
| --- | --- |
| `getObject({ bucket, key, expectedBucketOwner })` | the object's size and generation, then that generation's bytes as a body read one chunk at a time; `{ contentLength: null, body: null }` only once a list proves the key absent; a missing bucket is `STORAGE_BUCKET_MISSING` |
| `putObjectIfAbsent({ bucket, key, localPath, contentType, expectedBucketOwner })` | one media upload with `ifGenerationMatch=0`, streamed from the file with its length and its MD5 in `X-Goog-Hash`; `CREATED` on `200`, `ALREADY_EXISTS` on `412` |

Both refuse, with `CONFIGURATION_ERROR` and nothing sent, a bucket other
than the store's and any `expectedBucketOwner`; a key the adapter cannot
name is `INTERNAL_ERROR`, as for the web app's port.

A new code, `STORAGE_BODY_CANCELLED`, refuses a body's `read` after its
`cancel`. A file that cannot be read is refused with its transport code,
such as `ENOENT`, naming no path.

### Changed

| Export | Change |
| --- | --- |
| `createGoogleCloudStorage(options)` | returns `createGoogleCloudStorageViews(options).objectStorage`; the web app's port is unchanged |

### Unchanged

`@app/storage`'s exports; the web app's adapters, which construct the
adapter as before; the worker, which constructs no Cloud Storage view.
