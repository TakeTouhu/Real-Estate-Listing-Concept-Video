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

### Changed: `@app/domain` validation port and runner

| Member | Change |
| --- | --- |
| `DeliverableValidationClaim` | adds `plannedMedia: PlannedDeliverableMedia` |
| `DeliverableValidationRunner` | when the validator answers `VALID` with facts off the claim's plan, finalizes `INVALID_MEDIA` with the reason and calls neither `finalizeValid` nor Transaction G; answers `INVALID_MEDIA`, or `LOST` when the refusal matched no row |

### Changed: `@app/database` deliverable validation

| Method | Change |
| --- | --- |
| `claimDeliverableValidation` | returns `plannedMedia`, derived from the composition and the job under the chain's locks |
| `finalizeValid` | throws `VALID_FACTS_OFF_PLAN`, writing nothing, for facts off the plan derived from its own locked read. A replay of a written verdict is answered as before |
| `findValidationCandidates` | offers a `VALID` verdict awaiting publication only while its stored facts are on plan; the other arms are unchanged |
| `publishDeliverable` (Transaction G) | after ADR-0080's gate, throws `VALID_FACTS_OFF_PLAN` and rolls back when the `VALID` row's stored facts are off the plan derived from its own locked read. Initial publications and replacements alike; a replay is answered `ALREADY_PUBLISHED` before it |

### Unchanged on purpose

- `finalizeInvalidMedia`: an off-plan verdict is an ordinary `INVALID_MEDIA`
  verdict with an existing reason.
- Discovery of work still to validate: an off-plan video is decided only by
  measuring it, which discovery never does.
- `PublishValidatedDeliverableOutcome` and the verdicts' outcomes: the new
  refusals are defects (ADR-0081 Decision 3).

## Database

No migration, no schema change. See `docs/migration-notes.md`.
