# API Changes — GS-7a

The concurrent-job limit and a waiting job's launch plan (ADR-0094). **No
migration; no route and no page.** Nothing outside tests builds the planner
yet.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | What it is |
| --- | --- |
| `JobLaunchPlanner({ routes, models, pricing, fx, clock })` | `plan(facts)` plans a waiting job whole: one route for every scene, qualified against the route policy, the model catalog, every scene's length and the paid-submission gate's own check, with the catalog's default deciding between several and `AMBIGUOUS_ROUTE` when it cannot; each scene's prompt rendered once and priced at one instant against the one contract in force, at the rate the FX source gives last. `PLANNED` with the route and one admission per scene, or `NO_PLAN` with a fixed code. Writes nothing |
| `JobLaunchFacts`, `JobLaunchSceneFacts` | the waiting job's frozen facts the planner reads |
| `JobLaunchPlan`, `JobLaunchRoute`, `JobLaunchSceneAdmission`, `JobLaunchNoPlanCode` | its answer |
| `JOB_STATES_HOLDING_A_PLACE`, `JOB_STATE_WAITING_FOR_A_PLACE`, `holdsAPlace(state)` | which job states hold one of the organization's places (launched, not ended), and the one a job waits in (`RESERVED`) |
| `decideJobLaunchCapacity({ concurrentJobs, jobsHoldingAPlace })` | `PLACE_FREE` or `AT_LIMIT`; throws on a limit below one or a count that is not a whole number |
| `currentlyEligibleContractsForRoute(pricing, route, at)`, `CommercialPricingRoute` | every verified contract in force for a route's five commercial dimensions, de-duplicated by identity; moved from the media-recovery planner, which now calls it |

### Changed

| Where | Change |
| --- | --- |
| `CustomerPlan` (`@app/domain`) | gains `concurrentJobs`: Standard 1, Premium 3, Enterprise 5 (ADR-0052 Decision 7) |
