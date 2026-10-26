# API Changes — GS-2a

A scene whose attempts ended without a video settles its job (ADR-0083). **No
migration. No route, page, command or environment variable is added**, and
nothing in production constructs or calls what was added.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | Shape |
| --- | --- |
| `decideAttemptFailureSettlement(facts)` | `{ kind: "FAIL_INITIAL", releaseFrom: "RESERVED" \| "RECONCILIATION_HOLD" \| null }` for an initial generation; `{ kind: "ROLL_BACK_REGENERATION" }` for a scene regeneration; otherwise `{ kind: "NOT_SETTLEABLE", reason }` |
| `AttemptFailureFacts` | the request's kind, state and delivery; every attempt's state, newest last; the scene's state and what its pointer names; the job's state and whether it holds a deliverable; the reservation's state or `null`; the job's other scenes not `READY` and other open regenerations |
| `AttemptFailureRefusal` | `REQUEST_NOT_GENERATING`, `ATTEMPT_NOT_FAILED`, `JOB_NOT_GENERATING`, `SHAPE_CONFLICT`, `RESERVATION_NOT_SETTLEABLE` |
| `endedWithoutOutput(state)` | true for `FAILED_RETRYABLE`, `FAILED_TERMINAL`, `RECONCILIATION_EXHAUSTED`, `CANCELLED_PRE_SUBMISSION` |
| `AttemptFailureSettlementRepository` | `findAttemptFailureCandidates({ limit })` → identifiers only; `settleAttemptFailure({ organizationId, generationSceneRequestId, settledAt, context })` → `SETTLED` (`INITIAL_FAILED` or `REGENERATION_ROLLED_BACK`, with `unitReleased`), `NOT_SETTLEABLE` with its reason, or `NOT_FOUND` |
| `AttemptFailureSettlementRunner` | `runOnce(limit)`: one bounded pass, each candidate settled with its own instant and context; reports `settled`, `unitsReleased` and every outcome |
| `MAX_ATTEMPT_FAILURE_SETTLEMENT_BATCH_SIZE`, `validateAttemptFailureSettlementBatchLimit` | 100; an integer from 1 to 100 or `VALIDATION_FAILED`, never clamped |
| `AttemptFailureSettlementDefect` | codes `SETTLEMENT_LOST_UNDER_LOCK`, `STATE_OUTSIDE_VOCABULARY` |
| event types | `scene_request.failed`, `scene.failed`, `scene.revision_rolled_back`, `job.scene_failed`, `job.revision_rolled_back` (and the existing `reservation.released`); reason code `ATTEMPT_FAILURE_SETTLEMENT` |

### Added: `@app/database`

| Export | Shape |
| --- | --- |
| `createAttemptFailureSettlementRepository(prisma)` | Transaction K: the cost-admission lock, the reservation, then job, scene and request; the decision; the writes in one commit (ADR-0083 Decisions 3 and 4) |

### Changed: `@app/database`

| Method | Change |
| --- | --- |
| generic `requests.transition` | answers `TRANSITION_RESERVED` for `GENERATING → FAILED_TERMINAL` |
| generic `scenes.transition` | answers `TRANSITION_RESERVED` for `GENERATING → FAILED_TERMINAL` |

### Unchanged on purpose

- The five writers that end an attempt: none settles anything itself
  (ADR-0083 Decision 1).
- Transaction H: it settles a newest attempt that produced a video and failed
  its media check, and this a newest attempt that produced none.
- The state machines: every edge the settlement takes already exists.

## Database

No migration, no schema change. See `docs/migration-notes.md`.
