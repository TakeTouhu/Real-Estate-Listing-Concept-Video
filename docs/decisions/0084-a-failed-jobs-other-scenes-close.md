# ADR-0084 — A failed job's other scenes close

Status: Accepted (GS-2b, 2026-10-26). Third milestone of the
generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`).
Implements: ADR-0052 Decision 19 for the scenes a failed job leaves open.
Builds on: ADR-0046 (scene delivery, Transaction F), ADR-0048 (the media failure
settlement, Transaction H), ADR-0083 (the attempt failure settlement,
Transaction K).

## Context

An initial generation fails with the first of its scenes that settles:
Transaction H for a video that failed its media check, Transaction K for an
attempt that ended without one. That commit fails the scene, its request and the
job, and releases the job's Unit. The job's other scenes are left where they
were (ADR-0083, "Not decided here"):

| A sibling that is | Holds | Can it still deliver? |
| --- | --- | --- |
| `PENDING` | a `PENDING` request, no attempt | no |
| `GENERATING`, never admitted | a `PENDING` request, no attempt | no |
| `GENERATING`, waiting to be sent | a `GENERATING` request, a `QUEUED` attempt | no: the paid-submission gate refuses a released Unit (`RESERVATION_RELEASED`) |
| `PENDING`, admitted (admission does not start the scene) | a `GENERATING` request, a `QUEUED` attempt | no, for the same reason |
| `GENERATING`, at the provider | a `GENERATING` request, an attempt `SUBMITTING` to `OUTPUT_INGESTING` | no: delivery (Transaction F) requires the job `GENERATING` |
| `GENERATING`, ended | a `GENERATING` request whose attempts have all ended | no, for the same reason |
| `READY` | a `DELIVERED` request | already delivered; the job's failure supersedes it |

None of them is a problem for money: the Unit is already released and nothing
can consume it. But each is a scene and a request reported as still working on
a job that has failed, and two writers keep reacting to them: the gate answers
`RESERVATION_RELEASED`, an anomaly, for the queued attempt every time it is
offered it, and a sibling's Transaction H work row answers `NOT_EXHAUSTED` on
every pass, because H requires the job `GENERATING`.

## Decision 1 — A sweep over durable facts, as for Transaction K

The closure is **Transaction L**, its own short transaction, offered scenes by a
bounded candidate query, for the reasons of ADR-0083 Decision 1: the job's
failure is durable (`FAILED_TERMINAL` has no outgoing edge), one transaction
with one lock order is reviewable where a change to Transactions H and K is not,
and a sweep reaches scenes that jobs failed before this build left open.

There is no work row and no lease. A closed scene is no longer a candidate, and
the candidate query mirrors every condition the decision refuses on, so a scene
the closure would refuse is not offered until the fact it refused on changes. A
candidate whose closure throws is reported as failed and the pass goes on.

## Decision 2 — Which scenes close, and into what

A scene closes when, under its locks, its job is `FAILED_TERMINAL`, the scene is
`PENDING` or `GENERATING` with no delivered pointer, it has at most one request,
that request is an undelivered initial one, and no attempt of it may be at the
provider:

| Scene | Request | Attempts | Closes into |
| --- | --- | --- | --- |
| `PENDING` | none | | scene `CANCELLED` |
| `PENDING` | `PENDING` | none | scene and request `CANCELLED` |
| `GENERATING` | none | | scene `FAILED_TERMINAL` |
| `GENERATING` | `PENDING` | none | scene `FAILED_TERMINAL`, request `CANCELLED` |
| `PENDING` or `GENERATING` | `GENERATING` | none, or each `QUEUED` or ended | each `QUEUED` attempt `CANCELLED_PRE_SUBMISSION`; request and scene `FAILED_TERMINAL` |
| `PENDING` or `GENERATING` | `GENERATING` | one `SUBMITTING` to `OUTPUT_INGESTING` | not yet (`ATTEMPT_IN_FLIGHT`) |
| anything else | | | refused, nothing written |

**A scene that never started is cancelled; one that started fails.** The state
machines say so: a `PENDING` scene may be cancelled, a `GENERATING` one may only
become `READY` or fail. A request that was never admitted is cancelled whatever
its scene; one that was admitted fails, with the closure instant as `failedAt`,
and its scene fails with it, from `PENDING` as from `GENERATING`. Admission does
not move the scene (`admitAttemptWithin`), so an admitted request under a scene
still `PENDING` is reachable through the real primitives, as the database suite
shows; refusing it would leave its queued attempt offered to the gate on every
pass. A generating request with no attempt is not a shape admission writes (it
adds the first attempt in the same commit); nothing of it is at the provider, and
it fails like the others.

**A queued attempt is cancelled before submission.** It was never sent, and it
never will be: the gate refuses a released Unit. `QUEUED →
CANCELLED_PRE_SUBMISSION` is the state machine's edge for exactly that, and it
ends the attempt, so its request can fail truthfully. Its submission facts are
untouched: it has none. Every other attempt is never written: an ended attempt
is evidence.

**An attempt the provider may hold is waited for.** A request does not report
itself finished while a provider may be working on it; the attempt state machine
has no cancellation edge out of `SUBMITTING` for the same reason. The scene
closes on the first pass after that attempt ends, by whichever writer ends it
(completion, reconciliation, the output copy). A verified video that arrives for
it is not delivered, since delivery requires the job `GENERATING`, and the scene
then closes like any other.

**A ready scene is left alone.** Its request delivered, and nothing about it is
still working. The job's failure already says the customer receives no video.

**Refusals are answers.** `JOB_NOT_FAILED`, `SCENE_NOT_OPEN`,
`ATTEMPT_IN_FLIGHT` and `SHAPE_CONFLICT` write nothing. `SHAPE_CONFLICT` names a
scene no workflow writes under a job that never delivered (a second request, a
regeneration, a delivered request, a request already failed or cancelled, a
pointer, an attempt under a `PENDING` request); a replay of a closed scene
answers `SCENE_NOT_OPEN`.

## Decision 3 — Nothing moves money

The job and its reservation are never written. The job is locked, for the lock
order only (Decision 4); the reservation is read once, unlocked, for the advisory
key. The settlement that
failed the job released its Unit (ADR-0083 Decision 3, ADR-0048), and nothing
this closes was ever going to consume one: a cancelled scene, request or attempt
and a failed one bill identically, which is to say not at all. The customer
pays nothing for a failed initial generation, however many of its scenes were
still open.

## Decision 4 — Lock order: the cost-admission lock, then the chain

```text
cost-admission advisory lock -> job, scene -> requests -> attempts
```

The advisory lock is the one the paid-submission gate, the submission outcome,
completion and reconciliation take before they move an attempt the provider may
hold, keyed by the job's reservation's frozen billing cycle (or the
organization's `unreserved` key). Holding it, the closure decides on attempt
states none of those writers can change, and a gate that sent an attempt first
is waited for: the closure then finds it in flight and leaves the scene open.
The attempt rows are locked as well, so a writer that takes no advisory lock
(the generic `recordSubmissionOutcome`) still cannot move one while this
decides.

The job and scene, then the requests, then the attempts follow in the order
Transactions F, H and K and admission take them. The reservation is read once,
unlocked, for the cycle key, which is frozen when the hold is taken.

The database suite proves the closure waits for the cost-admission lock and
decides from what its holder committed; waits behind a writer that holds that
lock and then needs the job (the shape of Transactions H and K, which take both
before refusing a failed job), instead of deadlocking with it; waits behind a
writer holding the job, then closes; and that two closures of one scene close it
once.

## Decision 5 — Events

With reason code `FAILED_JOB_SCENE_CLOSURE`, under the caller's correlation:

- on each cancelled attempt: `attempt.cancelled_pre_submission`;
- on the request: `scene_request.cancelled`, or `scene_request.failed`;
- on the scene: `scene.cancelled`, or `scene.failed`.

The job and reservation receive none: they do not change.

## Decision 6 — What it ends for other writers

- **The gate.** A closed scene has no `QUEUED` attempt, so the gate is never
  offered one of a failed job again, and its `RESERVATION_RELEASED` answer is
  left for what it means.
- **Transaction H.** A sibling whose verified video failed its media check
  closes too, its attempt being ended. Its H work row's next claim then finds
  the request no longer `GENERATING` and resolves it `OBSOLETE`, which ends the
  `NOT_EXHAUSTED` answer on every pass. That is H's existing answer for any
  request that is no longer generating (`classify` in
  `media-failure-resolution-repository.ts`, and H's suite "resolves work for a
  request that is no longer generating as obsolete"); this milestone's suite
  does not run H.
- **Transaction K.** A sibling whose attempts ended without a video was answered
  `JOB_NOT_GENERATING` and never offered; it is this closure's.

## Decision 7 — Dormant, no migration

No schema, enum or constraint changes: every state, column and edge already
exists. Nothing in production constructs `FailedJobSceneClosureRunner` or the
repository; a static test fails the build if anything does. The development-only
pipeline command (GS-9) will run it beside the other steps. Rolling back is
safe: the previous build closes nothing, and every row this build closed is
`CANCELLED`, `FAILED_TERMINAL` or `CANCELLED_PRE_SUBMISSION`, none of which has
an outgoing edge or is offered by any orchestration discovery. A cancelled
attempt's legacy `state` column is untouched (see "Not decided here").

## Not decided here

- **A cancelled job's open scenes.** A job `CANCELLED` before it generated may
  leave `PENDING` scenes; nothing cancels a job today, so this closes only a
  failed job's (`JOB_NOT_FAILED` otherwise).
- **An attempt that never ends** keeps its scene open, as it keeps a request
  out of Transaction K (ADR-0083, "Not decided here";
  `docs/decisions/TODO.md`).
- **An attempt that fails preflight** writes the legacy `state` column and
  leaves the orchestration state `QUEUED`; this cancels such an attempt like
  any other queued one, and its legacy column is left as preflight wrote it
  (`docs/decisions/TODO.md`).
- **The legacy executor's discovery** (`findNextQueuedForPreparation`) reads
  the legacy `state` column, which no orchestration writer moves, this one
  included: an attempt cancelled here stays legacy `QUEUED`, as every
  orchestrated attempt does from admission. Were that executor run, it would
  claim such a row and send it outside the paid-submission gate. Nothing in
  production constructs it. Which executor runs orchestrated attempts, and
  that the legacy discovery stops offering them, is GS-7's
  (`docs/decisions/TODO.md`).
- **Transaction K and a scene still `PENDING`.** K settles an initial request
  only under a `GENERATING` scene, and refuses one under a `PENDING` scene as
  `SHAPE_CONFLICT`. Since admission does not start the scene, the start step
  (GS-4) must start each scene in the commit that admits its first attempt, or
  such a failure would never fail its job (`docs/decisions/TODO.md`).
- **The interval** between the job's failure and the next pass, during which the
  gate still answers `RESERVATION_RELEASED` for a queued sibling, is bounded by
  how often the sweep runs. Nothing runs it yet.

---

## Consequences

- A failed job's scenes no longer report themselves as still working: each one
  that had not delivered is cancelled or failed, and an attempt still waiting to
  be sent is cancelled before submission, once nothing of the scene is at the
  provider.
- Nothing is charged and no Unit moves: the job's Unit was released by the
  settlement that failed it.
- Activation is untouched: paid Provider Activation, production Provider
  credentials, production paid AI calls, production scheduler activation and
  live Stripe charges remain BLOCKED.
