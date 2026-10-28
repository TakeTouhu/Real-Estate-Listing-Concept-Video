# ADR-0095 — Launching a waiting job, under its organization's limit, oldest first

Status: Accepted (GS-7b, 2026-10-28). Second of four pull requests for row GS-7
of the generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`, row GS-7 and Design 6:
"extra jobs wait with their Units reserved and start oldest first").
Builds on: ADR-0094 (the limit, which jobs hold a place, and the launch plan),
ADR-0087 and ADR-0088 (the start leaves the job `RESERVED`, and holds the
project and its Property while it writes), ADR-0083 and ADR-0084 (Transactions
K and L settle and close a scene's request only under a `GENERATING` scene),
ADR-0053 Decision 3B (an upgrade takes effect at once).

## Context

A started job waits `RESERVED` with its Units held. GS-7a built the limit on
each plan and a planner that, for a waiting job, chooses one route and renders
and prices every scene (ADR-0094). Nothing starts the job. Attempt admission
(`admitAttemptWithin`) creates an attempt and starts its request, but moves
neither the scene nor the job, and assumes its caller holds the request's lock
(`docs/decisions/TODO.md`, *Start each scene in the commit that admits its
first attempt*).

## Decision 1 — One launch decision per organization at a time

The launch commit takes a transaction-scoped advisory lock keyed by the
organization (`acquireJobLaunchLock`) as its first statement, before it reads
any row. Counting the jobs holding a place, choosing the oldest waiting job and
starting it are then one decision: two launches of one organization cannot
both see the last free place, and the second waits and counts the first's job.

Only the launch commit takes this lock, and it takes no cost-admission lock, so
nothing holding another lock ever waits for it. The lock's key formula lives in
the one module that holds every advisory-lock formula (`cost-admission-lock.ts`),
and neither it nor the commit's locked transition is published from the
package. A test proves a second launch of the organization waits on it.

## Decision 2 — The limit is the current subscription's

The limit is read inside the commit from the organization's subscription in
force now, by its plan's `concurrentJobs` (ADR-0094 Decision 1), not from the
period the job reserved in. An upgrade raises it for the next launch (ADR-0053
Decision 3B); a lower plan lowers it for the next launch and stops nothing
already running. An organization with no subscription launches nothing
(`NO_SUBSCRIPTION`), and a plan key the catalog does not know is a defect.

## Decision 3 — Oldest first, past a deleted Property's job

The job launched is the organization's oldest waiting one, by creation time
then id. Any other is refused (`NOT_NEXT`) and launched in its turn. A job
whose Property has been deleted is never launched (`PROPERTY_DELETED`, as the
start refuses one, ADR-0088) and is passed over in the order, so it does not
hold back the organization's other jobs. It keeps its Units `RESERVED` until
GS-7d decides how a job that can never launch is released (`docs/decisions/TODO.md`).

"Oldest" is among the jobs committed when the launch looks. A start
committing at that moment is launched in the next pass.

Only a deleted Property's job is passed over. Any other waiting job that cannot
launch, because it plans nothing, is not of the start's shape, or is a
duplicate (Decision 6), holds back its organization's later jobs until it
launches or GS-7d releases it.

## Decision 4 — The rows are locked in the declared order and found as planned

```text
job-launch advisory lock (organization)
  -> VideoProject, Property          FOR SHARE
  -> GenerationReservation           FOR SHARE
  -> GenerationJob                   FOR UPDATE
  -> GenerationScene                 FOR UPDATE, in position order
  -> SceneGenerationRequest          FOR UPDATE, in scene position order
```

- The project and its Property are held as the start holds them, so a Property
  deletion saving waits for the launch, and a launch waits for a deletion
  already saving and then refuses the job.
- The reservation is held before the job, the system-wide order, so no
  release moves it while the job starts against it. The launch never writes
  it: the Units were reserved at the start and are settled by K, L and the
  deliverable's settlement.
- The job, its scenes and their requests follow in the order Transactions F, H,
  K and L and media recovery take them.

After the limit and the order (Decisions 2 and 3), the locked rows decide
(`decideJobLaunch`), in this order:

| Found | Answer |
| --- | --- |
| the job not `RESERVED`, or not the organization's | `NOT_WAITING` |
| its Property deleted | `PROPERTY_DELETED` |
| the reservation not `RESERVED`; no scene; a scene not `PENDING`; a scene without exactly one `INITIAL` request, `PENDING`, with no attempt | `SHAPE_CONFLICT` |
| the quality, resolution, aspect ratio, or any scene's id, order, first request, length, camera motion or compiled prompt other than the plan was made from | `FACTS_CHANGED` |
| otherwise | launch |

The limit and the order are answered from the caller's own organization's
rows, so another organization's job id is answered `NO_SUBSCRIPTION`,
`AT_LIMIT` or `NOT_NEXT` when one of those holds for the caller, and
`NOT_WAITING` otherwise: never anything about the other organization.

A plan whose scenes are not the facts' scenes, in order, with their requests
and compiled prompts, or whose rendered prompt is not what the renderer makes
of the compiled one, is a defect before any row is judged: admission stores the
rendered prompt as given, and nothing later renders it again. Refusals write
nothing.

## Decision 5 — The job, its scenes and their first attempts start in one commit

On launch, in the same transaction:

- the job moves `RESERVED → GENERATING`;
- each scene moves `PENDING → GENERATING`;
- each scene's first attempt is admitted through attempt admission, with the
  plan's route, its rendered prompt and its price for that scene, and the
  request moves `PENDING → GENERATING` there. Each admission must be `ADMITTED`
  and `PRIMARY`.

A scene therefore never has an attempt under a `PENDING` scene, which K would
refuse to settle (*Start each scene in the commit that admits its first
attempt*, now done). Any admission refused or thrown rolls back the job and
every scene with it (`ADMISSION_REFUSED`).

The commit records generation events (`job.launched`, `scene.launched`, and
admission's events with `attempt.admitted_at_launch`), each with reason code
`JOB_LAUNCH` and the pass's correlation id. It writes no audit entry: the
person's action, the start, was audited as `generation.started` (ADR-0088), and
the launch is a worker's transition, recorded as every orchestration transition
is.

The attempts wait `QUEUED` for the paid-submission gate, which takes the
cost-admission lock and re-derives each price before anything is sent. Nothing
here sends anything.

## Decision 6 — The same video started twice waits for the first

One project may not have two identical requests at work at once (the
active-request index). A job of the same storyboard as one still generating is
refused by that index at admission; the launch rolls back and answers
`SAME_REQUEST_RUNNING`, and the job waits until the first one's attempts end.

Because the launch is strict oldest-first, the organization's later jobs wait
behind it. Whether such a job should be passed over, or refused at the start,
is not decided (`docs/decisions/TODO.md`).

## Decision 7 — The runner, dormant

`JobLaunchRunner.runOnce(limit)` reads up to `limit` candidates (1 to 100):
each organization's oldest waiting job whose Property stands and whose plan
leaves a place, mirroring the commit's own checks. It offers each organization
one launch per pass, plans it (ADR-0094) and hands the commit the plan, fresh
attempt and snapshot ids and its own correlation id. A job with no plan is left
waiting with the planner's code. A throw is that job's `FAILED` outcome, keeping
only a defect's code, and the pass goes on.

There is no work row: a launched job is no longer waiting, so it is no longer a
candidate. Nothing outside tests constructs the runner or the repository; the
pipeline command (GS-9) is what will.

The candidates are ordered by each organization's oldest waiting job, so a
pass's window can fill with organizations whose oldest job cannot launch, and
then no other organization's job is offered. GS-7d's release and GS-9's pass
are to keep refused jobs from using up the window.

Two launches of different organizations are not serialized. When both bind the
same new exchange-rate snapshot, the second fails on its insert, rolls back,
and is that job's `FAILED` outcome with no code; the next pass launches it.

## Decision 8 — The generic edges stay open for fixtures

The generic job and scene transitions still allow `RESERVED → GENERATING` and
`PENDING → GENERATING`. Nothing in production constructs those repositories,
and integration tests build their fixtures with the two edges. Reserving them
to the launch commit is recorded in `docs/decisions/TODO.md`.

## Not decided here

- **Sending the attempts** (GS-7c), through the paid-submission gate, and
  keeping the legacy executor's discovery off orchestrated attempts.
- **Releasing a job that can never launch** (GS-7d): a deleted Property's job,
  or one whose plan will never succeed.
- **Whether a duplicate job blocks its organization's queue** (Decision 6).
- **Revision start and the limit.** Revision start neither checks the limit
  nor takes the launch lock, so every revision started while its organization
  is at the limit holds a place beyond it. Whether a regeneration counts at all
  is already open (ADR-0094 Decision 2); nothing runs revision start today.
- **A waiting job that can never launch, and the candidate window**
  (Decisions 3 and 7): it holds back its organization's queue, and enough of
  them fill a pass's window. GS-7d and GS-9.

## Consequences

- New in `@app/domain` `job-launch`: `decideJobLaunch`, `JobLaunchRunner`, the
  launch commit's port and outcomes.
- New in `@app/database`: `createJobLaunchRepository`, with the launch lock and
  the commit. `applyLockedTransition` is exported within the package for it
  and stays unpublished.
- No migration. No code path a customer or a worker reaches changes.
