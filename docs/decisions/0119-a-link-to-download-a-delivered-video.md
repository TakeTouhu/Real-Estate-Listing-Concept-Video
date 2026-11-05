# ADR-0119 — A link to download a project's delivered video

Status: Accepted (GS-12c-2, 2026-11-05). The second milestone of GS-12c, the last
row of GS-12 in the generation-to-preview plan the product owner approved on
2026-10-26 (`/mnt/project-files/cto/generation-e2e-proposal.md`: "Download
needs `video.download`, is audited, and uses a short-lived signed link").
Builds on ADR-0116 (a link to watch a delivered video) and ADR-0118 (a download
link that names the file it saves).

## Context

A signed link can now name the file it saves, and the signed download route
serves such a link as an attachment under that name (ADR-0118); nothing signs
one yet. ADR-0052 makes downloading a delivered video its own permission
("Only users with `video.download` may download", Decision 10) and keeps it
available for a Property in trash when authorized (Decision 17); CLAUDE.md
requires downloads to be audited. A link to watch the video is given to a
reader of its progress, for the job's current version, for 300 seconds, and
audited as `video.preview_link_issued` (ADR-0116).

## Decision 1 — A video is saved under its project's name

`videoDownloadFilename(project.name)` names the file: the project's name as its
members wrote it, composed (Unicode NFC), with each run of white space as
JavaScript's `\s` reads it (spaces, tabs, line breaks, and the byte-order mark
too) as one space, each other character a name may not hold (ADR-0118
Decision 1) as `_`, white space and dots at either end dropped, cut between
whole characters as a reader sees them (grapheme clusters, so the cut never
splits a flag or an emoji sequence) to fit with `.mp4` in 240 bytes, and
`.mp4` added. A name that leaves nothing is `video.mp4`. Every name it makes is
one a link may carry. Apart from composing it, the work is one pass over the
name, which the one route that names a project bounds at 2,000 characters.

Two consequences of those rules are kept:

- **A character bigger than the room left is not cut inside**: the name ends
  before it, and is `video.mp4` when it is the first. Only a letter carrying
  hundreds of marks, or a cluster as long, is that big.
- **A subdivision flag (England's, Scotland's, Wales's) loses its tags**: they
  are invisible format characters, which ADR-0118 refuses, so each becomes `_`.

The project's name is what the customer chose to call this video, and what
the project page shows above it. Nothing else is added to it: no date, quality
or version. Every delivered video is MP4 (ADR-0115 serves it as `video/mp4`).
The name is not written to the audit entry: the version's id names the video,
and the project's name is the customer's content.

## Decision 2 — The link: `VideoDownloadService.link`

`link(member, organization, project)` answers a signed link that saves the
project's delivered video, or `null` when it has none.

1. **`video.download`, or `FORBIDDEN`.** Watching is not downloading: a member
   holding `video.view` alone is refused, and one holding `video.download` is
   given a link without `video.view`; the preview, in turn, refuses a member
   holding `video.download` alone. Every role holds both or neither (ADR-0052
   Decision 10); only an individual or group grant separates them.
2. **The project is the organization's and its Property in the member's
   reach, or `NOT_FOUND`**, answered alike and before anything about its video
   is read. The progress, the preview and the download read the project and
   its newest video through one function, `readProjectVideo`, which takes the
   permission, so the three cannot drift apart.
3. **The video is the one a link to watch it names** (ADR-0116 Decision 1),
   through one function, `completedVersionOf`: the job's current version while
   its progress shows it completed, including while a new version is made;
   `null`, with nothing signed or audited, for no video, one not delivered yet
   and one that ended without one; and `INTERNAL_ERROR` for a video whose Units
   contradict ADR-0052, before its version is looked at.
4. **A deleted Property's video is still given a link**: ADR-0052 keeps
   download available for a Property in trash when authorized.
5. **A link lives 300 seconds** (`VIDEO_DOWNLOAD_LINK_TTL_SECONDS`), as a
   photo's and a preview's. A download starts at once from its link; a browser
   that retries a broken download after its link ran out is refused, and the
   member asks for a new one.
6. **Each link is audited when it is given**: `video.download_link_issued`, by
   the member, on resource type `generation_deliverable_version` and the
   version's id, with the job's id in its metadata, apart from the links to
   watch it. The link is signed first and the entry appended after: a link
   that could not be signed is not audited, and one whose entry could not be
   appended is not handed out. As for a photo (`asset.download_url_issued`),
   the entry records the link given, not each range read or whether the file
   was saved.

It writes nothing but its audit entry; a download uses no Unit.

## Decision 3 — What stays out

- **The download on the project page** (GS-12c-3). Nothing outside tests
  constructs `VideoDownloadService`, so no customer is given a download link
  yet, and no token names a file.
- **A limit on how often a link is asked for**, beyond the page's: each one is
  audited.
- **Old versions during their 30 days, and the version, date and disclosure
  mode beside them** (ADR-0052 Decision 17), as for the preview: only the
  current version can be delivered today.
- **Share links** (ADR-0052 Decision 12).
- **No migration**, no new table, column, route, permission or environment
  variable. The audit action is a value in the audit log's text column.

## Consequences

- A member holding `video.download` can be given a link that saves the
  project's delivered video as its project's name with `.mp4`, once the page
  asks for one.
- Every download link is in the audit log, by member and version, apart from
  the links to watch the video.
