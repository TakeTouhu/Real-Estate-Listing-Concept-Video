# API Changes — GS-12c-3

The download on the project page (ADR-0120). **No migration and no
environment variable.** Built wherever the project page is: where nothing can
start a video (ADR-0111), no project has one to download.

## HTTP

### Added: `POST /api/video-projects/{projectId}/download`

Asks for a link that saves the project's delivered video (ADR-0119). A form
post (`application/x-www-form-urlencoded` or `multipart/form-data`) from the
project page's "Download video" button.

| Field | Shape |
| --- | --- |
| `organizationId` | an id: 1 to 64 letters, digits, `_` or `-`; the organization the page was read for |
| `propertyId` | an id; only says which page to send the member back to |

| Response | When |
| --- | --- |
| `403` `FORBIDDEN` (JSON envelope) | the `Origin` is missing or not this host; nothing else is read |
| `303` to `/login` | signed out, or the second sign-in step is not done |
| `422` `VALIDATION_FAILED` (JSON envelope) | the body is not a form, or `organizationId`, `propertyId` or the project id in the path is not an id |
| `303` to the signed link, `Cache-Control: private, no-store` | the member holds `video.download`, the Property is in reach and the video is delivered; the link is audited as `video.download_link_issued`. `GET /api/storage/download?token=…` serves it as an attachment named after the project (ADR-0118), and the browser stays on the page |
| `303` to `/properties/{propertyId}/video-projects/{projectId}?download=none` | the project has no delivered video |
| `303` to the same page with `?download=forbidden` | the member does not hold `video.download`, or the project is not the organization's or its Property is out of reach |
| `303` to the same page with `?download=failed` | any other refusal; trying again is safe |
| `500` | an unexpected failure, not turned into a notice |

A `GET` answers `405`: only `POST` is exported.

### Changed: the project page, `/properties/{propertyId}/video-projects/{projectId}`

- A **"Download video"** form, posting to the route above, under the player
  for a delivered video, for a member holding `video.download`. Showing it
  signs and audits nothing.
- `?download=none|forbidden|failed` shows that code's notice above the
  "Video" panel (ADR-0120 Decision 3); any other value shows nothing.

## Internal API

### Added: `apps/web`, `apps/web/src/lib/video-download.ts`

- `getVideoDownloadService()`: `VideoDownloadService`, built once, with the
  preview's dependencies.
- `requestDownload(downloads, actorUserId, organizationId, videoProjectId)`:
  `{ to: "LINK", url }`, or `{ to: "PAGE", notice }` with `notice` one of
  `none`, `forbidden` (a `FORBIDDEN` or `NOT_FOUND` refusal) and `failed` (any
  other `AppError`); anything else is thrown.
- `downloadOnProjectPage(completed, permissions, organizationId, propertyId,
  videoProjectId)`: the button's `VideoDownloadForm` (`action`,
  `organizationId`, `propertyId`), or `null`.
- `DOWNLOAD_NOTICES` and `downloadNotice(param)`: the notice a `?download=`
  code names, or `null`.

### Added: `apps/web`, `VideoDownloadForm` in `video-progress-view.ts`

A type only, so the panel needs no server code. `VideoProgressPanel` takes
`download: VideoDownloadForm | null`; `StoryboardView` takes `download` and
`downloadNotice: string | null`.
