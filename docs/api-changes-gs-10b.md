# API Changes — GS-10b

One video of a project at a time (ADR-0110). **No migration; no route, no page
and no environment variable.** Nothing outside tests constructs the start
service or its repository until GS-10c's route.

## HTTP

No change.

## Internal API

### Added: `@app/domain`, `holdsItsProject` and `JOB_STATES_ENDED_WITHOUT_A_VIDEO`

```ts
holdsItsProject(jobState: GenerationJobState, reservationState: GenerationReservationState | null): boolean
```

Whether a job keeps its project from being started again: always, unless the
job is `FAILED_TERMINAL` or `CANCELLED` (`JOB_STATES_ENDED_WITHOUT_A_VIDEO`)
and its reservation is `RELEASED` or absent.

### Changed: `@app/domain`, `GenerationStartRepository`

Adds `findHolding(organizationId, videoProjectId): Promise<GenerationJob | null>`,
the newest job that holds the project, read scoped to the organization. The
database repository refuses a missing organization or project id
(`VALIDATION_FAILED`).

`start` may return `{ kind: "VIDEO_EXISTS", job }`: another job holds the
project. Nothing is written. A replay of that job's key is still `EXISTING`.

### Changed: `@app/domain`, `StartGenerationOutcome`

Adds `{ kind: "VIDEO_EXISTS", job }`, from the service's own read before the
Unit period is opened or from the commit's read under its lock.

### Changed: `@app/domain`, `StartOffer`

Adds `{ kind: "VIDEO_EXISTS", jobId, delivered }`, answered right after the
permissions and reach, before `NOT_COMPOSED`. `delivered` is whether the job
has delivered a video.

| Kind | Fields | Meaning |
| --- | --- | --- |
| `VIDEO_EXISTS` | `jobId`, `delivered` | the project's video is in progress, delivered, or failed with its Units not yet back; a start would not happen |

### Changed: the start commit's locks

The commit's first statement is now the project-start lock, a transaction
advisory lock on the organization and project, before the reservation-admission
and cost-admission locks. It is private to `@app/database`.
