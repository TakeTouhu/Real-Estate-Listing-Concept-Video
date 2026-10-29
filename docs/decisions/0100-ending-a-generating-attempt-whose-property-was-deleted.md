# ADR-0100 — Ending a generating job's attempt whose Property was deleted

Status: Accepted (GS-7d-2, 2026-10-29). Seventh of the pull requests for row
GS-7 of the generation-to-preview plan the product owner approved on
2026-10-26 (`/mnt/project-files/cto/generation-e2e-proposal.md`), and the
second of GS-7d's two (`/mnt/project-files/cto/gs-7d-proposal.md`): GS-7d-1
(ADR-0099) ends a waiting job; this ends a generating job's attempt that can
never be sent.
Builds on: ADR-0052 Decision 19 (a Unit with no delivered video is released,
never held forever), ADR-0083 (Transaction K), ADR-0084 (Transaction L),
ADR-0096 (the gate locks the source), ADR-0097 (discovery and the ending of a
refused preparation) and ADR-0098 (the sender).

## Context

A launched job is `GENERATING`, and each of its scenes' attempts waits
`QUEUED` before submission until the sender sends it (ADR-0098). When one of
its attempts ends without a video, Transaction K fails the job and releases
its Unit (ADR-0083), and Transaction L closes its other scenes (ADR-0084).

An attempt whose photo is gone, asked to be deleted, unrecoverable or missing
from storage already ends: preparation refuses it for good and the sender ends
it before submission with that reason (ADR-0097). One whose photo goes after
preparation is refused by the gate (`SOURCE_INVALID`, ADR-0096), offered again
by the next pass's discovery, and ended there by preparation.

An attempt whose Property was deleted is not. Discovery passes over it, so a
deleted Property's attempts do not fill the window ahead of attempts that can
be sent (ADR-0097), and the gate refuses it for good (`PROPERTY_DELETED`)
whenever it is asked, writing nothing. Preparation does not read the Property.
So such an attempt stays `QUEUED` under a `GENERATING` job for good: K never
settles its request, the customer's Unit stays held, against ADR-0052
Decision 19, and the job keeps one of its organization's concurrent places
(ADR-0094 Decision 2), so their later videos may never start.

On 2026-10-29 the product owner decided, on the decision card asking whether
a deleted Property's unfinished videos end at once and return their Units,
"すぐ戻す": both its waiting and its generating videos do, without waiting for
the 30-day trash period of ADR-0052 Decision 17. ADR-0099 ends the waiting
ones.

## Decision 1 — The attempt ends before submission, and K does the rest

A `QUEUED` attempt, before submission, whose Property is deleted is ended
`QUEUED → CANCELLED_PRE_SUBMISSION` with `PROPERTY_DELETED` as its durable
code, the gate's own reason for refusing it. That is the state and the shape a
refused preparation ends one in (ADR-0097 Decision 2), for the same reason:
nothing of it reached the provider, and every other ended state requires a
boundary instant that would record a crossing that never happened.

Nothing else is written. Transaction K then settles the attempt's request as
it settles any request whose attempts all ended without a video: an initial
generation fails its job and releases its Unit; a scene regeneration rolls back
to the video the customer already holds (ADR-0083 Decision 3). Transaction L
then closes the job's other scenes and cancels their queued attempts
(ADR-0084). Failing the job or releasing the Unit here would be a second copy
of K's rule.

An attempt of the same job already at the provider when this one ends still
runs there, and K settles the job without waiting for it: the provider cost of
that attempt is VTaVision's, never the customer's, as ADR-0083 Decision 1
already accepts for a sibling of any ended attempt.

## Decision 2 — The ending: one commit, behind the cost-admission lock

`endPropertyDeletedAttempt({ organizationId, attemptId, context })` runs in
one transaction:

```text
cost-admission advisory lock (organization, the reservation's frozen cycle or "unreserved")
  -> the attempt's Property   FOR SHARE, tenant-scoped through the attempt's project
  -> not found: NOT_QUEUED; not DELETED: PROPERTY_NOT_DELETED
  -> SceneGeneration          QUEUED before submission -> CANCELLED_PRE_SUBMISSION, compare-and-set
  -> its transition event
  -> commit
```

**The lock order.** The cost-admission lock first, with the key the gate takes
for this attempt, read before it as the refused preparation's ending reads it:
the gate, the submission outcome, completion, reconciliation and Transactions
H, K and L all take it before any row lock, so the ending is in no cycle with
them. The Property is held `FOR SHARE` after it, as the gate holds it
(ADR-0096): a deletion saving is waited for and then seen, and nothing holding
a Property waits for the cost-admission lock. A deletion is one statement and
waits for nothing held here.

**Against the gate.** The gate takes the same cost-admission lock for the same
attempt, so the two are ordered; the gate's arm and this ending both require
the attempt `QUEUED`, so exactly one of them moves it. An attempt the gate
armed is never ended here, and an ended one is never armed.

**Against a writer that takes no such lock.** The attempt repository's own arm
is kept apart by the compare-and-set, as for the refused preparation's ending.

**What is written.** The attempt moves `QUEUED → CANCELLED_PRE_SUBMISSION`,
its `stateVersion` incremented, `normalizedErrorCode` set to
`PROPERTY_DELETED` and `normalizedErrorMessage` cleared, and one
`attempt.ended_property_deleted` event carrying the code as its reason and the
caller's actor and correlation. The compare-and-set and the event are the ones
the refused preparation's ending writes, now one function the two endings
share; only the code and the event type differ.

**Refusals write nothing.** `NOT_QUEUED`: no such attempt in the organization
(another tenant's id is answered the same, and nothing about it is said), or it
is no longer `QUEUED` before submission. `PROPERTY_NOT_DELETED`: its Property,
read under its lock, stands. Nothing restores a Property today, so the second
is a guard for a restore that may be built (ADR-0052 Decision 17), not a path
a test can reach through the product.

**No audit entry**, as for the refused preparation's ending and Transactions K
and L; the transition event is the record (`docs/decisions/TODO.md`, *A
preflight-failure audit event, if wanted, belongs to orchestration*).

## Decision 3 — Finding them

`findPropertyDeletedAttempts({ limit })` reads, without locks, the attempts
`QUEUED` before submission under a `GENERATING` request and job whose
attempt's project's Property is `DELETED`, each with its organization and job.
It offers **one attempt of each job**, the job's oldest, and the jobs in the
order of those attempts, oldest first by creation and then id, up to `limit`
(validated as the window's limit is). One is enough: once it ends, K fails the
job and L cancels the rest, so a job with many scenes does not fill a pass.
Until K runs, a later pass offers the job's next attempt, which is ended the
same way; that is the same outcome L would reach, with a truer code.

It mirrors the ending's refusals: a `QUEUED` attempt before submission, and a
deleted Property; so an attempt the ending would refuse is never offered and
cannot hold a place in it. The `GENERATING` request and job are discovery's
conditions, kept so the two read the same attempts; an attempt under a job
that already failed is L's to cancel.

## Decision 4 — The sender ends them

`AttemptSubmissionRunner.runOnce(limit, after)` now begins with a step of its
own:

1. **Deleted Properties' attempts.** Up to `limit` of them, from
   `findPropertyDeletedAttempts`, each ended with its own correlation. The
   ending's answer is the attempt's outcome: `ENDED` with `PROPERTY_DELETED`,
   `MOVED` when it was no longer `QUEUED`, or `NOT_SENT` with
   `PROPERTY_NOT_DELETED`. An ending that throws is that attempt's `FAILED`
   outcome, and the pass goes on.
2. **The window,** as before (ADR-0098), with one change: a gate that refuses
   an attempt as `SOURCE_INVALID` with `PROPERTY_DELETED`, a deletion saved
   since discovery, hands it to the same ending under the attempt's own
   correlation, rather than leaving it for the next pass. Every other refusal
   is reported and writes nothing, as before.

An attempt ended in either step marks its job as ending for the rest of the
pass, so none of the job's other attempts is sent in it, as for preparation's
refusal and the provider's (ADR-0098 Decision 5). `ended` counts both steps.
The cursor the pass returns still describes the window only.

## Decision 5 — Nothing runs it yet

`createAttemptSubmissionRepository` and `AttemptSubmissionRunner` have no
caller outside tests, and the static tests keep it so. The module and the
repository reach no provider, HTTP client or storage of their own and schedule
nothing; the repository writes one statement and locks only a Property, shared.
The pipeline command (GS-9) is what will run the sender, on the test provider
only.

## Not decided here

- **The gate's other refusals for good.** A price no contract will cover again
  (`PRICING_INELIGIBLE`) or an attempt not in a shape that could cross the
  boundary (`ATTEMPT_NOT_ARMABLE`) still writes nothing, so such an attempt
  holds its Unit (`docs/decisions/TODO.md`, *End an orchestrated attempt the
  gate will never authorize*).
- **How long an attempt refused for configuration may hold its Unit**: no
  authorized route, the profit Safety Guard's pause or no revenue figure. By
  the proposal these wait, as a waiting job refused for configuration does
  (ADR-0099 Decision 1); the bound must be decided before generation is
  activated.
- **How the customer is shown an ended video.** Nothing shows a job's state to
  a customer yet; the progress page is GS-10's and GS-11's. Its wording must
  not name a provider or a model.
- **A restored Property** (ADR-0099, *Not decided here*): its ended videos are
  started again by the customer, at no loss, since their Units were returned.
- **Whether an ended attempt warrants an audit entry** (Decision 2).

## Consequences

- `@app/domain`: in the `attempt-submission` module,
  `PROPERTY_DELETED_ATTEMPT_CODE`, `ATTEMPT_ENDED_PROPERTY_DELETED_EVENT_TYPE`,
  the `AttemptEndingReason` type, and on `AttemptSubmissionRepository`
  `findPropertyDeletedAttempts` and `endPropertyDeletedAttempt` with their
  query, input and outcome types (`PropertyDeletedAttempt`,
  `PropertyDeletedAttemptQuery`, `EndPropertyDeletedAttemptInput`,
  `EndPropertyDeletedAttemptOutcome`). The runner's `ENDED` and `MOVED`
  outcomes carry an `AttemptEndingReason`, and `NOT_SENT` gains
  `PROPERTY_NOT_DELETED`.
- `@app/database`: `createAttemptSubmissionRepository(prisma)` implements the
  two methods; its two endings share one compare-and-set.
- No migration. Nothing outside tests constructs the repository or the runner,
  so no path a customer or a worker reaches changes.
