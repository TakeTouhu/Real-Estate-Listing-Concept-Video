# API Changes — DS-6b

A deliverable must measure its planned size and length (ADR-0081). **No
migration. No route, page, export to customers, command or environment variable
is added**, and nothing in production constructs or calls what changed.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | Shape |
| --- | --- |
| `PlannedDeliverableMedia` | `{ widthPx, heightPx, durationMs, durationToleranceMs }`, derived and never stored |
| `plannedDeliverableMedia(input)` | from a composition's `targetWidthPx`, `targetHeightPx`, `frameRateNumerator`, `frameRateDenominator` and a job's `requestedDurationSeconds`: the frame size as frozen, the length × 1000 ms, and one frame period rounded up to whole milliseconds (34 ms at 30 fps). Throws `PERSISTED_RECORD_MALFORMED` for any value that is not a positive safe integer |
| `DeliverableOffPlanReason` | `"VIDEO_DIMENSIONS_INVALID" \| "DURATION_INVALID"` |
| `deliverableOffPlanReason(facts, plan)` | `VIDEO_DIMENSIONS_INVALID` for another width or height (exact), else `DURATION_INVALID` beyond the tolerance, else `null` |
| defect `VALID_FACTS_OFF_PLAN` | "A deliverable's valid verdict must measure the planned frame size and length" |
| defect `OFF_PLAN_VERDICT_ON_PLAN` | "A deliverable cannot be refused as off plan when it measures the planned frame size and length" |
| `FinalizeDeliverableValidationOffPlanInput` | `{ claim, facts, validatedAt }` |

### Changed: `@app/domain` validation port and runner

| Member | Change |
| --- | --- |
| `DeliverableValidationClaim` | adds `plannedMedia: PlannedDeliverableMedia` |
| `DeliverableValidationRepository` | adds `finalizeOffPlan(input)` |
| `DeliverableValidationRunner` | when the validator answers `VALID` with facts off the claim's plan, calls `finalizeOffPlan` with the facts and neither `finalizeValid` nor Transaction G; answers `INVALID_MEDIA`, or `LOST` when the refusal matched no row |

### Changed: `@app/database` deliverable validation

| Method | Change |
| --- | --- |
| `claimDeliverableValidation` | returns `plannedMedia`, derived from the composition and the job under the chain's locks |
| `finalizeOffPlan` (new) | `RUNNING` → `INVALID_MEDIA` with the reason it derives from the facts and its own locked read of the plan, never the caller's. Throws `OFF_PLAN_VERDICT_ON_PLAN`, writing nothing, for facts on that plan; answers `LEASE_LOST` for a lost lease before judging, `ALREADY_FINALIZED` for a replay of the same verdict, and throws `VALIDATION_VERDICT_CONFLICT` for a different one. The same restraint as `finalizeInvalidMedia`: no event, no job move, no Unit, no pointer |
| `finalizeValid` | throws `VALID_FACTS_OFF_PLAN`, writing nothing, for facts off the plan derived from its own locked read. A replay of a written verdict is answered as before |
| `findValidationCandidates` | offers a `VALID` verdict awaiting publication only while its stored facts are on plan; the other arms are unchanged |
| `publishDeliverable` (Transaction G) | after ADR-0080's gate, throws `VALID_FACTS_OFF_PLAN` and rolls back when the `VALID` row's stored facts are off the plan derived from its own locked read. Initial publications and replacements alike; a replay is answered `ALREADY_PUBLISHED` before it |

### Unchanged on purpose

- `finalizeInvalidMedia`: still the path for what the media policy refuses. An
  off-plan verdict is an ordinary `INVALID_MEDIA` row with an existing reason,
  written through `finalizeOffPlan`.
- Discovery of work still to validate: an off-plan video is decided only by
  measuring it, which discovery never does.
- `PublishValidatedDeliverableOutcome` and the verdicts' outcomes: the new
  refusals are defects (ADR-0081 Decision 3).

## Database

No migration, no schema change. See `docs/migration-notes.md`.
