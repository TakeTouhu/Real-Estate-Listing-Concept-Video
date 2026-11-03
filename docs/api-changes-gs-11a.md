# API Changes — GS-11a

A project's video, as its customer sees it (ADR-0113). **No migration; no
route, no page and no environment variable.** Nothing outside tests
constructs the read until GS-11b's project page.

## HTTP

No change.

## Internal API

### Added: `@app/domain`, `VideoProgressService.progress`

```ts
progress(actorUserId: string, organizationId: string, videoProjectId: string): Promise<VideoProgress | null>
```

The project's newest video, or `null` when none was started. Reads only.
Needs `video.view` (`FORBIDDEN` otherwise, before anything is read); a project
of another organization, or whose Property is out of the member's reach, is
`NOT_FOUND`, before its video is read. A video whose Units contradict whether
it was delivered (one that ended without a video but used them, or a
completed one whose Units are still held or came back) is `INTERNAL_ERROR`,
with the job's id in its details and the message "This video's progress could
not be read", which claims nothing about it.

### Added: `@app/domain`, `VideoProgress`

| Field | Meaning |
| --- | --- |
| `phase` | `QUEUED`, `GENERATING_SCENES`, `COMPOSING`, `VALIDATING`, `COMPLETED`, `FAILED` or `CANCELLED` (ADR-0113 Decision 3); a delivered video is `COMPLETED` while a new version of it is made |
| `qualityTier` | `NORMAL` or `HIGH_QUALITY` |
| `durationSeconds` | the video's length, frozen when it started |
| `units` | `count`, the Units it needs; `state`, `RESERVED`, `CONSUMED`, `RELEASED` or `NONE` (Decision 4); a video still in progress can read `RELEASED` |
| `scenes` | `total`, and how many are `ready` (a scene made again is not counted) |
| `supportReference` | the video's own id, for the customer to quote to support (Decision 6) |

Also exported: `videoProgressOf`, `videoProgressPhaseOf`,
`videoProgressUnitsOf`, `VideoProgressRecord`, `VideoProgressRepository` and
`VideoProgressServiceDeps`.

### Added: `@app/database`, `createVideoProgressRepository(prisma)`

`findLatest(organizationId, videoProjectId)`: the project's newest job,
whether it has delivered a video (`delivered`), its reservation's state and
its scenes' counts, in one statement. A project of
another organization reads as one with no video. An empty organization or
project id is `VALIDATION_FAILED`.
