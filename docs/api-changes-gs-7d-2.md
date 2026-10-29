# API Changes — GS-7d-2

Ending a generating job's attempt whose Property was deleted, so its Unit is
released (ADR-0100). **No migration; no route and no page.** Nothing outside
tests constructs the attempt submission repository or the sender.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | What it is |
| --- | --- |
| `PROPERTY_DELETED_ATTEMPT_CODE` (`PROPERTY_DELETED`) | the durable code an ended attempt carries: the gate's own reason for refusing it |
| `ATTEMPT_ENDED_PROPERTY_DELETED_EVENT_TYPE` (`attempt.ended_property_deleted`) | the event of the attempt's `QUEUED → CANCELLED_PRE_SUBMISSION` |
| `AttemptEndingReason` | why an attempt ended before submission: a `PreflightRefusalReason`, or `PROPERTY_DELETED` |
| `PropertyDeletedAttempt` | `{ organizationId, generationJobId, attemptId }` |
| `PropertyDeletedAttemptQuery` | `{ limit }`, validated as the window's limit is |
| `EndPropertyDeletedAttemptInput` | `{ organizationId, attemptId, context }` |
| `EndPropertyDeletedAttemptOutcome` | `ENDED` with the attempt's id and version, `NOT_QUEUED`, or `PROPERTY_NOT_DELETED` |

### Changed

| Export | Change |
| --- | --- |
| `AttemptSubmissionRepository` (`@app/domain`) | gains `findPropertyDeletedAttempts(query)`: one attempt of each generating job of a deleted Property, the job's oldest, oldest first; and `endPropertyDeletedAttempt(input)`: the ending, behind the cost-admission lock with the Property held `FOR SHARE` |
| `createAttemptSubmissionRepository(prisma)` (`@app/database`) | implements the two methods; its two endings share one compare-and-set |
| `AttemptSubmissionRunner.runOnce` (`@app/domain`) | first ends up to `limit` deleted Properties' attempts, then sends the window as before; a gate refusal of `SOURCE_INVALID` with `PROPERTY_DELETED` is handed to the same ending |
| `AttemptSubmissionRunOutcome` | `ENDED` and `MOVED` carry an `AttemptEndingReason`; `NOT_SENT` gains `PROPERTY_NOT_DELETED` |
| `AttemptSubmissionReport` | `ended` counts both steps; `next` still describes the window only |
