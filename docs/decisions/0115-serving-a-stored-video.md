# ADR-0115 — Serving a stored video, a range at a time

Status: Accepted (GS-12a, 2026-11-04). The first milestone of row GS-12 of
the generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`: "the finished video
plays in the private workspace. Preview needs `video.view`. Download needs
`video.download`, is audited, and uses a short-lived signed link"). Builds on
ADR-0085 (the shared folder) and ADR-0074 (the internal namespace).

## Context

The signed download route serves an object by reading it whole into memory and
names its content type from the key's extension (ADR-0085, *Not decided
here*). A customer's video is up to 512 MiB, its key
(`org/{organizationId}/deliverables/{deliverableVersionId}/output`) has no
extension, and a player asks for it a byte range at a time so that it can
start before the whole file arrives and seek. Served as it is, a video would
be held whole in the web app's memory for every request, sent as
`application/octet-stream`, and could not be sought.

ADR-0052 Decision 17 makes scene media internal: the customer's video is made
from it and is the only video a customer is given. Scene videos are stored at
`org/{organizationId}/generations/{attemptId}/output`, outside the internal
namespace the signers refuse (ADR-0074), and `docs/decisions/TODO.md` asks
whether they move under it before any route lets a customer download a
deliverable. Nothing signs them today.

## Decision 1 — Storage reads a range of an object as a stream

The `ObjectStorage` port gains `readObject(key, range)`. It answers that
nothing is stored at the key; that the object holds none of the bytes asked
for, with its size; or the object's size, the first byte read, how many, and
those bytes as a stream read only as it is sent. No range reads the whole
object. `getObject`, which the photo pipeline and the development pipeline
use, is unchanged.

The range is one of RFC 9110's two forms: from a first byte to a last one or
to the end, or the last *n* bytes. `resolveObjectByteRange` turns it into the
bytes of an object of a given size, as section 14.1.2 says: a last byte past
the end and a suffix longer than the object are cut to it; a first byte at or
past the end, a suffix of no bytes and any range of an empty object name no
bytes.

## Decision 2 — The shared folder streams from the file it opened

The web app's view of the shared folder (ADR-0085) opens the object's file
once, by the folder's own rules (`openRead`), and reads the range from that
open file in chunks of at most 1 MiB, each only when the reader asks for it:
nothing is read ahead. The file is closed when its last byte is handed over,
when the reader cancels, and when a read fails, and also at once when the
range names no bytes.

- **The object read is the one opened.** A put replaces a key's file by
  renaming a new one over it, so a request that opened the old file goes on
  reading the old bytes.
- **A file shorter than it was when opened is an error**, never padding and
  never a wait: the stream fails with "A stored object ended before its size".
- **A failed read names no path**, only the error's code, as the folder's
  other failures do.

The in-memory store used in tests and development copies the range once and
hands it over as one chunk.

## Decision 3 — The signed download route serves one range

The route still authorizes by its token alone, as before, and now:

| The request | The answer |
| --- | --- |
| no `Range` header | `200`, the whole object |
| one byte range the object holds bytes of (`bytes=a-b`, `bytes=a-`, `bytes=-n`) | `206`, those bytes, with `Content-Range: bytes first-last/size` |
| one byte range the object holds none of | `416`, no body, with `Content-Range: bytes */size` |
| several ranges, another unit, or a header that is not well formed | `200`, the whole object: a server may always ignore a range it does not serve (RFC 9110, section 14.2), and a player asks for one at a time |
| nothing stored at the key | `404`, as before |

Every answer that serves or refuses a range carries `Accept-Ranges: bytes`
and the route's private headers (`Cache-Control: private, no-store`, the
sandboxing content security policy and `nosniff`), and `Content-Length` is
the bytes sent. The body is streamed: the web app never holds the object
whole.

## Decision 4 — A customer's video is served as one

A key of the shape `managedDeliverableOutputKey` builds is served as
`video/mp4`, the type the deliverable is stored with
(`DELIVERABLE_OUTPUT_CONTENT_TYPE`). The key has no extension, so it is known
by its shape (`isDeliverableOutputKey`): exactly five segments, `org`, an
organization, `deliverables`, a version, `output`. A photo is served as before
by its extension, and anything else as bytes, never sniffed.

## Decision 5 — No signed URL names a scene video

Scene videos are **not moved** under the internal namespace. The signers and
the verifier refuse them by their own segment instead: a key whose first
segment is `org` and whose third is `generations` is not signable
(`isSceneOutputStorageKey`), exactly as one whose third is `internal` is not.
A signer asked to sign one throws the internal error it throws for an
internal key, and a token naming one is ignored.

Moving them would change the key of every stored scene output and every row
that records one, for no guarantee the positional refusal does not already
give. This closes the open item in `docs/decisions/TODO.md`.

## Decision 6 — What stays out

- **No customer path names a video yet.** Nothing signs a deliverable's key:
  the preview (GS-12b) and the download (GS-12c) do, each for a member with
  its permission. This milestone only makes the route able to serve one.
- **The token stays the route's only check**, as it is for photos. Whether a
  video's link also needs the member's session is decided with the preview.
- **No production storage adapter exists** (ADR-0085). Whichever is built
  must implement `readObject`, which the port requires.
- **No migration**, no new route, no environment variable and no new
  permission.

## Consequences

- A video stored in the shared folder can be played and sought through a
  signed link once something signs one, and is never held whole by the web
  app.
- Photos are now streamed too and accept ranges; their bytes, content types
  and headers are otherwise as before.
- Every `ObjectStorage` in the tests gained `readObject`.
- The web app keeps a request's file open while its response is read; a
  reader that stops pulling without cancelling holds it until the response is
  dropped.
