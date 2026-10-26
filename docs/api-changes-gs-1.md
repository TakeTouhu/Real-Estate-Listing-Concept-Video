# API Changes — GS-1

A failed deliverable settles its job in the same commit (ADR-0082). **No
migration. No route, page, command or environment variable is added**, and
nothing in production constructs or calls what changed.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | Shape |
| --- | --- |
| `settleFailedDeliverable({ currentDeliverableVersionId, reservationState })` | `{ kind: "RELEASE", jobState: "FAILED_TERMINAL", releaseFrom }` for a job with no deliverable whose reservation is `RESERVED` or `RECONCILIATION_HOLD`; `{ kind: "ROLL_BACK", jobState: "DELIVERABLE_READY" }` for a job holding a deliverable whose reservation is `CONSUMED`; otherwise throws `RESERVATION_NOT_SETTLEABLE` |
| `isDeliverableFailureSettled({ failedIn, jobState, currentDeliverableVersionId, reservationState, failedVersionIsNewest })` | an initial generation: job `FAILED_TERMINAL` and reservation `RELEASED`; a replacement: reservation still `CONSUMED`, and the job no longer in `failedIn` with that version as its newest |
| `FailedDeliverableCycleState` | `"COMPOSING" \| "DELIVERABLE_VALIDATING"` |
| `DeliverableSettlementDefect` | codes `RESERVATION_NOT_SETTLEABLE`, `SETTLEMENT_INCOMPLETE`, `SETTLEMENT_LOST_UNDER_LOCK` |
| event types | `job.deliverable_failed`, `job.deliverable_rolled_back`, `reservation.released`; reason code `DELIVERABLE_FAILURE_SETTLEMENT` |

### Changed: `@app/domain`

| Member | Change |
| --- | --- |
| job state machine | adds `COMPOSING → DELIVERABLE_READY` (the replacement rollback) |
| `FinalizeDeliverableValidationInvalidInput`, `…OffPlanInput`, `…MismatchInput` | add `context: TransitionContext`, for the settlement's events |
| `DeliverableValidationRunner` | passes its transition context to the three terminal verdicts; `runOnce` reports a settlement defect's code in a `FAILED` outcome, as it does a validation defect's |

### Changed: `@app/database`

| Method | Change |
| --- | --- |
| `blockComposition` | takes the organization and billing-cycle cost-admission lock and then the reservation before the chain; answers `LEASE_LOST` when the job is not `COMPOSING` on its newest version, or when the claim's work row is not the version's own; after writing `BLOCKED`, settles the job (ADR-0082 Decision 2) in the same commit; a replay answers `ALREADY_BLOCKED` only when the settlement is durable, else throws `SETTLEMENT_INCOMPLETE` |
| `finalizeInvalidMedia`, `finalizeOffPlan`, `finalizeIntegrityMismatch` | the same, for `DELIVERABLE_VALIDATING`: the cost-admission lock and the reservation first; `LEASE_LOST` when the job is not validating its newest version; settle after writing the verdict; a replay answers `ALREADY_FINALIZED` only when settled, else throws `SETTLEMENT_INCOMPLETE` |
| generic `jobs.transition` | answers `TRANSITION_RESERVED` for `RESERVED → CANCELLED`, `→ FAILED_TERMINAL` from `RESERVED`, `GENERATING`, `SCENES_READY`, `COMPOSITION_PENDING`, `COMPOSING` and `DELIVERABLE_VALIDATING`, and `COMPOSING → DELIVERABLE_READY` |

### Unchanged on purpose

- The outcome unions: settlement adds no outcome. Its refusals are defects.
- The claims, `finalizeComposition`, `finalizeValid`, the deferrals and
  Transaction G: none settles or locks anything new.
- Discovery: a failed initial job is `FAILED_TERMINAL` and a rolled-back one
  `DELIVERABLE_READY`, which no discovery offered before either.

## Database

No migration, no schema change. See `docs/migration-notes.md`.
