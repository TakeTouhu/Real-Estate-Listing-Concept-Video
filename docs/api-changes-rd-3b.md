# API Changes — RD-3b

The Google Cloud Storage adapter's streamed read (ADR-0157). **No migration,
no new route and no page.** Nothing in either application constructs the
adapter.

## HTTP

No change. Every route and page answers as before, with the same adapters
from the same environment.

## Internal API

### Changed: `@app/storage/google-cloud-storage`

| Export | Change |
| --- | --- |
| `createGoogleCloudStorage(options)` | returns an `ObjectStorage`: it gains `readObject(key, range)`, the port's streamed read (ADR-0115) |
| `GoogleCloudStorageObjects` | **removed**: the adapter is the whole port |
| `GoogleCloudStorageError` | gains `STORAGE_OBJECT_CHANGED` (the object was written again between a read's two requests); `STORAGE_UNEXPECTED_ANSWER` also names an answer that is not the bytes asked for, and a stream that ends short or runs over |
| `GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS` | also limits the size a read asks first |

### What a read asks

| Request | When | Limit |
| --- | --- | --- |
| `GET /storage/v1/b/{bucket}/o/{key}?fields=size,generation,contentEncoding` | always | 3 seconds, gaxios's own |
| `GET /storage/v1/b/{bucket}/o?prefix={key}&maxResults=1` | after a `404` to either other request | 3 seconds, gaxios's own |
| `GET /storage/v1/b/{bucket}/o/{key}?alt=media&generation={generation}` with `Range: bytes={first}-{last}` and `accept-encoding: identity` | the range holds at least one byte | none |

| Outcome | When |
| --- | --- |
| `ABSENT` | the size's request answers `404`, or the bytes' does and the key is not listed, and the list answered |
| `UNSATISFIABLE` with the size | the range holds none of the object's bytes |
| `READ` with the size, the first byte, the length and the stream | otherwise; an object of no bytes reads an ended stream |

Each request is sent once, with no credential; a redirect is not followed.
