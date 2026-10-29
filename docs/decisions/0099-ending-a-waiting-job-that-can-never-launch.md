# ADR-0099 — Ending a waiting job that can never launch, and releasing its Units

Status: Accepted (GS-7d-1, 2026-10-29). Sixth of the pull requests for row
GS-7 of the generation-to-preview plan the product owner approved on
2026-10-26 (`/mnt/project-files/cto/generation-e2e-proposal.md`). GS-7d is
split in two (`/mnt/project-files/cto/gs-7d-proposal.md`): this pull request
ends a waiting job, and GS-7d-2 ends a generating job's attempt that can never
be sent.
Builds on: ADR-0052 Decision 19 (a Unit with no delivered video is released,
never held forever), ADR-0083 (Transaction K), ADR-0084 (Transaction L),
ADR-0087 and ADR-0088 (the start), ADR-0094 (the launch planner) and ADR-0095
(the launch commit).

## Context

A started job waits `RESERVED`, its Units held, until its organization has a
place (ADR-0095). Nothing ends a job that waits: the job's `RESERVED →
FAILED_TERMINAL` edge has no owner (ADR-0082), and Transactions K and H, and
the deliverable failure settlement, fail only a job that has started.

Some waiting jobs can never start, because of their own rows:

- Its Property was deleted. The launch never launches it and passes over it in
  the order (ADR-0095 Decision 3), so it keeps its Units for good.
- A fact frozen at the start that the planner refuses before consulting any
  catalog (ADR-0094): a resolution outside the product's vocabulary, no
  scenes, a scene with no prompt, or a prompt that does not render. These facts
  were copied at the start and nothing writes them again.
- Rows not as the start wrote them (`SHAPE_CONFLICT`), which only a writer
  other than the start can make.

Each of these is refused on every pass it is offered to and holds its Units,
against ADR-0052 Decision 19. The launch is oldest first, so the second and
third kinds also hold back their organization's later jobs, and the candidate
query offers organizations by their oldest waiting job, so enough of them fill
a pass's window (ADR-0095 Decision 7).

On 2026-10-29 the product owner decided, on the decision card asking whether
a deleted Property's unfinished videos end at once and return their Units,
"すぐ戻す": they do, without waiting for the 30-day trash period of ADR-0052
Decision 17. Nothing restores a Property today, and nothing ends the trash
period, so a hold kept for it would never be settled.

## Decision 1 — A job ends only for its own rows

A waiting job ends, and its Units come back, for one of these causes, each a
fixed code:

| Cause | When |
| --- | --- |
| `PROPERTY_DELETED` | its Property's status is `DELETED` |
| `TARGET_RESOLUTION_UNKNOWN` | its resolution is outside the product's vocabulary |
| `NO_SCENES` | it has no scenes |
| `SCENE_PROMPT_MISSING` | a scene's frozen prompt is null |
| `SCENE_PROMPT_UNRENDERABLE` | a scene's frozen prompt does not render |
| `SHAPE_CONFLICT` | a scene is not `PENDING`, or does not have exactly one first request, `PENDING` |

A job the planner refuses for VTaVision's own configuration or for timing is
**not** ended: no authorized route (`NO_ROUTE`), more than one
(`AMBIGUOUS_ROUTE`), no current price or more than one, or no usable rate. Each
can pass once the configuration is fixed, and failing a customer's video for a
setting of ours would be wrong. Such a job waits with its Units held, as
before. How long it may wait is not decided here (`docs/decisions/TODO.md`,
*Bound how long a waiting job refused for configuration may hold its Units*).

The frozen-fact codes are the planner's first step, before any catalog. That
step is now one function, `checkFrozenFacts`, which the planner runs and the
ending runs on the rows it locked, so the two cannot disagree about what a
frozen fact is. The shape check is likewise one function, `scenesOfStartShape`,
which the launch decision and the ending share.

One frozen fact can fail because of a change of ours. Editing the prompt's
fixed rules (`PRESERVATION_RULES` or `SYSTEM_NEGATIVE_CONSTRAINTS`) makes every
admitted, unexecuted prompt fail to render, which ADR-0020 accepts as a
re-admission event, failed closed. A job still waiting then ends as
`SCENE_PROMPT_UNRENDERABLE` with its Units released: no one is charged, but
every waiting video must be started again. How such a change is released is
not decided here (`docs/decisions/TODO.md`, *Release a change to the prompt's
fixed rules only when no job waits*).

## Decision 2 — The ending decides the cause from the rows it locked

`decideUnlaunchableJobEnding(locked)` answers from the rows the ending locked,
never from what a caller believed, so a job ends only for what its rows say at
the commit. It answers, in this order:

1. the job is not `RESERVED`: **keep** (`NOT_WAITING`). It launched, ended,
   belongs to another organization, or does not exist;
2. its reservation is not `RESERVED`: **keep** (`RESERVATION_NOT_HELD`).
   `RESERVED` is the only hold this commit may release: a hold on
   reconciliation is the platform not knowing what a provider did, and
   one consumed or released has nothing left to return;
3. a request of the job has an attempt: **keep** (`ATTEMPT_ADMITTED`). An
   attempt may be at the provider, and a Unit is released here only for a job
   nothing of which was ever admitted. The launch admits attempts and starts
   the job in one commit (ADR-0095), so a waiting job with an attempt is one
   some other writer made;
4. its Property is deleted: **end** (`PROPERTY_DELETED`);
5. a frozen fact fails: **end** with its code;
6. its scenes are not as the start wrote them: **end** (`SHAPE_CONFLICT`);
7. otherwise **keep** (`LAUNCHABLE`).

The reservation and the attempts come before every cause, so whatever else is
true of a job, a hold that is not `RESERVED` is never released and a job that
may have reached the provider is never ended. Of the causes, the deleted
Property is named first, being what the customer did.

## Decision 3 — One commit, behind the cost-admission lock

`endUnlaunchableJob({ organizationId, generationJobId, endedAt, context })`
runs in one transaction:

```text
cost-admission advisory lock (organization, the reservation's frozen cycle or "unreserved")
  -> GenerationReservation   FOR UPDATE
  -> Property                FOR SHARE
  -> GenerationJob           FOR UPDATE
  -> GenerationScene         FOR SHARE, in position order
  -> SceneGenerationRequest  FOR UPDATE, in scene position order
  -> their attempts          counted, in a statement of their own
  -> decide
  -> GenerationJob           RESERVED -> FAILED_TERMINAL, and its event
  -> GenerationReservation   RESERVED -> RELEASED, releasedAt = endedAt, and its event
  -> commit
```

**The lock order.** The cost-admission lock first and the reservation next, as
every transaction that releases a Unit takes them (`cost-admission-lock.ts`):
the paid-submission gate reads the reservation under the same lock, so nothing
is authorized against a Unit this has just released. The billing-cycle key is
read before the lock, which is safe because it is frozen when the hold is
taken; only that read precedes it, and no row is locked before it. The
Property is held `FOR SHARE` after the reservation, as the gate holds it
(ADR-0096), so a deletion saving is waited for and then seen.

**Against the launch.** The launch takes no cost-admission lock and holds the
Property and the reservation `FOR SHARE` before the job (ADR-0095). An ending
holding the reservation `FOR UPDATE` makes a launch wait at it, and a launch
holding it makes the ending wait; whichever commits first leaves the job the
other refuses (`NOT_WAITING`). The Property is shared by both, so neither
waits for the other there.

**Against an admission.** Every admission of an attempt inserts under a
request, and the attempt's foreign-key check waits for a request held `FOR
UPDATE`; so once the ending holds the requests, no attempt is admitted under
them until it commits. Their attempts are counted after that lock, in a
statement of their own: a statement reads what was committed when it began,
even for a row it waited for, so a count inside the locking statement would
miss an attempt committed while it waited, and a job with an attempt would be
ended. The launch admits under the job's lock, which the ending takes first.

**Against the start and a deletion.** The start takes the cost-admission lock
before the project and Property (ADR-0087), the order this one keeps. A
deletion locks the Property and waits for nothing this holds.

**What is written.** The job moves `RESERVED → FAILED_TERMINAL`, with a
`job.ended_unlaunchable` event. The reservation moves `RESERVED → RELEASED`
with `releasedAt` set to `endedAt` and a `reservation.released` event, the
type every release writes. Both events carry the cause as their reason code
and the caller's actor and correlation. The reservation's allocations are not
written: a period's balance counts each allocation by its reservation's state,
so a released reservation returns its Units (Phase 6A). Each write is a
compare-and-set on the state the commit read under its lock; one that matches
no row rolls the commit back, the reservation's as a defect
(`ENDING_LOST_UNDER_LOCK`), the job's as the locked transition's internal
error.

Any refusal writes nothing.

**No audit entry.** Transactions K and L, which release a Unit and cancel
attempts, write none; the transition events are the record. Whether a release
the customer did not ask for warrants an audit entry stays open with the item
already recorded (`docs/decisions/TODO.md`, *A preflight-failure audit event,
if wanted, belongs to orchestration*).

## Decision 4 — The scenes and requests are left to Transaction L

The ending writes neither the scenes nor the requests. Transaction L closes the
open scenes of every failed job once nothing of them is at the provider
(ADR-0084): a scene that never started is cancelled with its pending request,
which is every scene of a job that never launched. Closing them here would be
a second copy of L's rule. Until L runs, a failed job has `PENDING` scenes, the
state Transaction K already leaves a job's other scenes in. Nothing reads them
as live: delivery requires the job `GENERATING`, and the gate refuses a
released Unit.

A scene of a `SHAPE_CONFLICT` job that L refuses (for instance one with a
second request) stays as it is under the failed job; it has no attempt, so
nothing of it can be sent or paid for.

## Decision 5 — The launch runner ends them

`JobLaunchRunner.runOnce(limit)` now takes the ending repository and a clock,
and runs in two steps:

1. **Deleted Properties' waiting jobs.** `findPropertyDeletedWaitingJobs({
   limit })` offers, oldest first by creation and then id, up to `limit` waiting
   jobs whose Property is deleted, whose reservation is `RESERVED` and none of
   whose requests has an attempt: every refusal of the ending, mirrored, so a
   job it would refuse is never offered. Each is ended. They are never launch
   candidates (ADR-0095 Decision 3), so this is how they are found, up to
   `limit` of them a pass, whether or not their organization has a place.
2. **The launch,** as before, with one change: a candidate whose rows were not
   of the start's shape (facts `null`), one the planner refused for a frozen
   fact, and one the commit refused as `PROPERTY_DELETED` or `SHAPE_CONFLICT`
   is handed to the ending instead of being reported and left. Every other
   refusal is reported as before.

The ending's answer is the job's outcome: `ENDED` with its cause, or
`NOT_ENDED` with the refusal. An ending that throws is that job's `FAILED`
outcome, keeping only a defect's code, and the pass goes on. The report gains
`ended`. Each ending gets the runner's own correlation and the clock's
instant.

A job ended at the head of its organization's queue frees the queue: the
next pass offers the organization's next waiting job. A job refused for a
frozen fact or its shape is found only as a launch candidate, so it is ended
only when its organization has a place and a subscription; until then it
holds its Units, as before. Once offered, such jobs no longer fill a pass's
window; jobs refused for configuration still can, and keeping them from doing
so is GS-9's (ADR-0095 Decision 7).

## Decision 6 — Nothing runs it yet

`createUnlaunchableJobEndingRepository` and `JobLaunchRunner` have no caller
outside tests, and a static test keeps it so. The ending's module and
repository reach no provider, HTTP client or storage and schedule nothing. The
pipeline command (GS-9) is what will run the launch runner, on the test
provider only.

## Not decided here

- **A generating job's attempt that can never be sent** (GS-7d-2): its Property
  deleted, or its photo gone or unreadable, after the job launched. The gate
  refuses it every time and writes nothing, so its Unit is held and the job
  keeps one of its organization's places.
- **How long a waiting job refused for configuration may hold its Units**
  (Decision 1, `docs/decisions/TODO.md`). Must be decided before generation is
  activated.
- **How the customer is shown an ended job.** Nothing shows a job's state to a
  customer yet; the progress page is GS-10's and GS-11's. Its wording must
  not name a provider or a model.
- **A restored Property.** If a restore from the trash (ADR-0052 Decision 17)
  is built, a restored Property's ended videos are started again by the
  customer, at no loss, since their Units were returned.
- **Whether an ended job warrants an audit entry** (Decision 3).
- **How a change to the prompt's fixed rules is released** (Decision 1), since
  it ends every waiting job.
- **A waiting job that is neither launched nor ended**: one whose hold is not
  `RESERVED`, or one of whose requests has an attempt. Only a writer other
  than the start and the launch makes such a job; it keeps its organization's
  queue held back (`docs/decisions/TODO.md`, *Release a started job that can
  never launch*).

## Consequences

- `@app/domain`: in the `job-launch` module, `decideUnlaunchableJobEnding`,
  `UnlaunchableJobCause`, `UnlaunchableJobEndingRefusal`,
  `JOB_ENDED_UNLAUNCHABLE_EVENT_TYPE`, the `UnlaunchableJobEndingRepository`
  port and its input and outcome, and the `FrozenFactsCode` type; the
  planner's frozen-fact step as `checkFrozenFacts`, inside the module;
  `JobLaunchRunner` takes `ending` and `clock`, and its report gains `ended`;
  `JobLaunchDefect` gains `ENDING_LOST_UNDER_LOCK`.
- `@app/database`: `createUnlaunchableJobEndingRepository(prisma)`.
- No migration. Nothing outside tests constructs the repository or the runner,
  so no path a customer or a worker reaches changes.
