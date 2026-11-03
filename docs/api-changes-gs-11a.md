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
`NOT_FOUND`, before its video is read. A video that ended without one but used
its Units is `INTERNAL_ERROR`.

### Added: `@app/domain`, `VideoProgress`

| Field | Meaning |
| --- | --- |
| `phase` | `QUEUED`, `GENERATING_SCENES`, `COMPOSING`, `VALIDATING`, `COMPLETED`, `REVISING`, `FAILED` or `CANCELLED` (ADR-0113 Decision 3) |
| `qualityTier` | `NORMAL` or `HIGH_QUALITY` |
| `durationSeconds` | the video's length, frozen when it started |
| `units` | `count`, the Units it needs; `state`, `RESERVED`, `CONSUMED`, `RELEASED` or `NONE` (Decision 4) |
| `scenes` | `total`, and how many are `ready` |
| `supportReference` | the video's own id, for the customer to quote to support (Decision 6) |

Also exported: `videoProgressOf`, `videoProgressPhaseOf`,
`videoProgressUnitsOf`, `VideoProgressRecord`, `VideoProgressRepository` and
`VideoProgressServiceDeps`.

### Added: `@app/database`, `createVideoProgressRepository(prisma)`

`findLatest(organizationId, videoProjectId)`: the project's newest job, its
reservation's state and its scenes' counts, in one statement. A project of
another organization reads as one with no video. An empty organization or
project id is `VALIDATION_FAILED`.
