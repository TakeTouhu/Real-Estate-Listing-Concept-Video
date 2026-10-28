# API Changes — GS-7b

The launch commit (ADR-0095). **No migration; no route and no page.** Nothing
outside tests builds the runner or the launch repository yet.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | What it is |
| --- | --- |
| `decideJobLaunch({ locked, facts, plan })` | the launch commit's decision on the rows it locked: `LAUNCH`, or `REFUSE` with `NOT_WAITING`, `PROPERTY_DELETED`, `SHAPE_CONFLICT` or `FACTS_CHANGED`, in that order. Throws `PLAN_NOT_FOR_FACTS` when the plan's scenes are not the facts' |
| `assertPlanForFacts(facts, plan)` | the plan's scenes, in order, are the facts' scenes, with their first requests and compiled prompts |
| `JobLaunchLockedRows`, `JobLaunchLockedScene`, `JobLaunchDecision`, `JobLaunchRefusal` | its input and answer |
| `JobLaunchDefect` | a launch that cannot be right: `PLAN_NOT_FOR_FACTS`, `ATTEMPT_IDS_NOT_FOR_PLAN`, `ADMISSION_REFUSED`, `PLAN_NOT_IN_CATALOG`; a fixed message, nothing from the rows |
| `MAX_JOB_LAUNCH_BATCH_SIZE` (100), `validateJobLaunchBatchLimit(limit)` | a pass's bound, refused rather than clamped |
| `JOB_LAUNCHED_EVENT_TYPE`, `SCENE_LAUNCHED_EVENT_TYPE`, `ATTEMPT_ADMITTED_AT_LAUNCH_EVENT_TYPE`, `JOB_LAUNCH_REASON_CODE` | the commit's generation events and their reason code |
| `JobLaunchRepository` (`findJobLaunchCandidates`, `launchJob`), `JobLaunchCandidate`, `JobLaunchCandidateQuery`, `JobLaunchAttemptIds`, `LaunchJobInput`, `LaunchJobOutcome` | the launch commit's port. Outcomes: `LAUNCHED` with the attempt ids, `NO_SUBSCRIPTION`, `AT_LIMIT`, `NOT_NEXT`, `SAME_REQUEST_RUNNING`, `NOT_LAUNCHABLE` with a refusal |
| `JobLaunchRunner({ repository, planner, ids, context })` | `runOnce(limit)`: one pass over the candidates, one launch per organization, planned then committed; `NOT_PLANNED` with the planner's code, `FAILED` keeping only a defect's code. Dormant |
| `JobLaunchRunnerDeps`, `JobLaunchIds`, `JobLaunchReport`, `JobLaunchRunOutcome`, `JobLaunchDefectCode` | its dependencies and report, and the defect codes |

### Added: `@app/database`

| Export | What it is |
| --- | --- |
| `createJobLaunchRepository(prisma)` | the launch commit (ADR-0095): the candidates, each organization's oldest waiting job whose Property stands where its plan leaves a place; and `launchJob`, which under the organization's launch lock reads the limit from the current subscription, counts the jobs holding a place, proves the job the oldest waiting one, locks the project and Property (`FOR SHARE`), the reservation (`FOR SHARE`), the job, its scenes and their requests (`FOR UPDATE`), and moves the job and every scene to `GENERATING` and admits each scene's first attempt in one commit, or writes nothing |

### Changed, not published

| Where | Change |
| --- | --- |
| `applyLockedTransition` (`packages/database/src/orchestration-repositories.ts`) | exported within the package for the launch commit; not exported from `@app/database`, and a test bounds its callers |
| `acquireJobLaunchLock` (`packages/database/src/cost-admission-lock.ts`) | new, beside the cost-admission lock's formula; not exported from `@app/database` |
