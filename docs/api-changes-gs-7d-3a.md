# API Changes — GS-7d-3a

Ending a deleted Property's launched job before its video is assembled, so its
Unit is released (ADR-0102). **No migration; no route and no page.** Nothing
outside tests constructs the ending's repository or the launch runner.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | What it is |
| --- | --- |
| `decideLaunchedJobEnding(locked)` | the decision, from the rows the ending locked: `END` from the job's state, or `KEEP` with a refusal |
| `JOB_STATES_BEFORE_ASSEMBLY` | `GENERATING`, `SCENES_READY`, `COMPOSITION_PENDING`, frozen; `JobStateBeforeAssembly` is one of them |
| `LaunchedJobLockedRows` | `{ jobState, jobHoldsDeliverable, reservationState, propertyDeleted }`, read under the ending's locks |
| `LaunchedJobEnding` | `{ kind: "END", from }` or `{ kind: "KEEP", reason }` |
| `LaunchedJobEndingRefusal` | `NOT_BEFORE_ASSEMBLY`, `HOLDS_DELIVERABLE`, `RESERVATION_NOT_HELD`, `PROPERTY_STANDS` |
| `JOB_ENDED_PROPERTY_DELETED_EVENT_TYPE` (`job.ended_property_deleted`) | the event of the job's move to `FAILED_TERMINAL` |
| `LaunchedJobEndingRepository` | `findPropertyDeletedLaunchedJobs(query)`: such jobs oldest first, bounded and validated as the launch's limit is; `endPropertyDeletedLaunchedJob(input)`: the ending, one commit behind the cost-admission lock |
| `PropertyDeletedLaunchedJob` | `{ organizationId, generationJobId }` |
| `EndLaunchedJobInput` | the waiting job's ending's input: `{ organizationId, generationJobId, endedAt, context }` |
| `EndLaunchedJobOutcome` | `ENDED` with `PROPERTY_DELETED`, or `NOT_ENDED` with a `LaunchedJobEndingRefusal` |

### Added: `@app/database`

| Export | What it is |
| --- | --- |
| `createLaunchedJobEndingRepository(prisma)` | implements `LaunchedJobEndingRepository` |

### Changed

| Export | Change |
| --- | --- |
| `JobLaunchRunnerDeps` (`@app/domain`) | gains `launchedEnding: LaunchedJobEndingRepository` |
| `JobLaunchRunner.runOnce` (`@app/domain`) | between the waiting jobs' endings and the launches, ends up to `limit` deleted Properties' launched jobs; a read of them that throws rejects the pass |
| `JobLaunchRunOutcome` (`@app/domain`) | `NOT_ENDED` carries either ending's refusal |
| `JobLaunchReport` (`@app/domain`) | `ended` counts both endings |
