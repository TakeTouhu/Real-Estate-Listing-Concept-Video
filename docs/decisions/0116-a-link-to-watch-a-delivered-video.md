# ADR-0116 — A link to watch a project's delivered video

Status: Accepted (GS-12b-1, 2026-11-04). The second milestone of row GS-12 of
the generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`: "the finished video
plays in the private workspace. Preview needs `video.view`. Download needs
`video.download`, is audited, and uses a short-lived signed link"). Builds on
ADR-0113 (a project's video progress) and ADR-0115 (serving a stored video).

## Context

The signed download route can now serve a customer's video a byte range at a
time, as `video/mp4` (ADR-0115), but nothing signs a video's key: the progress
read (ADR-0113) says whether a project's video was delivered and not which
version. The job points at its delivered version
(`currentDeliverableVersionId`), and only Transaction G sets that pointer, in
the commit that publishes a version proved technically valid and consumes its
Units (ADR-0080). The version's video is stored at
`managedDeliverableOutputKey` (`org/{organizationId}/deliverables/{versionId}/output`).

ADR-0052 makes a delivered video previewable with `video.view` and
downloadable with `video.download` (Decisions 10 and 17), keeps preview and
download available for a Property in trash when authorized (Decision 17), and
leaves share links for after the initial release (Decision 12). Photos are
watched the same way already: a reader is given a signed link that lives 300
seconds, and each link is audited when it is given
(`PropertyAssetService.createDownloadUrl`).

GS-12b is split into two milestones, each its own pull request:

- **GS-12b-1** (this ADR, no migration): the link, as a domain service nothing
  outside tests constructs yet.
- **GS-12b-2** (ADR-0117): a player on the project page that plays it, and
  renews a link that has run out.

## Decision 1 — The link: `VideoPreviewService.link`

`link(member, organization, project)` answers a signed link to the project's
delivered video, or `null` when it has none to watch.

1. **Its readers are the progress's** (ADR-0113 Decision 1): `video.view`, or
   `FORBIDDEN`; then the project is the organization's and its Property is in
   the member's reach (ADR-0064), or `NOT_FOUND`, before anything about its
   video is read. Both read it through one function, `readNewestVideo`, so the
   two cannot drift apart.
2. **The video is the one its progress shows as completed.** The progress
   record now carries the delivered version itself (`deliveredVersionId`)
   rather than only whether there is one, and a link is given only when its
   phase is `COMPLETED`: a delivered video, including while a new version of
   it is made (ADR-0113 Decision 3). No video, one not delivered yet, and one
   that ended without one have nothing to watch: `null`, and nothing is signed
   or audited.
3. **The version is the job's current one.** Only Transaction G sets it, so
   the link names a version proved technically valid and published, never a
   new version still being made.
4. **A video whose Units contradict ADR-0052 is refused as its progress is**
   (ADR-0113 Decision 4): `INTERNAL_ERROR` with its id, and no link.
5. **A deleted Property's video is still given a link**, as its progress is
   read: ADR-0052 keeps preview available for a Property in trash when
   authorized. Nothing new can be made of it (ADR-0088).

It writes nothing but its audit entry.

## Decision 2 — A link lives 300 seconds

As long as a photo's. A link is a bearer token for one key (ADR-0115), so its
life bounds how long anyone holding it can play the video; a player keeps
asking for ranges while it plays and seeks, so a link may run out while the
video is open. The page renews it (GS-12b-2, ADR-0117) rather than signing it
for longer.

## Decision 3 — Each link is audited when it is given

`video.preview_link_issued`, by the member, on resource type
`generation_deliverable_version` and the version's id, with the job's id in
its metadata. The link is signed first and the entry appended after: a link
that could not be signed is not audited, and one whose entry could not be
appended is not handed out. As for photos, the entry records the link given,
not each range the player reads with it.

## Decision 4 — The token stays the route's only check

The signed download route checks the token alone, as it does for photos
(ADR-0115 Decision 6 left this to the preview). The member's session,
permission, reach and the audit are all checked when the link is given; the
token then names one key, for download only, for 300 seconds, and cannot be
made into another. Checking the session again on every range a player asks
for would add a session and membership read to each one for no key the token
does not already fix, and would make the route answer photos and videos
differently.

This is not a share link (ADR-0052 Decision 12): it is given only to a signed
in reader, is audited, lives five minutes, and the page never offers it as a
link to copy.

## Decision 5 — What stays out

- **The player and the page** (GS-12b-2, ADR-0117). Nothing outside tests
  constructs `VideoPreviewService`, so no customer is given a link yet.
- **The download** (GS-12c): `video.download`, audited, served as an
  attachment.
- **The disclosure mode, the version and its date beside the video, and old
  versions during their 30 days** (ADR-0052 Decision 17). Only the current
  version can be delivered today; nothing a customer reaches makes another.
- **A delivered video whose job ended afterwards.** Only a new version can end
  a delivered video's job, and nothing a customer reaches starts one; its
  progress does not show it completed, so it is given no link. What the
  customer sees then is decided with regeneration (`docs/decisions/TODO.md`).
- **A limit on how often a link is asked for**, beyond the page's: each one is
  audited.
- **No migration**, no new table, column, route, permission or environment
  variable.

## Consequences

- A project's delivered video can be given to its readers as a link the
  signed route plays and seeks, once the page asks for one.
- The progress record names the delivered version; the progress read and the
  page are otherwise unchanged.
- Every link to a video is in the audit log, by member and version.
