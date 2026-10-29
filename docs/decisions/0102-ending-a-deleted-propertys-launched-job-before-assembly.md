# ADR-0102 — Ending a deleted Property's launched job before its video is assembled

Status: Accepted (GS-7d-3a, 2026-10-29). First of the two pull requests of
GS-7d-3, which the product owner approved on 2026-10-29 08:14Z ("承認" on the
decision card, `/mnt/project-files/cto/gs-7d-3-proposal.md`): this one ends a
deleted Property's video already sent or waiting to be assembled; GS-7d-3b makes
the publication of a deleted Property's video refuse and release its Unit.
Builds on: ADR-0052 Decision 19 (a Unit with no delivered video is released,
never held forever), ADR-0083 (Transaction K), ADR-0084 (Transaction L),
ADR-0094 Decision 2 (the places a launched job holds), ADR-0099 (the ending of
a waiting job) and ADR-0100 (the ending of a generating job's attempt still
waiting to be sent).

## Context

On 2026-10-29 the product owner decided, on the decision card asking whether a
deleted Property's unfinished videos end at once and return their Units,
"すぐ戻す". ADR-0099 ends a waiting one. ADR-0100 ends a generating one's
attempt while it still waits to be sent, and Transaction K then fails the job
and releases its Unit.

A launched job with no attempt left waiting is not ended: every scene was sent
(`GENERATING`), every scene is back (`SCENES_READY`), or the video waits to be
assembled (`COMPOSITION_PENDING`). No step after the paid-submission gate reads
the Property, and Transaction G, which publishes an initial video, is the one
place its Unit is consumed. So such a video is still assembled and delivered,
and the customer's Unit is consumed for a Property they deleted.

## Decision 1 — A launched job not yet being assembled ends when its Property is deleted

`decideLaunchedJobEnding(locked)` answers from the rows the ending locked, in
this order:

1. the job is not `GENERATING`, `SCENES_READY` or `COMPOSITION_PENDING`:
   **keep** (`NOT_BEFORE_ASSEMBLY`). It waits (ADR-0099's), is being assembled
   or checked (GS-7d-3b's), was delivered or ended, belongs to another
   organization, or does not exist;
2. the job names a delivered video: **keep** (`HOLDS_DELIVERABLE`). It is a
   regeneration, which holds no Unit and rolls back to that video on failure
   (ADR-0083 Decision 3);
3. its reservation is not `RESERVED`: **keep** (`RESERVATION_NOT_HELD`). A hold
   on reconciliation is reconciliation's to move: once it is restored the next
   pass ends the job, and once it is released Transaction K fails the job,
   which accepts a released hold. One consumed or released has nothing left to
   return, as in ADR-0099;
4. its Property stands: **keep** (`PROPERTY_STANDS`);
5. otherwise **end** it, from the state it was read in.

A `GENERATING` job still with an attempt waiting to be sent is ended here too.
ADR-0100's ending of that attempt reaches the same end through Transaction K.
This ending, ADR-0100's and K all take the cost-admission lock for the job's
cycle, so they are ordered. Whichever of this ending and K commits first fails
the job and releases its Unit, and the other then refuses: K settles only a
`GENERATING` job, and this ending only one not yet failed whose hold is
`RESERVED`. An attempt ADR-0100's
ending cancels after this one is cancelled as Transaction L would cancel it.
Either way the job fails once and its Unit is released once.

## Decision 2 — One commit, behind the cost-admission lock

`endPropertyDeletedLaunchedJob({ organizationId, generationJobId, endedAt,
context })` runs in one transaction:

```text
cost-admission advisory lock (organization, the reservation's frozen cycle or "unreserved")
  -> GenerationReservation   FOR UPDATE
  -> Property                FOR SHARE
  -> GenerationJob           FOR UPDATE
  -> decide
  -> GenerationJob           its state -> FAILED_TERMINAL, and its event
  -> GenerationReservation   RESERVED -> RELEASED, releasedAt = endedAt, and its event
  -> commit
```

**The lock order** is the waiting job's ending's (ADR-0099 Decision 3) without
its scenes and requests, and the order of every release
(`cost-admission-lock.ts`). The paid-submission gate reads the reservation under
the same lock, so nothing is authorized against a Unit this has just released.
Transactions H and K, which fail a generating job and release its Unit, take
the same lock first. The billing-cycle key is read before the lock; it is
frozen when the hold is taken. The Property is held `FOR SHARE` after the
reservation, as the gate holds it, so a deletion saving is waited for and then
seen. Every read is tenant-scoped through the job's project, and the Property's
by its own organization too, as ADR-0100 reads it.

**Against the writers that move a launched job forward.** Scene delivery
(Transaction F) and the composition claim (J1) lock the job first and take
neither the reservation nor the Property. Composition admission (Transaction I)
locks the reservation before the job, as this ending does, and no Property. So
none of them holds the job while it waits for a row this ending holds, and
there is no cycle. Whichever locks the job first commits first, and the other
reads the state it left. A job claimed for composition reads
`COMPOSING` here and is kept for GS-7d-3b. A job ended here is refused by F, I
and J1, which each require their own state.

**What is written.** The job moves to `FAILED_TERMINAL` with a
`job.ended_property_deleted` event. The reservation moves `RESERVED →
RELEASED` with `releasedAt` set to `endedAt` and a `reservation.released`
event. Both events carry `PROPERTY_DELETED` as their reason code and the
caller's actor and correlation. The allocations are not written: a released
reservation returns its Units (Phase 6A). Each write is a compare-and-set on
the state read under its lock. One that matches no row rolls the commit back:
the job's as the locked transition's internal error, the reservation's as a
defect (`ENDING_LOST_UNDER_LOCK`). A refusal writes nothing.

**No audit entry**, as for ADR-0099 and Transactions K and L; the transition
events are the record. Whether a release the customer did not ask for warrants
one stays open with the item already recorded (`docs/decisions/TODO.md`, *A
preflight-failure audit event, if wanted, belongs to orchestration*).

## Decision 3 — The scenes are left to Transaction L

The ending neither locks nor writes a scene, a request or an attempt. Transaction
L closes a failed job's open scenes once nothing of them is at the provider
(ADR-0084), as it does after K: an attempt still waiting to be sent is
cancelled, and the scene and its request fail. A scene already delivered stays
`READY`.

An attempt already at the provider still finishes there. Its output is copied
into managed storage, but it is never delivered: scene delivery requires the
job `GENERATING`. That call's cost is VTaVision's, never the customer's, as
ADR-0083 Decision 1 accepts for a sibling of any failed scene. A
`COMPOSITION_PENDING` job's planned deliverable version stays with its inputs and
no composition: the claim requires the job `COMPOSITION_PENDING`, so nothing
composes it.

**The Unit is released even while a submission's outcome is unknown.** A hold
stands `RESERVED` while an attempt of the job is being submitted or is at the
provider. The ending releases it, and an outcome that later turns out unknown
leaves the released hold alone rather than moving it to reconciliation
(`RELEASED` is gone). No video of the job will be delivered, so no Unit is the
customer's to spend; whatever the provider did is VTaVision's cost, as above.

## Decision 4 — Finding them, and the launch runner ends them

`findPropertyDeletedLaunchedJobs({ limit })` reads, without locks, the jobs in
those three states with no delivered video, a `RESERVED` reservation and a
deleted Property, oldest first by creation and then id, up to `limit`
(validated as the launch's limit is). It mirrors every refusal of the ending,
so a job the ending would refuse is never offered and cannot hold a place in
the batch.

`JobLaunchRunner.runOnce(limit)` takes the ending as `launchedEnding` and runs
it between its two steps. First come the waiting jobs of deleted Properties
(ADR-0099), then up to `limit` launched ones, then the launches. A launched
job holds one of its organization's places (ADR-0094 Decision 2). Ending it
before the launches lets the organization's next waiting job take that place in
the same pass. The ending's answer is the job's outcome: `ENDED` with
`PROPERTY_DELETED`, or `NOT_ENDED` with the refusal. An ending that throws is
that job's `FAILED` outcome, keeping only a defect's code, and the pass goes
on. A read that throws rejects the pass, and nothing is launched; the waiting
jobs already ended stay ended, each its own commit, and only their report is
lost. `ended` counts both endings, which their events tell apart
(`job.ended_unlaunchable`, `job.ended_property_deleted`).

A place counts a customer's videos at once (ADR-0094 Decision 2), not provider
work. As after Transaction K, a failed job holds none while an attempt of it may
still finish at the provider. That attempt's cost stays in the paid-submission
gate's exposure, which counts attempts by their own state, whatever their job's
or their hold's.

## Decision 5 — Nothing runs it yet

`createLaunchedJobEndingRepository` and `JobLaunchRunner` have no caller outside
tests, and the static tests keep it so. The module and the repository reach no
provider, HTTP client or storage and schedule nothing. The pipeline command
(GS-9) is what will run the launch runner, on the test provider only.

## Not decided here

- **A deleted Property's video being assembled or checked** (`COMPOSING`,
  `DELIVERABLE_VALIDATING`). A worker holds that work under a lease and is not
  cut off. GS-7d-3b, approved the same day, makes Transaction G refuse to
  publish such an initial video, fail the job and release its Unit
  (`docs/decisions/TODO.md`, *End a deleted Property's video already at the
  provider or being assembled*).
- **A regeneration of a deleted Property's delivered video.** No Unit is held
  by one. Whether it may run at all belongs to the open item on video projects
  created before their Property's deletion.
- **Removing an ended job's copied outputs and planned version.** They are only
  in internal storage and the database. Removing them belongs to the 30-day
  trash lifecycle (`docs/decisions/TODO.md`, *Build the 30-day trash
  lifecycle*).
- **How the customer is shown an ended video** (GS-10, GS-11). The wording must
  not name a provider or a model.
- **Whether an ended job warrants an audit entry** (Decision 2, and the TODO
  item it names).

## Consequences

- `@app/domain`: in the `job-launch` module, `decideLaunchedJobEnding`,
  `JOB_STATES_BEFORE_ASSEMBLY`, `JobStateBeforeAssembly`,
  `LaunchedJobLockedRows`, `LaunchedJobEnding`, `LaunchedJobEndingRefusal`,
  `JOB_ENDED_PROPERTY_DELETED_EVENT_TYPE`, and the `LaunchedJobEndingRepository`
  port with `PropertyDeletedLaunchedJob`, `EndLaunchedJobInput` and
  `EndLaunchedJobOutcome`. `JobLaunchRunnerDeps` gains `launchedEnding`, and
  the runner's `NOT_ENDED` outcome carries either ending's refusal.
- `@app/database`: `createLaunchedJobEndingRepository(prisma)`. The job's
  edges from `GENERATING`, `SCENES_READY` and `COMPOSITION_PENDING` to
  `FAILED_TERMINAL` stay refused by the generic repository; this ending is one
  of their owners.
- No migration. Nothing outside tests constructs the repository or the runner,
  so no path a customer or a worker reaches changes.
