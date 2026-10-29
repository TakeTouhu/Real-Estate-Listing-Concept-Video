# API Changes — GS-7d-3b

Transaction G refuses a deleted Property's first video and releases its Unit
(ADR-0103). **No migration; no route and no page.** Nothing outside tests
constructs the validation repository or its runner.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | What it is |
| --- | --- |
| `DeliverableFailureCause` | why a cycle settles with no video delivered: `NO_USABLE_VIDEO` (a blocked composition or a terminal verdict) or `PROPERTY_DELETED` |
| `DeliverableSettlementRecord` | `{ jobEventType, reasonCode }`, what a settlement's transition events record |
| `deliverableSettlementRecord(kind, cause)` | names them: `job.deliverable_failed` or `job.deliverable_rolled_back` with `DELIVERABLE_FAILURE_SETTLEMENT` for `NO_USABLE_VIDEO`; `job.ended_property_deleted` (or the rollback's type) with `PROPERTY_DELETED` |

### Changed

| Export | Change |
| --- | --- |
| `PublishValidatedDeliverableOutcome` (`@app/domain`) | gains `PROPERTY_DELETED`: the job's first video, its Property deleted; nothing published, the job failed and its Unit released in the same commit |
| `DeliverableValidationRunOutcome` (`@app/domain`) | gains `PROPERTY_DELETED`, Transaction G's answer carried unchanged and counted as claimed work |
| `PublishValidatedDeliverableInput.publishedAt` (`@app/domain`) | also the instant a refused first video's Unit is released at |
| `createDeliverableValidationRepository(prisma).publishDeliverable` (`@app/database`) | takes the cost-admission lock first and holds the job's Property `FOR SHARE` after the reservation and before the job, tenant-scoped; for a first video whose Property was deleted, settles the job as a cycle with no usable video (`FAILED_TERMINAL`, Unit `RELEASED` from `RESERVED` or `RECONCILIATION_HOLD`) and answers `PROPERTY_DELETED`. Replays, stale targets and replacements are answered as before |

`settleDeliverableFailure`, inside `@app/database` and not exported, gains a
last `cause` parameter, `NO_USABLE_VIDEO` by default: the composition block and
the terminal verdicts write and record exactly what they did.
