# ADR-0048 — Durable media-failure resolution and customer-safe settlement

Status: Accepted (Phase 4C-3B-2H-3B-6C)
Supersedes: nothing. Extends ADR-0047.

## Context

Phase 6B gave a durable terminal media failure exactly one consequence: a single
automatic `SYSTEM_RECOVERY` attempt under the same request. It deliberately
stopped there, and stopping there left two holes that this phase closes.

**A planning refusal was an answer.** The 6B runner reported `NO_PLAN` and moved
on. Nothing durable recorded that the candidate had been looked at, so the next
bounded oldest-first sweep offered the same rows again. A prefix of unplannable
candidates could therefore occupy every pass indefinitely while newer,
actionable failures sat behind them — the fairness concern 6B carried forward.

**An exhausted recovery settled nothing.** When the one automatic retry also
came back as unusable media, 6B returned `RECOVERY_LIMIT_REACHED` and the
customer's request stayed `GENERATING` forever with a reservation still held.

---

## Decision 1 — `NO_PLAN` defers, and never terminalizes

A planning refusal is almost never a verdict about the customer. The four
refusal codes cover an FX source that is unreachable, a rate card that is
mid-replacement, a rate-card ambiguity under repair, and a model withdrawn for
an afternoon. Every one of those is the *platform's* configuration being
temporarily inconsistent.

Terminalizing a customer's job for any of them would charge the platform's
outage to the customer, and would do it irreversibly: `FAILED_TERMINAL` has no
outgoing edge.

So a refusal moves the work row `RUNNING -> PENDING`, records
`lastPlanRefusalCode`, sets `nextAttemptAt` to a future instant, clears the
lease and bumps `version`. The default delay is five minutes. It is a **work**
retry delay, not a provider retry delay: nothing is called while the row waits.

## Decision 2 — Durable work, discovered lazily, with a lease

The resolution work is a one-to-one row against `ManagedOutputMediaValidation`
with three states (`PENDING`, `RUNNING`, `RESOLVED`) and four resolution kinds
(`RECOVERY_ADMITTED`, `INITIAL_FAILURE_SETTLED`, `USER_REGENERATION_ROLLED_BACK`,
`OBSOLETE`).

It is created the first time a worker claims a failure, never in the
media-validation completion transaction and never by a backfill. An absent row
is an eligible state, not a gap — the same choice ADR-0046 made for validation
records themselves, and for the same reason: backfilling would be inventing a
resolution for a failure nobody has looked at.

The lease is crash recovery, not a deadline: five minutes by default, an hour at
most, no heartbeat. Every write after a claim carries the claim's `version` and
`leaseToken`, so a stale worker's late finalize matches zero rows.

The first claim uses `INSERT ... ON CONFLICT DO NOTHING RETURNING`. A unique
violation would abort the PostgreSQL transaction (`25P02`), so catching the
driver error and continuing to query the same transaction is not recovery — the
only safe shape is an insert that never raises, leaving the loser free to read
what the winner wrote.

## Decision 3 — Deferral is the fairness mechanism

Discovery excludes `PENDING` work whose `nextAttemptAt` has not arrived. That
single predicate is the whole solution: an unplannable candidate stops being a
candidate for a retry delay, so the bounded oldest-first window moves past it to
work that can actually be done, and returns to it when it is due.

No unbounded scan, no priority queue, no second index to keep in step. A live
regression drives more unplannable candidates than the batch holds and proves an
actionable candidate behind them is reached on the next pass, and that the
deferred work is not lost.

## Decision 4 — One orchestration authority

Phase 6B's runner is **deleted**, not wrapped. Two runners would leave two
things a composition root could wire, and the one it would most plausibly wire
is the one without the deferral. What survives from 6B is the *step* — the same
planner, the same `admitAutomaticMediaRecovery` transaction, the same cap — with
`MediaFailureResolutionRunner` deciding when to invoke them.

## Decision 5 — Automatic recovery and terminal settlement are different answers

The claim classifies one failure into exactly one disposition:

```text
PRIMARY failure, no recovery yet        -> ADMIT_RECOVERY
PRIMARY failure, a recovery exists      -> RECONCILE_RECOVERY
the recovery's own failure              -> SETTLE_EXHAUSTED
nothing is owed                         -> OBSOLETE
```

Settlement is authorized **only** by the recovery's own failure. A `PRIMARY`
failure that merely has a recovery sibling is already answered — the recovery is
running, or has itself failed and is the row that will settle — and
terminalizing from it would fail a customer whose retry is still in flight.

## Decision 6 — `INITIAL` failure: fail everything, release the hold

The customer received nothing, so:

```text
request  GENERATING -> FAILED_TERMINAL   failedAt   = settlement instant
scene    GENERATING -> FAILED_TERMINAL
job      GENERATING -> FAILED_TERMINAL
reservation RESERVED | RECONCILIATION_HOLD -> RELEASED
                                         releasedAt = same instant
work     RUNNING -> RESOLVED             resolvedAt = same instant
```

One instant across all four rows, because this is one business fact rather than
four events that happened to be close together.

**No Unit is consumed.** That is the commercial rule the phase exists for: a
provider or system failure does not spend the customer's entitlement.

Sibling scenes are deliberately not cascaded over. The failed Job is the
aggregate-level terminal result; other scene and attempt history stays as
historical evidence, and the Job's terminal state is what stops Transaction F
and recovery admission from touching it afterwards.

## Decision 7 — `USER_REGENERATION` failure: roll back, keep the video

The customer still holds a delivered video, so almost nothing fails:

```text
request  GENERATING -> FAILED_TERMINAL   failedAt = settlement instant
scene    REVISING   -> READY             currentDeliveredRequestId UNCHANGED
job      GENERATING -> DELIVERABLE_READY currentDeliverableVersionId UNCHANGED
reservation CONSUMED -> CONSUMED         not even a version bump
```

The delivered pointer is the customer's video, and this transaction never writes
it. The previous deliverable remains the customer-visible product.

## Decision 8 — A consumed reservation is never released for a failed regeneration

`CONSUMED -> RELEASED` is not a transition this phase may make. The consumed
hold belongs to the video that was already delivered; releasing it would refund
a Unit that already produced something the customer can watch, and would do so
because a *later, additional* request failed.

## Decision 9 — A failed regeneration consumes no entitlement

The existing rule is unchanged: a regeneration right is spent on **delivery**.
A failed regeneration has `deliveredAt = null`, so `usedUserRegenerationCount`
does not move and the same ordinal becomes available again. No counter column
was added; the derivation is the authority.

## Decision 10 — One active regeneration per Job, for the MVP

This is a schema limitation stated honestly, not a product preference.

There is no revision-cycle identity and no durable mapping from the current
deliverable version to the exact scene request versions composed into it. With
two revisions in flight and one failing, this shape is ambiguous:

```text
scene A regeneration succeeds
scene B regeneration fails
```

Nothing can prove whether returning the Job to its previous `DELIVERABLE_READY`
version would discard A's valid replacement, or whether a mixed version should
be composed. Inventing a revision-cycle model to answer that inside a settlement
transaction would be guessing at a product decision.

So revision is serialized at the Job boundary instead, and the Job row is the
mutex: admission moves the Job away from `DELIVERABLE_READY`, so a second
revision on any scene finds a Job that is no longer revisable. Settlement
additionally fails closed with `CONCURRENT_REVISION_AMBIGUOUS` if it ever meets
the shape anyway.

Concurrent revision cycles are deferred, deliberately and in writing.

## Decision 11 — Revision start becomes one atomic fact

`admitUserRegeneration` created a request and left the Job and Scene transitions
to an actor that was never written — the concern Phases 6A and 6B both carried
forward. It is now the whole revision-start fact, in one commit:

```text
lock Job -> lock Scene
  require Job DELIVERABLE_READY + a deliverable version, reservation CONSUMED
  require Scene READY + a DELIVERED predecessor of its own
  require no active USER_REGENERATION anywhere in the Job
  create the request PENDING (ordinal derived, never nominated)
  Scene READY -> REVISING          (delivered pointer untouched)
  Job DELIVERABLE_READY -> REVISING -> GENERATING
```

A later Transaction C `PRIMARY` admission moves the request `PENDING ->
GENERATING` as it already did. No provider attempt is admitted here.

## Decision 12 — Two Job events in one transaction, rather than a new edge

The revision lifecycle is `DELIVERABLE_READY -> REVISING -> GENERATING`. Both
moves are real and both are recorded. Inventing a direct
`DELIVERABLE_READY -> GENERATING` edge to save one event would put a semantic
edge in the state machine that exists only to describe an implementation
shortcut. Externally the committed state is `GENERATING`; the history still says
how it got there.

## Decision 13 — Transaction H, and its lock order

Every customer consequence of an exhausted media failure is one repository
operation. Never `failRequest()` then `failScene()` then `failJob()` then
`releaseReservation()` across separate commits: that is four crash boundaries
whose half-applied states nobody can repair afterwards.

```text
cost-admission advisory lock
  -> GenerationReservation   FOR UPDATE
  -> GenerationJob           FOR UPDATE
  -> GenerationScene         FOR UPDATE
  -> SceneGenerationRequest  FOR UPDATE
  -> SceneGeneration         FOR UPDATE
  -> ManagedOutputMediaValidation FOR UPDATE
  -> resolution work row     FOR UPDATE
```

The billing-cycle key is read before the advisory lock, which is safe because a
reservation's cycle is frozen when the hold is taken and never recomputed.

The work row is resolved **inside** this commit. Resolving it afterwards would,
on a crash between the two, leave a claimable work item pointing at a job that
has already been settled.

## Decision 14 — The cost-admission lock became one primitive

Settlement releases a reservation, which is exactly the mutation the paid
submission gate protects itself against:

```text
T1  lock cycle -> read reservation RESERVED -> gate permits
T2                UPDATE reservation -> RELEASED, commit
T1  arm QUEUED -> SUBMITTING, commit      <- paid against a released hold
```

The two-key `pg_advisory_xact_lock` formula existed in four repositories, each
with its own copy. Four copies of a lock *key* is not four copies of a helper:
two workflows that disagree by one character take different locks and silently
stop serializing. It is now one module, `cost-admission-lock.ts`, private to
`@app/database` — a caller outside the package would hold the lock without the
transaction that gives it meaning.

A deterministic live-PostgreSQL regression forces an authorization and a
settlement onto that lock, waits until both are genuinely blocked on it, and
proves no queued attempt crosses the submission boundary after the hold behind
it was released.

## Decision 15 — `GENERATING -> DELIVERABLE_READY` is legal, and reserved

The rollback edge is added to the pure Job state machine, because it is a real
move: a failed revision must be able to give the customer back the video they
already had. Deleting it to express an access rule would remove a real edge from
the domain.

It is simultaneously reserved from the generic Job repository, which returns
`TRANSITION_RESERVED`. *Legal* and *who may persist it* are different questions,
and the phase tests them separately.

## Decision 16 — The generic transition APIs close their remaining escape hatches

While reserved edges were being touched, the routes that specialized
transactions already owned were closed:

| Aggregate | Edge | Owner |
| --- | --- | --- |
| Job | `RESERVING -> RESERVED` | Transaction B |
| Job | `GENERATING -> SCENES_READY` | Transaction F |
| Job | `DELIVERABLE_READY -> REVISING` | revision start |
| Job | `REVISING -> GENERATING` | revision start |
| Job | `GENERATING -> DELIVERABLE_READY` | Transaction H |
| Job | `DELIVERABLE_VALIDATING -> DELIVERABLE_READY` | Transaction G (deferred) |
| Scene | `GENERATING -> READY` | Transaction F |
| Scene | `READY -> REVISING` | revision start |
| Scene | `REVISING -> READY` | Transaction F or Transaction H |
| Request | `PENDING -> GENERATING` | Transaction C |
| Request | `GENERATING -> DELIVERED` | Transaction F |
| Reservation | `-> CONSUMED` | Transaction G (deferred) |

`FAILED_TERMINAL` transitions are deliberately **not** reserved globally: other
failure workflows legitimately use them.

## Decision 17 — Idempotency, and never repairing a partial settlement

A repeated settlement of the exact already-settled shape returns
`ALREADY_SETTLED` and changes no version, event or timestamp. Every row must
match: request, scene, job, reservation, pointer and the work row's own
resolution kind.

A partial match raises `PARTIAL_SETTLEMENT` and is never finished quietly. Half
an applied settlement means an invariant this application believes it cannot
violate was violated, and completing the job would destroy the evidence of how.

## Decision 18 — Migration 13, and no backfill

One new table, three new enums, and shape constraints in the database rather
than only in TypeScript: each status admits exactly one arrangement of the
lease, retry and terminal columns, and only `RECOVERY_ADMITTED` may name a
recovery attempt — and must.

Nothing in the migration reads, rewrites or seeds an existing orchestration row.
Migrations 1–12 are untouched.

## Consequences

Good:

- A planning refusal can no longer starve later work, and can no longer
  terminalize a customer for the platform's own inconsistency.
- An exhausted media failure now has a customer-visible answer, applied once and
  atomically, with the Unit returned when nothing was delivered.
- The `REVISING -> GENERATING` actor that 6A and 6B both deferred exists.
- One advisory-lock key formula instead of four.

Accepted costs:

- **Concurrent revision cycles are not supported.** A second revision anywhere
  in a Job is refused until the first resolves. Removing this needs a
  revision-cycle model and a durable deliverable-composition record.
- **Still dormant.** Nothing constructs, schedules or invokes the coordinator.
  Production activation is a separate reviewed decision.
- **No quota movement.** Transaction G remains deferred; this phase may RELEASE
  a hold but never CONSUME one.

Remaining before production activation:

- A scheduler or worker that runs the coordinator, with an operational review of
  the retry delay and batch size against real failure volume.
- A real FX source behind `FxRateSource`.
- Transaction G, for the delivery path this phase's rollback returns jobs to.
