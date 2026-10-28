# API Changes — GS-6

The test provider makes a real clip from the photo (ADR-0092). **No
migration; no route and no page.** Nothing outside tests builds the studio or
the clip maker yet.

## HTTP

No change.

## Internal API

### Added: `@app/video-providers`

| Export | What it is |
| --- | --- |
| `createFakeClipStudio(env, { root }, { renderer, photos })` | the test provider's back end, refused in production (given or ambient `NODE_ENV`) and unless `VIDEO_PROVIDER=fake`, and given an absolute folder. `make(input)` reads the photo behind `input.sourceImageUrl`, makes the clip at the request's aspect ratio and native size and length, and keeps it: `"MADE"` or `"NOT_MADE"`, never a throw. `statusSource.poll(ref)` answers `SUCCEEDED` with a locator for a kept clip of the test model, and throws `FAKE_CLIP_UNKNOWN` otherwise. `byteSource.open(locator)` streams the clip behind a locator the studio issued, exactly its declared size, `RETRYABLE_FAILURE` for any other. One studio serves both sources |
| `FakeClipStudio`, `FakeClipStudioOptions`, `FakeClipStudioDeps`, `FakeClipMakeOutcome` | its types |
| `FakeClipRenderer` | the port that turns one photo file into one clip file: `RENDERED` or `FAILED` |
| `FakeSourcePhotoReader` | the port that reads the bytes behind a signed URL, or `null` |

### Added: `@app/storage`

| Export | What it is |
| --- | --- |
| `createFfmpegFakeClipRenderer({ runner }, { programPath?, timeoutMs?, nodeEnv? })` | the FFmpeg `FakeClipRenderer`, refused in production (given or ambient). It decodes the photo with sharp into a PNG beside the clip, then runs FFmpeg on that; a photo sharp cannot decode, or anything but a clean exit, is `FAILED`. Timeout from 1 second to 5 minutes, 5 by default |
| `ffmpegFakeClipArgsFor({ picturePath, outputPath, widthPx, heightPx, durationSeconds })` | its fixed argument vector; refuses odd or over-1920 sides and lengths outside 1 to 60 whole seconds |
| `FAKE_CLIP_FRAME_RATE`, `FAKE_CLIP_ZOOM_IN`, `FAKE_CLIP_MAX_DURATION_SECONDS`, `DEFAULT_FAKE_CLIP_TIMEOUT_MS` | 30 frames a second, 8 % zoom, 60 seconds, 5 minutes |
| `FakeClipRenderInput`, `FakeClipFfmpegInput`, `FakeClipRenderOutcome`, `FakeClipRendererConfig` | its types |

### Changed

| Where | Change |
| --- | --- |
| `FakeVideoProviderOptions` (`@app/video-providers`) | gains `studio`. With one, `createGeneration` is `ACCEPTED` only once the studio made the clip, and `DEFINITIVELY_REJECTED` with `FAKE_CLIP_NOT_MADE` (not retryable) when it could not. Without one, unchanged |
