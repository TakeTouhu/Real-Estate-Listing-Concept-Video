# API Changes — GS-7d-1

Ending a waiting job that can never launch, and releasing its Units
(ADR-0099). **No migration; no route and no page.** Nothing outside tests
constructs the ending repository or the launch runner.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | What it is |
| --- | --- |
| `decideUnlaunchableJobEnding(locked)` | from the rows the ending locked: `END` with a cause, or `KEEP` with a refusal; the job's state, its reservation and its attempts are checked before any cause |
| `UnlaunchableJobCause` | `PROPERTY_DELETED`, `TARGET_RESOLUTION_UNKNOWN`, `NO_SCENES`, `SCENE_PROMPT_MISSING`, `SCENE_PROMPT_UNRENDERABLE`, `SHAPE_CONFLICT` |
| `UnlaunchableJobEndingRefusal` | `NOT_WAITING`, `RESERVATION_NOT_HELD`, `ATTEMPT_ADMITTED`, `LAUNCHABLE` |
| `UnlaunchableJobEnding` | the decision's answer |
| `JOB_ENDED_UNLAUNCHABLE_EVENT_TYPE` (`job.ended_unlaunchable`) | the event of the job's `RESERVED → FAILED_TERMINAL` |
| `UnlaunchableJobEndingRepository` | `findPropertyDeletedWaitingJobs({ limit })` and `endUnlaunchableJob(input)` |
| `EndUnlaunchableJobInput` | `{ organizationId, generationJobId, endedAt, context }` |
| `EndUnlaunchableJobOutcome` | `ENDED` with its cause, or `NOT_ENDED` with the refusal |
| `PropertyDeletedWaitingJob` | `{ organizationId, generationJobId }` |
| `FrozenFactsCode` | the planner's codes for a job's own frozen facts |

### Added: `@app/database`

| Export | What it is |
| --- | --- |
| `createUnlaunchableJobEndingRepository(prisma)` | the deleted-Property query and the ending commit, behind the cost-admission lock |

### Changed

| Export | Change |
| --- | --- |
| `JobLaunchRunner` (`@app/domain`) | takes `ending` and `clock`; ends a deleted Property's waiting jobs, then launches, ending a candidate that can never launch |
| `JobLaunchRunnerDeps` | now requires `ending: UnlaunchableJobEndingRepository` and `clock: () => number` |
| `JobLaunchReport` | gains `ended` |
| `JobLaunchRunOutcome` | gains `ENDED` (with its cause) and `NOT_ENDED` (with the refusal) |
| `JobLaunchDefectCode` | gains `ENDING_LOST_UNDER_LOCK` |
