# ADR-0113 — A project's video, as its customer sees it

Status: Accepted (GS-11a, 2026-11-03). The first of two milestones of row
GS-11 of the generation-to-preview plan the product owner approved on
2026-10-26 (`/mnt/project-files/cto/generation-e2e-proposal.md`: "the project
page shows progress in plain states: waiting, generating scenes, composing,
checking, done or failed. It never names a provider or model"). Builds on
ADR-0110 (one video of a project at a time) and ADR-0112 (the start page).

## Context

In development a customer can start a project's video (ADR-0111, ADR-0112),
and the pipeline command takes it to a delivered video or to a failure whose
Units come back. Nothing shows the customer where the video is. The start
service can say only whether a job holds the project, and only to a member who
may start videos.

UXFlow ("Generation progress") names the states a customer sees: queued,
analyzing, generating scenes, composing, validating, completed, failed,
cancelled; never a provider prediction id, a model name or a temporary URL.
Its "Error recovery" asks every failure screen for a reason the customer
understands, whether the Unit was consumed or released, whether the video can
be started again, and a support reference id, with no control that retries the
failed video. ADR-0052 (Decisions 5 and 19) fixes the message for every
failure that delivers no video, whatever its class: 「動画を正常に生成できませんでした。今回の生成ではUnitは消費されていません。」

No support reference exists anywhere in the product yet.

## Decision 1 — The read: `VideoProgressService.progress`

`progress(member, organization, project)` answers the project's newest video,
or `null` when none was started. Its readers are the storyboard's:

1. **`video.view`**, or `FORBIDDEN`, before anything else is read.
2. **The project is the organization's and its Property is in the member's
   reach** (ADR-0064), or `NOT_FOUND`, answered alike and before anything about
   its video is read.

It writes nothing. A deleted Property's project is read, as its storyboard
is: a video of it in progress when the Property was deleted ends without one
and its Units come back (ADR-0099 to ADR-0103), and no new one can be started
for it (ADR-0088).

## Decision 2 — Which video: the project's newest

The newest job of the project, by when it started and then by id, as the start
orders them (ADR-0110). With one video of a project at a time, that is the one
in progress, the delivered one, or the last that ended without a video.

The start's own check (`findHolding`) reads the newest job that *holds* the
project instead. The two differ only where an older job still holds it behind
a newer one, which ADR-0110's lock rules out for every job started since; only
data from before it, or from the single-scene path nothing in production
builds, could show it.

## Decision 3 — The phases, in UXFlow's words

| Job state | Phase |
| --- | --- |
| `CREATED`, `RESERVING`, `RESERVED` | `QUEUED` |
| `GENERATING` | `GENERATING_SCENES` |
| `SCENES_READY`, `COMPOSITION_PENDING`, `COMPOSING` | `COMPOSING` |
| `DELIVERABLE_VALIDATING` | `VALIDATING` |
| `DELIVERABLE_READY`, `REVISING` | `COMPLETED` |
| `FAILED_TERMINAL` | `FAILED` |
| `CANCELLED` | `CANCELLED` |
| any other, with a delivered video | `COMPLETED` |

- **No video passes through "analyzing"**: the photos are analyzed before the
  storyboard is composed, and a video starts from a composed storyboard.
- **A delivered video stays completed while a new version of it is made.** A
  revision moves the job from `DELIVERABLE_READY` back through `GENERATING` to
  validating, keeping its delivered version current
  (`currentDeliverableVersionId`, ADR-0110 Decision 4); `REVISING` itself is
  never committed. A failed new version leaves the delivered one current and
  its Units are not charged again (ADR-0052 Decision 19). So the read takes
  whether the job has delivered a video with its state, and a job that has
  is `COMPLETED` until it ends. Shown by its state alone, a delivered video
  would read as generating again with its Units used. How a new version's own
  progress is shown is decided with regeneration, which nothing a customer can
  reach starts yet (`docs/decisions/TODO.md`). No phase is added to UXFlow's.
- **No phase names a provider, a model, an attempt, a retry or why a video
  failed.** The failure class (`BLOCKED`, `INVALID_MEDIA`, `INTEGRITY_MISMATCH`
  and the rest) is never read, so it cannot be shown.

## Decision 4 — The Units

| Reservation state | Units |
| --- | --- |
| `RESERVING`, `RESERVED`, `RECONCILIATION_HOLD` | `RESERVED`: neither used nor back yet |
| `CONSUMED` | `CONSUMED` |
| `RELEASED` | `RELEASED` |
| none | `NONE`: the video never reserved any |

With the count the video needs, frozen when it started.

**A video still in progress can read `RELEASED`.** Reconciliation that gives
up on a submission releases its Units without touching the job, and the job
ends without a video afterwards (ADR-0037 Decision 6). Until it does, the read
says what is true: the video is still in its phase, and its Units are back.

**Two shapes contradict ADR-0052 and are not described**:

- a video that ended without one (`FAILED`, `CANCELLED`) whose Units were
  used, when the customer is told a failed video used no Unit (Decision 19);
- a completed video whose Units are still held or came back, when a delivered
  video uses them.

Either answers `INTERNAL_ERROR` with the job's id in its details and a
message that claims nothing about the video or its Units ("This video's
progress could not be read"), so a route that shows the message tells the
customer nothing false. A completed video with no reservation (`NONE`) is
described as it is.

## Decision 5 — The scenes

How many scenes the video has, and how many are made (`READY`). A scene being
made again for a new version (`REVISING`) is not counted; the count is a video
in progress's, and a completed video's is not shown as progress.

## Decision 6 — The support reference is the video's own id

UXFlow asks for a support reference id. The read gives the job's id: it is
VTaVision's own, unique, names nothing outside VTaVision (no provider, model or
storage key), and support will be able to find the video by it: SaaSOperations
("Support tooling") already plans a search by job id, which does not exist yet.
Reading it already needs
`video.view` and reach, so it tells nobody anything they could not already
see. Where it is shown is the page's decision (GS-11b).

## Decision 7 — One snapshot

The job, its reservation and its scenes are read in one statement, so the
three are of one moment. Where a job's end and its Units coming back commit
together, the read never sees one without the other: a failed or cancelled
video never reads as holding Units that are in fact back. The reverse can be
seen and is true for a while (Decision 4): Units given back by reconciliation
before the job ends.

## Decision 8 — What stays out

- **The project page** shows it in GS-11b, with ADR-0052's message for a video
  that ended without one.
- **A time estimate.** None is shown until provider times are measured (the
  plan's default 3).
- **Email notification.** The progress on the page is the notification for now
  (the plan's default 4).
- **Per-scene detail, preview and download** (GS-12).
- **No migration**, no new table, column, route or environment variable.

## Consequences

- The project page can show a started video's phase, its Units and its scenes,
  and a reference to quote to support, to every member who can read the
  storyboard.
- A failure's class stays internal: no reader of this service can tell a
  blocked video from an invalid one.
