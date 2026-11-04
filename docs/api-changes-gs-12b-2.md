# API Changes — GS-12b-2

The delivered video on the project page (ADR-0117). **No migration, no new
route and no environment variable.**

## HTTP

### Changed: `GET /properties/{propertyId}/video-projects/{projectId}` (page)

When the project's video is completed, the page asks
`VideoPreviewService.link` for a link as the member (ADR-0116) and its "Video"
panel plays it: one `video.preview_link_issued` audit entry per such page
load, and one per renewal the player asks for. For any other video the page
asks for nothing. The link is played from `GET /api/storage/download?token=…`,
unchanged (`docs/api-changes-gs-12a.md`).

## Internal API

### Added: `apps/web`, `getVideoPreviewService()` and `readVideoPreview(preview, completed, actorUserId, organizationId, videoProjectId, now?)`

In `apps/web/src/lib/video-preview.ts`, server-only: the link service built
over the database and the web app's object storage, and what the player
plays (`{ src, lifetimeSeconds }`: the whole seconds the link has left, counted
on the server's clock, `now` defaulting to `Date.now`, never below 0), or
`null` when the video is not completed or the service gives no link. Its
failures are thrown.

### Added: `apps/web`, `isCompletedVideo(read)` and `VideoPlayerSource`

In `apps/web/src/lib/video-progress-view.ts`: whether the page's progress read
is a completed video, and the player's source type.

### Added: `apps/web`, `VideoPlayer`, `LINK_EXPIRY_MARGIN_MS`, `PLAYBACK_FAILED`

A Client Component beside the project page: the browser's player
(`controls`, `playsInline`, `preload="metadata"`, `controlsList="nodownload"`)
for a `VideoPlayerSource`. It measures the link's seconds on the page's own
clock (`performance.now()`) from when the link arrived. When the video fails
within 30 seconds (`LINK_EXPIRY_MARGIN_MS`) of its link running out, or after,
it takes a newer link the page already gave, or calls `router.refresh()` once
for that link, and resumes where it was, playing if it was; a failure while
the new link is awaited asks for no other. It starts no timer. Any other
failure, including one the browser met before the page could listen, shows
`PLAYBACK_FAILED` as an alert the video names (`aria-describedby`). A link the
page gives for another reason is taken at once before the member plays the
video or after it failed, and otherwise waits until the playing one is needed.

### Changed: `apps/web`, `VideoProgressPanel` and `StoryboardView`

Both take `player: VideoPlayerSource | null`; the panel plays it under its
status line.
