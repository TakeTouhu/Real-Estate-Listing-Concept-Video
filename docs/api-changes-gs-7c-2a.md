# API Changes — GS-7c-2a

Finding an orchestrated attempt to send, and ending one whose preparation is
refused for good (ADR-0097). **No migration; no route and no page.** Nothing
outside tests constructs the repository.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | What it is |
| --- | --- |
| `preparationRefusalEnding(reason)` | `CANCELLED_PRE_SUBMISSION` for a reason whose canonical disposition is `TERMINAL`, `null` for a `RETRYABLE` one |
| `PreparationRefusalEndState` | `"CANCELLED_PRE_SUBMISSION"`, the one state a refused orchestrated attempt ends in |
| `ATTEMPT_PREPARATION_REFUSED_EVENT_TYPE` (`attempt.preparation_refused`) | the event type the ending writes on the attempt, fixed in the repository |
| `MAX_ATTEMPT_SUBMISSION_BATCH_SIZE` (100), `validateAttemptSubmissionBatchLimit` | discovery's bound, refused rather than clamped outside 1 to 100 |
| `AttemptSubmissionRepository` | `findSubmissionCandidates({ limit })` and `endPreparationRefusal(input)` |
| `AttemptSubmissionCandidateQuery`, `EndPreparationRefusalInput`, `EndPreparationRefusalOutcome` | their input and outcome types; the outcome is `ENDED` with the attempt's new `stateVersion`, or `NOT_QUEUED` |

### Added: `@app/database`

| Export | What it is |
| --- | --- |
| `createAttemptSubmissionRepository(prisma)` | discovery of orchestrated `QUEUED` attempts before submission under a `GENERATING` request and job and a standing Property, oldest first, each with its project's organization; the ending, behind the cost-admission lock, as one compare-and-set on the attempt in the caller's organization and one transition event |

### Changed

None.
