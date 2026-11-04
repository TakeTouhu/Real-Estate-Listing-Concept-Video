# API Changes — GS-12b-2

The delivered video on the project page (ADR-0117). **No migration, no new
route and no environment variable.**

## HTTP

### Changed: `GET /properties/{propertyId}/video-projects/{projectId}` (page)

When the project's video is completed, the page asks
`VideoPreviewService.link` for a link as the member (ADR-0116) and its "Video"
panel plays it: one `video.preview_link_issued` audit entry per such page
load. For any other video the page asks for nothing. The link is played from
`GET /api/storage/download?token=…`, unchanged (`docs/api-changes-gs-12a.md`).

## Internal API

### Added: `apps/web`, `getVideoPreviewService()` and `readVideoPreview(preview, completed, actorUserId, organizationId, videoProjectId)`

In `apps/web/src/lib/video-preview.ts`, server-only: the link service built
over the database and the web app's object storage, and what the player
plays (`{ src, expiresAt }`, the instant as ISO 8601), or `null` when the video
is not completed or the service gives no link. Its failures are thrown.

### Added: `apps/web`, `isCompletedVideo(read)` and `VideoPlayerSource`

In `apps/web/src/lib/video-progress-view.ts`: whether the page's progress read
is a completed video, and the player's source type.

### Added: `apps/web`, `VideoPlayer`, `LINK_EXPIRY_MARGIN_MS`, `PLAYBACK_FAILED`

A Client Component beside the project page: the browser's player
(`controls`, `playsInline`, `preload="metadata"`, `controlsList="nodownload"`)
for a `VideoPlayerSource`. When the video fails within 30 seconds of its link
running out, or after, it calls `router.refresh()` once per link and resumes
where it was; otherwise it shows `PLAYBACK_FAILED` as an alert.

### Changed: `apps/web`, `VideoProgressPanel` and `StoryboardView`

Both take `player: VideoPlayerSource | null`; the panel plays it under its
status line.
