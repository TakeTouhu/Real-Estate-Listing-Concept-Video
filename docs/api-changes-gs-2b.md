# API Changes — GS-2b

A failed job's other scenes close (ADR-0084). **No migration. No route, page,
command or environment variable is added**, and nothing in production constructs
or calls what was added.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | Shape |
| --- | --- |
| `decideFailedJobSceneClosure(facts)` | `{ kind: "CLOSE", sceneTo: "CANCELLED" \| "FAILED_TERMINAL", request: "NONE" \| "CANCEL" \| "FAIL", attemptsToCancel }`, or `{ kind: "NOT_CLOSABLE", reason }` |
| `FailedJobSceneFacts`, `FailedJobSceneRequestFacts` | the job's and scene's states, whether the scene's pointer names a request; each request's kind, state, delivery and every attempt's state |
| `FailedJobSceneRefusal` | `JOB_NOT_FAILED`, `SCENE_NOT_OPEN`, `ATTEMPT_IN_FLIGHT`, `SHAPE_CONFLICT` |
| `FailedJobSceneClosureRepository` | `findFailedJobSceneCandidates({ limit })` → identifiers only; `closeFailedJobScene({ organizationId, generationSceneId, closedAt, context })` → `CLOSED` (the scene's new state and how many attempts were cancelled), `NOT_CLOSABLE` with its reason, or `NOT_FOUND` |
| `FailedJobSceneClosureRunner` | `runOnce(limit)`: one bounded pass, each candidate closed with its own instant and context; a candidate whose closure throws is reported `FAILED` (with its defect code, or `null`) and the pass goes on; reports `closed`, `attemptsCancelled`, `failed` and every outcome |
| `FailedJobSceneClosureRunOutcome` | a closure outcome, or `{ kind: "FAILED", code }` |
| `MAX_FAILED_JOB_SCENE_CLOSURE_BATCH_SIZE`, `validateFailedJobSceneClosureBatchLimit` | 100; an integer from 1 to 100 or `VALIDATION_FAILED`, never clamped |
| `FailedJobSceneClosureDefect` | codes `CLOSURE_LOST_UNDER_LOCK`, `STATE_OUTSIDE_VOCABULARY` |
| event types | `scene.cancelled`, `scene_request.cancelled`, `attempt.cancelled_pre_submission` (and the existing `scene.failed`, `scene_request.failed`); reason code `FAILED_JOB_SCENE_CLOSURE` |

### Added: `@app/database`

| Export | Shape |
| --- | --- |
| `createFailedJobSceneClosureRepository(prisma)` | Transaction L: the cost-admission lock, then job and scene, requests, attempts; the decision; the writes in one commit (ADR-0084 Decisions 2 and 4) |

### Unchanged on purpose

- Transactions H and K: each still fails the one scene it settles, with its
  job; the job's other scenes are this closure's (ADR-0084 Decision 1).
- The job and its reservation: never written or locked here (Decision 3).
- The generic transition API and the state machines: every edge the closure
  takes already exists, and it writes them itself, as H and K do.

## Database

No migration, no schema change. See `docs/migration-notes.md`.
