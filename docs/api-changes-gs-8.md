# API Changes — GS-8

Planning a video's composition once its scenes are ready (ADR-0104). **No
migration; no route and no page.** Nothing outside tests constructs the runner,
and nothing but the runner calls the plan repository.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | What it is |
| --- | --- |
| `CompositionPlanRunner` | one bounded pass: asks for candidates once, then calls Transaction I once per job with a fresh version id and its own context; a job listed twice is planned once; an admission that throws is that job's `FAILED` outcome and the pass goes on; a query that throws rejects the pass |
| `CompositionPlanRunnerDeps` | `{ repository, ids, context }` |
| `CompositionPlanIds` | `nextDeliverableVersionId()`, the id an admission uses only if it plans |
| `CompositionPlanReport` | `{ planned, failed, outcomes }`, one outcome per job |
| `CompositionPlanRunOutcome` | Transaction I's outcome, or `{ kind: "FAILED", code }` with a `DeliverableCompositionDefectCode` or `null` |
| `CompositionPlanCandidate` | `{ organizationId, generationJobId }`, identifiers only |
| `CompositionPlanCandidateQuery` | `{ limit }` |
| `MAX_COMPOSITION_PLAN_BATCH_SIZE` | 100 |
| `validateCompositionPlanBatchLimit(value)` | an integer from 1 to 100, refused with `VALIDATION_FAILED` otherwise and never clamped |

### Changed

| Export | Change |
| --- | --- |
| `DeliverableCompositionPlanRepository` (`@app/domain`) | gains `findCompositionPlanCandidates(query)` |
| `createDeliverableCompositionPlanRepository(prisma)` (`@app/database`) | implements it: one read with no lock and no transaction, the `SCENES_READY` jobs whose hold describes a first video (no current deliverable, `RESERVED`) or a recomposition (a current deliverable, `CONSUMED`), with at least one scene and every scene `READY` with a `DELIVERED` request, its latest attempt `OUTPUT_VERIFIED` and that attempt's verdict `VALID`; oldest first by the job's creation, then its id; the organization taken from the job's project. `admitCompositionPlan` is unchanged |
