# ADR-0092 — The test provider makes a real clip from the photo

Status: Accepted (GS-6, 2026-10-28). Sixth step of the generation-to-preview
plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`, row GS-6 and Design 3:
"a test provider that makes real video").
Builds on: ADR-0090 (the test route: Normal at 720p, HQ at 1080p, each
generated at its own size), ADR-0040 and ADR-0041 (the status source and byte
source ports the provider-output runner takes), ADR-0038 (a provider's output
location is never written down), ADR-0075 (FFmpeg through the no-shell process
runner), ADR-0085 (the shared folder storage).

## Context

The fake provider accepted every request and answered every status question
with a made-up address and no bytes. Nothing after submission could run on it:
the provider-output runner takes a status source and a byte source, and the
fake offered neither. A video made on a development machine could therefore
never reach composition, and the test route's catalog entry claimed 720p and
1080p clips nothing made (`docs/decisions/TODO.md`, the GS-6 item).

## Decision 1 — A studio behind the fake provider, outside production only

`createFakeClipStudio` in `@app/video-providers` builds the test provider's
back end: `make` turns one request into one clip and keeps it, `statusSource`
answers for the clips it keeps, and `byteSource` streams them. It is refused
when the given or the ambient `NODE_ENV` is `production`, with no override, and
unless `VIDEO_PROVIDER` is `fake`, as the test route is (ADR-0090). Its folder
is an absolute path it is given.

The clip itself is made by a `FakeClipRenderer` it is given. The FFmpeg one,
`createFfmpegFakeClipRenderer`, is in `@app/storage` with the composer, and is
refused in production the same way.

Nothing in either application builds the studio or the renderer yet. The
pipeline command (GS-9) will be first, and a static test lists their callers.

## Decision 2 — The clip is made before the request is accepted

`FakeVideoProvider` takes an optional studio. With one, `createGeneration`
asks it for the clip first: made, and the request is `ACCEPTED` under the
prediction id `fake_<request hash>`, as before; not made, and it is
`DEFINITIVELY_REJECTED` with the fixed error `FAKE_CLIP_NOT_MADE`, not
retryable. A refusal is the truth here: the fake holds nothing for a request it
could not make, and once a scene's attempts end without a video GS-2's
settlement releases the Unit (ADR-0083). The configured `DEFINITIVELY_REJECTED` and `SUBMISSION_UNKNOWN`
outcomes come first and make nothing, so the failure paths stay reachable
without FFmpeg.

Without a studio the fake behaves exactly as before.

## Decision 3 — The photo is read the way a provider reads it

A provider is handed a short-lived signed URL for the scene's normalized photo
and fetches it. The studio does the same through a `FakeSourcePhotoReader` it
is given, which reads the bytes behind the URL or answers `null`. The
composition supplies it by redeeming the URL's token as the download route
does; the media suite does exactly that. An unreadable or empty photo is a clip
not made.

## Decision 4 — The clip's frame and length are the request's

The frame is the request's aspect ratio at its **native** size, from the
composition profile's raster table: 720p at 16:9 is 1280×720, 1080p at 9:16 is
1080×1920. That is the size the test route's catalog entry records each target
as generated at (ADR-0090 Decision 4), so the composer's fit is a no-op and
nothing is upscaled. The length is the requested whole seconds, from 1 to 60,
at 30 frames a second. A model other than the test model, a shape or size the
table does not hold, or another length is a clip not made.

## Decision 5 — What the clip shows

The whole photo, fitted into the frame and never cropped, as the composer
never crops a customer's photo; over the clip the view zooms in by 8 % and
drifts from the left edge to the right. H.264 in MP4, `yuv420p`, no audio, and
nothing from the photo's metadata. FFmpeg runs through the injected
`ProcessRunner` with a fixed argument vector and no shell, bounded to five
minutes; anything but a clean exit is a clip not made. A 5-second 720p clip
took about two seconds and a 1080p one about four on a four-core development
container.

FFmpeg is not given the JPEG. The photo is first decoded by sharp, the library
that encoded it on upload, and handed over as a PNG in the clip's work folder:
FFmpeg 6.1, the version CI installs, refuses some of the image pipeline's own
JPEGs (mozjpeg's encoding of an image with large flat areas: one flat colour,
or a white wall with one dark square, failed), which a provider reads without
complaint. A photo sharp cannot decode is a clip not made.

## Decision 6 — Kept by a name no request controls

Each clip is a file in the studio's folder named by the SHA-256 of its
prediction id, so a prediction id never becomes a path. It is rendered in a
private work folder inside the studio's and linked into place, so no reader
sees half a clip and the first of two makes of one request stands. A request
whose clip is kept is not made again.

The status source answers `SUCCEEDED`, with a locator, for a prediction of the
test model whose clip is kept. For anything else it throws the fixed
`FAKE_CLIP_UNKNOWN` error, which the runner records as `STATUS_SOURCE_FAILED`
without changing the attempt: it never reports a provider failure it did not
see. It never answers `IN_PROGRESS`, since the clip exists before acceptance.

That includes a clip gone after acceptance, because its folder was deleted or
the status source was built over another folder: the studio cannot tell those
apart, and answering `FAILED` for the second would end accepted attempts on a
configuration mistake. Such an attempt stays `PROCESSING`, as one does when a
real provider stops answering, until an attempt's running time is bounded (the
open item *Bound how long an attempt may run before it is treated as failed*
in `docs/decisions/TODO.md`, which must be settled before generation is
activated). The folder must therefore not be deleted while attempts are in
flight.

## Decision 7 — A locator names no file, and is never read

A locator is a credential everywhere else (ADR-0038), so the studio does not
put a file in one: its value is random, new at each answer. The studio
remembers which clip each locator it issued stands for, and its byte source
opens only those: a locator it did not issue, even one naming the clip's file
or issued by another studio over the same folder, opens nothing
(`RETRYABLE_FAILURE`), as does a clip that is gone or empty. One studio must
therefore serve both the status source and the byte source; GS-9 builds one.
The byte source never reads a locator's raw value, so the access capability
keeps its one authorized importer, the fal byte source.

The clip is streamed in pieces of at most 1 MiB, never more or fewer bytes than
the size it declared; a failed read, or a clip that ends early, is the branded
retryable interruption the transfer core expects. A file it opened and then
refused is closed at once, and a stream's file is closed once however often
the stream is.
The storage dormancy test now authorizes this second `ProviderOutputByteSource`
by name, beside fal's.

## Not decided here

- **What runs the steps.** Submission (GS-7) and the pipeline command (GS-9)
  compose the studio, the renderer and the photo reader; nothing does yet.
- **Clearing the studio's folder.** Clips stay until a person deletes the
  folder, which a development database reset should do too, never while
  attempts are in flight (Decision 6). A process stopped in the middle of a
  render leaves its `work-` folder behind, which the same deletion clears.
- **A fake that fails after accepting.** The end-to-end failure test (GS-13)
  can use the configured refusal; a failure reported by the status source is
  added only if a test needs one.

## Consequences

- `@app/video-providers` exports `createFakeClipStudio` and its types;
  `FakeVideoProviderOptions` gains `studio`.
- `@app/storage` exports `createFfmpegFakeClipRenderer`,
  `ffmpegFakeClipArgsFor` and the clip constants.
- The media suite makes a clip on real FFmpeg and takes one from a photo in the
  shared folder storage, through the provider, the status source, the byte
  source, the streaming transfer and the media validator, to a valid 1080×1920
  five-second video.
- No migration, no route, no page. Paid provider activation and production
  scheduling stay BLOCKED (ADR-0054 Decision 7).
