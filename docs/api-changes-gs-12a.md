# API Changes — GS-12a

Serving a stored video, a range at a time (ADR-0115). **No migration, no new
route path and no environment variable**; the download route answers `HEAD`
itself.

## HTTP

### Changed: `GET /api/storage/download?token=…`

The signed download route streams what it serves and answers one byte range.
The token is checked as before, and is the route's only check.

| The request | The answer |
| --- | --- |
| no `Range` header | `200`, the whole object |
| `Range: bytes=a-b`, `bytes=a-` or `bytes=-n`, naming bytes the object holds | `206`, those bytes, `Content-Range: bytes first-last/size` |
| one byte range that is not satisfiable (a first byte at or past the end, `bytes=-0`) | `416`, no body, `Content-Range: bytes */size` |
| a suffix of an empty object | `200`, the whole object |
| several ranges, another unit, or a malformed header | `200`, the whole object (RFC 9110, section 14.2) |
| a range with `If-Range` | `200`, the whole object: no validator is sent, so the condition is never met |
| nothing stored at the key | `404` `Not found`, as before |
| no token, a bad or expired one, an upload token, or one naming an internal key or a scene video | `401` `Unauthorized` |

Every `200`, `206` and `416` carries `Accept-Ranges: bytes`,
`Cache-Control: private, no-store`,
`Content-Security-Policy: default-src 'none'; sandbox` and
`X-Content-Type-Options: nosniff`. `Content-Length` is the bytes sent. The
`401` and `404` now carry `Cache-Control: private, no-store` too.

`Content-Type` is `video/mp4` for a customer's video
(`org/{organizationId}/deliverables/{deliverableVersionId}/output`),
`image/webp` or `image/jpeg` for a photo by its extension, as before, and
`application/octet-stream` otherwise.

Nothing a customer reaches signs a video's key yet (GS-12b, GS-12c).

### Added: `HEAD /api/storage/download?token=…`

The `GET` answer's status and headers, with no body; the object is let go at
once. Next.js answered `HEAD` through the `GET` handler before.

## Internal API

### Added: `@app/domain`, `ObjectStorage.readObject(key, range)`

An object, or one byte range of it, as a stream: `{ kind: "ABSENT" }`,
`{ kind: "UNSATISFIABLE", size }`, or
`{ kind: "READ", size, start, length, body }`. A `null` range reads the whole
object. The caller reads the stream to its end or cancels it. Implemented by
`LocalObjectStorage` and the shared folder's web view.

### Added: `@app/domain`, `ObjectByteRange`, `ObjectRead`, `resolveObjectByteRange(range, size)`

The two range forms (`FROM` a first byte to a last one or the end, the `LAST`
*n* bytes), the read's answer, and the bytes a range names in an object of a
given size, or `null` when it is not satisfiable.

### Added: `@app/domain`, `isSceneOutputStorageKey(key)`, `SCENE_OUTPUT_STORAGE_SEGMENT`

`true` for `org/{organizationId}/generations/…`.

### Changed: `@app/domain`, `isSignableStorageKey(key)` and `assertSignableStorageKey(key)`

A scene video's key is no longer signable: the signers throw
`INTERNAL_ERROR` ("An internal-only, scene or non-canonical storage key is
never given a signed URL") and the verifier ignores a token naming one.

### Added: `@app/domain`, `isDeliverableOutputKey(key)`

`true` for a key of the shape `managedDeliverableOutputKey` builds.

### Added: `apps/web`, `parseRangeHeader(header)` and `storageContentType(key)`

In `apps/web/src/lib/storage-read.ts`: the one byte range a `Range` header
asks for, or `null` to serve the whole object; and the content type an object
is served with.
