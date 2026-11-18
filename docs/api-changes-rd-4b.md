# API Changes — RD-4b

The staging sink's upload in Google Cloud Storage (ADR-0161). **No
migration, no route, no page and no setting.** The worker's view of a
Cloud Storage bucket gains the four calls the staging sink makes to store a
provider's scene video; the sink is unchanged, and the worker is not given
the view yet.

## HTTP and environment

No change.

## Internal API

### Changed: `@app/storage/google-cloud-storage`

| Export | Change |
| --- | --- |
| `GoogleCloudStorageObjectClient` (type) | now also `@app/storage`'s `S3MultipartClient`, as the shared folder's view is |
| `GOOGLE_CLOUD_STORAGE_CHUNK_QUANTUM_BYTES` | new: 256 KiB, of which every chunk of a resumable upload but its last is a whole number |

The worker's view gains:

| Call | What it does |
| --- | --- |
| `createMultipartUpload({ bucket, key, expectedBucketOwner })` | starts one resumable upload with `ifGenerationMatch=0`, within the 3-second question limit, and answers a random `uploadId`; the session's URI stays in the adapter. A `412` still answers an `uploadId`, whose parts are dropped |
| `uploadPart({ …, uploadId, partNumber, body, checksumSha256Base64 })` | checks the part's number and SHA-256, keeps a copy of it, and sends the part held before as a chunk with no total, which must be answered `308` with every byte sent so far; answers the part's tag |
| `completeMultipartUpload({ …, uploadId, parts, ifNoneMatch: "*" })` | checks that the parts are those taken, then sends the last as the chunk that names the object's size, with the object's MD5 in `X-Goog-Hash`; resolves on `200` or `201` |
| `abortMultipartUpload({ …, uploadId })` | lets the upload go and sends its session one `DELETE`, within the question limit; `499`, `404` and `410` resolve |

All four refuse, with `CONFIGURATION_ERROR` and nothing sent, a bucket
other than the store's and any `expectedBucketOwner`. A completion without
`ifNoneMatch: "*"` is `INTERNAL_ERROR`.

New codes:

| Code | When |
| --- | --- |
| `STORAGE_PRECONDITION_FAILED` | the completion of an upload the store refused with `412`, at its start, on a chunk or on its last chunk; the error carries `$metadata.httpStatusCode` `412`, as the sink reads a lost race |
| `STORAGE_UNKNOWN_UPLOAD` | an upload this store did not start, or started for another key |
| `STORAGE_UPLOAD_BUSY` | a part or a completion while another call on the upload is unanswered; a cancel is always taken |
| `STORAGE_UPLOAD_FAILED` | a call on an upload once a request on it failed |
| `STORAGE_PART_REFUSED` | a part out of order, sent again, empty or whose SHA-256 is not its bytes'; a part not a whole number of 256 KiB followed by another; a completion naming other parts than those taken, or none |

A session at another origin or path than the store's upload path, with
credentials or a fragment, or with no `upload_id`, is
`STORAGE_UNEXPECTED_ANSWER`. No error names the session.

### Unchanged

`@app/storage`'s exports, the staging sink among them; the web app's
adapters; the worker, which constructs no Cloud Storage view.
