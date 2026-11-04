# API Changes — GS-12b-1

A link to watch a project's delivered video (ADR-0116). **No migration, no
HTTP change and no environment variable**; nothing outside tests constructs
the new service yet.

## HTTP

Not applicable: no route is added or changed. The link the service gives is
served by `GET /api/storage/download?token=…` as GS-12a left it
(`docs/api-changes-gs-12a.md`), which still checks the token alone.

## Internal API

### Added: `@app/domain`, `VideoPreviewService.link(actorUserId, organizationId, videoProjectId)`

A signed link (`{ url, expiresAt }`) to the project's delivered video, for 300
seconds, or `null` when it has none to watch. Its readers, its refusals and
the video it names are the progress's:

| The project's newest video | The answer |
| --- | --- |
| none started, not delivered yet, or ended without one | `null`; nothing is signed or audited |
| delivered, including while a new version of it is made | a link to the job's current version, at `managedDeliverableOutputKey`; one audit entry |
| delivered, with Units that contradict its delivery | `AppError` `INTERNAL_ERROR`, details `{ jobId }`; nothing signed |
| a member without `video.view` | `AppError` `FORBIDDEN` |
| a project not the organization's, or its Property out of reach | `AppError` `NOT_FOUND` |

A deleted Property's video is still given a link. The link is signed before
the audit entry is appended: a signing failure writes no entry, and an
append failure gives no link.

Deps: `VideoPreviewServiceDeps`, the progress's
(`VideoProgressServiceDeps`) and `storage` (only `createSignedDownloadUrl`).

### Added: `@app/domain`, `readNewestVideo(deps, actorUserId, organizationId, videoProjectId)`

The project's newest video record, or `null`, for a reader of the progress:
the check `VideoProgressService.progress` made, now shared with the link.

### Added: `@app/domain`, `VIDEO_PREVIEW_LINK_TTL_SECONDS`, `VideoAuditAction`, `VIDEO_AUDIT_RESOURCE_TYPE`

`300`; `{ PreviewLinkIssued: "video.preview_link_issued" }`; and
`"generation_deliverable_version"`, the audit entry's resource type. The
entry's resource id is the version's id and its metadata `{ jobId }`.

### Changed: `@app/domain`, `VideoProgressRecord`

`delivered: boolean` is replaced by `deliveredVersionId: string | null`, the
job's `currentDeliverableVersionId`. `VideoProgress`, what the page shows, is
unchanged.
