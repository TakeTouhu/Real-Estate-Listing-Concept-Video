# API Changes — GS-12c-2

A link to download a project's delivered video (ADR-0119). **No migration, no
HTTP change and no environment variable**; nothing outside tests constructs
the new service yet.

## HTTP

Not applicable: no route is added or changed. The link the service gives is
served by `GET /api/storage/download?token=…` as an attachment under the name
it carries (ADR-0118, `docs/api-changes-gs-12c-1.md`).

## Internal API

### Added: `@app/domain`, `VideoDownloadService.link(actorUserId, organizationId, videoProjectId)`

A signed link (`{ url, expiresAt }`) that saves the project's delivered video,
for 300 seconds, or `null` when it has none:

| The project's newest video | The answer |
| --- | --- |
| none started, not delivered yet, or ended without one | `null`; nothing is signed or audited |
| shown as delivered by its state, with no version set | `null`; nothing is signed or audited |
| delivered, including while a new version of it is made | a link to the job's current version, at `managedDeliverableOutputKey`, named `videoDownloadFilename(project.name)`; one audit entry |
| delivered or not, with Units that contradict it (ADR-0113 Decision 4) | `AppError` `INTERNAL_ERROR`, details `{ jobId }`; nothing signed |
| a member without `video.download`, `video.view` or not | `AppError` `FORBIDDEN` |
| a project not the organization's, or its Property out of reach | `AppError` `NOT_FOUND` |

A deleted Property's video is still given a link. The link is signed before
the audit entry is appended: a signing failure writes no entry, and an append
failure gives no link. Deps: `VideoDownloadServiceDeps`, the preview's.

### Added: `@app/domain`, `videoDownloadFilename(projectName)`, `VIDEO_DOWNLOAD_LINK_TTL_SECONDS`

The name a project's video is saved under (ADR-0119 Decision 1), always one a
link may carry; and `300`.

### Added: `@app/domain`, `VideoAuditAction.DownloadLinkIssued`

`"video.download_link_issued"`, on `VIDEO_AUDIT_RESOURCE_TYPE`
(`"generation_deliverable_version"`), resource id the version's id, metadata
`{ jobId }`.

### Added: `@app/domain`, `readProjectVideo(deps, actorUserId, organizationId, videoProjectId, permission)`, `completedVersionOf(record)`

The project and its newest video record for a member holding `permission`
(`"video.view"` or `"video.download"`), with the refusals `readNewestVideo`
made; `readNewestVideo` is now `readProjectVideo` with `"video.view"`. And the
delivered version a link names, or `null`, shared by the preview and the
download.
