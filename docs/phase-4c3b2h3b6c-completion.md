# Phase 4C-3B-2H-3B-6C — Durable media-failure resolution and customer-safe settlement

Decision record: `docs/decisions/0048-durable-media-failure-resolution-and-settlement.md`.

Phase 6B admitted one automatic recovery for a terminal media failure and
stopped. This phase closes what stopping there left open: a planning refusal
that was treated as an answer, and an exhausted recovery that settled nothing.

Production resolution is **not** active. Nothing constructs the coordinator,
schedules it, or calls it, and no provider is called.

## What this phase adds

- **`ManagedOutputMediaFailureResolution`** (migration 13) — durable work per
  terminal media verdict, with a lease, a retry instant and a closed refusal
  vocabulary.
- **`MediaFailureResolutionRunner`** — the single dormant coordinator.
- **Transaction H** (`settleExhaustedMediaFailure`) — every customer consequence
  of an exhausted failure in one commit.
- **Atomic revision start** — `admitUserRegeneration` now moves the Scene and the
  Job as well as creating the request.
- **`cost-admission-lock.ts`** — one advisory-lock key formula instead of four.

## The business fact

```text
terminal media verdict (INVALID_MEDIA | INTEGRITY_MISMATCH)
  └─ durable resolution work, discovered lazily
       ├─ PRIMARY, no recovery      -> plan -> admit ONE SYSTEM_RECOVERY
       ├─ PRIMARY, recovery exists  -> reconcile to that exact attempt
       ├─ the recovery's own failure-> Transaction H
       └─ nothing owed              -> OBSOLETE

planning refused            -> PENDING + nextAttemptAt, invisible until due
```

### Sequence — an exhausted INITIAL failure

```mermaid
sequenceDiagram
  participant R as MediaFailureResolutionRunner
  participant W as resolution work
  participant P as pricing planner
  participant H as Transaction H

  R->>W: findResolutionCandidates(now, limit)
  W-->>R: oldest-first, deferred rows absent
  R->>W: claim(validationId, lease)
  W-->>R: CLAIMED { disposition: SETTLE_EXHAUSTED }
  Note over R,P: no planning: nothing is being retried
  R->>H: settleExhaustedMediaFailure(claim, settledAt)
  H->>H: advisory lock -> reservation -> job -> scene -> request -> attempt -> validation -> work
  H->>H: request/scene/job FAILED_TERMINAL, reservation RELEASED, work RESOLVED
  H-->>R: SETTLED { INITIAL_FAILURE_SETTLED }
```

## Fairness: deferral, *and* eligibility ordering

A refusal is recorded on the work row with a future `nextAttemptAt`, and
discovery excludes `PENDING` work that is not yet due. An unplannable candidate
therefore stops *being* a candidate for a retry delay.

**Deferral alone is not enough, and review found the gap.** It only helps while
the next scheduler pass happens *before* the retry comes due. With a five-minute
retry and a ten-minute scheduler, every deferred row is eligible again by the
next pass — and if candidates are ordered by `validatedAt`, the same old prefix
is still the oldest and fills the bounded batch again, forever.

So discovery orders by **effective eligibility instant**, not verdict age:

```text
CASE WHEN no work row  THEN validation.validatedAt
     WHEN PENDING      THEN work.nextAttemptAt
     WHEN RUNNING      THEN work.leaseExpiresAt
END ASC, validation.validatedAt ASC, validation.id ASC
```

Each arm uses the column that actually made the row eligible. A deferral now
moves the row's *place in the queue*, so it sorts behind everything that has
been waiting since before its new retry instant. The `RUNNING` arm matters for
the same reason: a row whose owner died has been waiting only since the lease
expired, however old the verdict beneath it is.

`tests/integration/media-failure-resolution.db.test.ts` proves all three
properties end to end: the immediate-pass case; the **slow-scheduler** case,
where the second pass happens at `retryDelay + 1s` with the whole prefix
eligible again and a single batch slot still goes to the actionable candidate;
and the reclaimable case, where a lease that expired a second ago queues behind
a newer verdict that has been waiting since September. Repeated deferral is
shown to keep pushing `nextAttemptAt` forward rather than parking a row.

## Settlement

| | INITIAL | USER_REGENERATION |
| --- | --- | --- |
| Request | `GENERATING -> FAILED_TERMINAL`, `failedAt` set | same |
| Scene | `GENERATING -> FAILED_TERMINAL` | `REVISING -> READY`, pointer unchanged |
| Job | `GENERATING -> FAILED_TERMINAL` | `GENERATING -> DELIVERABLE_READY`, pointer unchanged |
| Reservation | `RESERVED`/`RECONCILIATION_HOLD -> RELEASED` | `CONSUMED`, untouched |
| Work | `RESOLVED / INITIAL_FAILURE_SETTLED` | `RESOLVED / USER_REGENERATION_ROLLED_BACK` |
| Unit | never consumed | never refunded |

`failedAt`, `releasedAt` and `resolvedAt` are the **same instant**, because this
is one business fact rather than several events that happened to be close
together.

Settlement is authorized only by the *recovery's own* failure — latest attempt,
`attemptKind = SYSTEM_RECOVERY`, `OUTPUT_VERIFIED`, terminal verdict,
receipt-bound, `systemRecoveryCount >= 1`. A `PRIMARY` failure that merely has a
recovery sibling is already answered, and terminalizing from it would fail a
customer whose retry is still in flight.

## Locks

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

The advisory lock is first and the reservation second, matching the paid
submission gate exactly. That ordering is the point: settlement releases a
reservation, which is the mutation the gate protects itself against.

`tests/integration/media-failure-settlement-races.db.test.ts` holds that exact
advisory lock from a third connection, waits until both an authorization and a
settlement are genuinely blocked on it (`pg_stat_activity`, not a sleep), then
releases it and asserts the invariant: no still-queued attempt crosses the
submission boundary after the hold behind it was released. A companion test
proves the gate refuses outright once the hold is gone.

## Revision start

```text
lock Job -> lock Scene
  Job DELIVERABLE_READY + deliverable version, Reservation CONSUMED
  Scene READY + a DELIVERED predecessor of its own
  no active USER_REGENERATION anywhere in the Job
  create request PENDING (ordinal derived)
  Scene READY -> REVISING
  Job DELIVERABLE_READY -> REVISING -> GENERATING
```

Four events in one commit, including **both** job moves. Externally the
committed state is `GENERATING`; the history still records how it got there.

The Job row is the one-active-regeneration mutex: admission moves the Job away
from `DELIVERABLE_READY`, so a second revision on any scene finds a Job that is
no longer revisable. This resolves the carried-forward `REVISING -> GENERATING`
actor concern from Phases 6A and 6B.

## Abandoning a pending revision

Revision start commits three aggregates together, so anything that ends a
revision must move the same three together. Review found the escape: the generic
request transition still allowed a `USER_REGENERATION` in `PENDING` to reach
`CANCELLED` or `FAILED_TERMINAL` on its own, which strands

```text
request  CANCELLED / FAILED_TERMINAL   <- nothing left to advance
Scene    REVISING                      <- no active request
Job      GENERATING                    <- not deliverable, not failed
```

with no safe repair authority afterwards.

Both edges are now **kind-aware reserved** — the only kind-aware rule in the
file, and the kind is read from the stored row rather than taken from the
caller. An `INITIAL` request still reaches both states generically, because
abandoning one strands nothing.

`rollBackPendingUserRegeneration` owns them. It locks Job → Scene → Request,
requires a `PENDING` regeneration with **zero attempts** (once an attempt exists
a provider may hold the work, and the ending belongs to Transaction H, which has
a media verdict to justify it), and in one commit:

| Row | Effect |
| --- | --- |
| Request | `PENDING -> CANCELLED` or `-> FAILED_TERMINAL`, `failedAt` only for the latter |
| Scene | `REVISING -> READY`, `currentDeliveredRequestId` **unchanged** |
| Job | `GENERATING -> DELIVERABLE_READY`, `currentDeliverableVersionId` **unchanged** |
| Reservation | `CONSUMED`, not written at all — not even a version bump |

No attempt, no quota event, no deliverable event. The entitlement is untouched,
so the same ordinal is immediately reusable — proved by starting a second
revision at ordinal 1 straight after a rollback. Exact replay is
`ALREADY_ROLLED_BACK` with nothing changed; a partial shape raises rather than
being repaired.

## Reserved edges

The generic transition APIs now refuse every edge an atomic primitive owns —
Job `GENERATING -> SCENES_READY`, `DELIVERABLE_READY -> REVISING`,
`REVISING -> GENERATING`, `GENERATING -> DELIVERABLE_READY`; Scene
`GENERATING -> READY`, `READY -> REVISING`, `REVISING -> READY` — alongside the
edges already reserved. `FAILED_TERMINAL` stays generic, because other failure
workflows legitimately use it.

`GENERATING -> DELIVERABLE_READY` is simultaneously **legal** in the pure state
machine and **reserved** from the repository. Those are different questions, and
they are tested separately: deleting the edge to express an access rule would
remove a real move from the domain.

## Schema

One migration, `00000000000013_phase4c3b2h3b6c_media_failure_resolution`. One
table, three enums, three CHECK constraints, two RESTRICT foreign keys. Nothing
reads, rewrites or seeds an existing row; migrations 1–12 are untouched. A
static test asserts the migration contains no `UPDATE "`, `INSERT INTO`,
`DELETE FROM` or `SELECT`.

## Freeze

Settlement creates **zero** new attempts. The failed recovery attempt, its output
receipt, its media verdict and its pricing snapshot are immutable historical
evidence, and the tests compare those rows *whole* before and after rather than
column by column. No quota moves, no composition, no deliverable event, no
provider call, no credential.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | pass, 0 errors |
| `pnpm lint` | pass, 0 problems |
| `pnpm test` | **4332 passed**, 133 files |
| `pnpm test:db` (live PostgreSQL) | **975 passed**, 31 files |
| `pnpm build` | pass |
| `prisma validate` / `format` | pass, no schema diff |
| Migrations 1–13 on a fresh empty database | pass |
| Migration drift | `No difference detected` |

## Mutation ledger

This section states what was actually run. It is deliberately not rounded up to
a clean "213 / 213", because no single complete run produced that.

### First complete run — ten survivors

The first complete ledger against the corrected production tree reported **213
run, 203 killed, 10 survivors, 0 anchor-missing**. Every one of the ten was a
real gap, and they fell into four groups:

- **Three duplicated or unreachable guards** — a finding about the code, not the
  tests. The `PRIMARY with an existing recovery` branch in `classify` was proved
  *unreachable*: a recovery always carries a higher ordinal than the PRIMARY it
  retries, so "a recovery exists" and "this PRIMARY is superseded" are the same
  condition and the superseded branch answers first. It was deleted. The
  `attemptKind` check in the settlement authority is redundant with the recovery
  count beside it, and the receipt-binding gate exists twice — once at claim
  classification, once inside the settlement check — so removing either site
  alone was invisible. Those two mutations now remove both sites.
- **One test reading prose.** The dormancy suite asserted the settlement lock
  clause with `toContain` against the raw file, and the doc comment above
  `lockSettlementChain` quotes that exact clause, so deleting the real SQL left
  the assertion passing on a comment. It now strips comments first.
- **One mis-classified kill mode.** The transition tables are plain arrays, so
  deleting an entry is well-typed; the mutation was re-aimed from `typecheck` to
  `tests`.
- **Five missing tests**, since written.

### Second complete run — one survivor

After those corrections the complete ledger was run again against the final
production tree: **213 run, 212 killed, 1 survivor, 0 anchor-missing**.

The survivor was **M210** — "revision start no longer locks the job, losing the
one-at-a-time mutex", which deletes `FOR UPDATE OF j, s` from
`lockJobAndSceneForTenant`.

**M210 was timing-dependent, not un-killable.** The same mutation was *killed* in
the first complete run and *survived* in the second, with nothing about it or
its anchor changed in between. The concurrency regression raced two revisions on
the *same* scene and accepted whatever order the connection pool produced: when
the two serialized, the second simply read the first's committed `PENDING`
regeneration and returned `REGENERATION_ALREADY_ACTIVE`, so the test passed
without either caller reaching the Job authority together.

### The M210 correction — test-only

**Production locking behaviour was not changed.** The fault was in the
regression, so the regression was rewritten:

- two **different** `READY` scenes in one `DELIVERABLE_READY` job, each with its
  own `DELIVERED` predecessor and a `CONSUMED` reservation;
- three independent Prisma clients — holder, worker A, worker B;
- the holder takes `SELECT "id" FROM "generation_jobs" WHERE "id" = $1 FOR UPDATE`
  **before** either worker starts, and is released in a `finally` path so a
  failing assertion cannot strand the row;
- `pg_stat_activity` is polled purely as an *observation* that at least two
  backends are waiting on a PostgreSQL lock — the row lock is the ordering
  authority, never the polling interval;
- both calls must **fulfil**, resolving to exactly one `ADMITTED` and one
  `JOB_NOT_REVISABLE`. A rejected promise, a uniqueness error or an
  `INTERNAL_ERROR` is a failure.

**Measured determinism:**

| Proof | Result |
| --- | --- |
| Corrected regression, unmutated implementation | **10 consecutive passes** |
| M210 targeted mutation, independent runs | **5 consecutive kills**, 0 survivors, 0 anchor-missing |

**Exact kill reason**, captured by instrumenting one mutated run: with M210 the
contention is real — `bothBlocked` observes two blocked backends — and the
failing assertion is `expect(a.ok && b.ok).toBe(true)`, because one worker's
promise **rejects**:

```text
REJECTED: AppError: A locked orchestration transition matched no row
                    while holding that row's lock
ADMITTED
```

That is precisely the designed mechanism: without the Job lock both workers pass
the `DELIVERABLE_READY` precondition on a plain read, both create their request
on their own scene, and both reach the Job `UPDATE`; one wins and the other
matches zero rows and throws instead of returning the application-owned outcome.

### PR #69 review correction — impacted mutation set

Exact-head review found two further blockers: the pending-regeneration terminal
escape above, and the slow-scheduler fairness gap. Both were corrected, and the
**42 existing mutations targeting the two changed production files** were re-run
together with **14 new ones** (M213–M226) covering both generic escapes, the
kind check itself, Scene and Job rollback omission, both pointer mutations,
reservation release, entitlement consumption, the attempt guard, partial-rollback
repair, and all three ordering regressions. M210 was included once.

The first impacted run reported **56 run, 54 killed, 2 survivors** — two more
real test gaps, not harness artefacts:

- **M222** — the attempt guard was never decided by a test, because attempt
  admission also moves the request `PENDING -> GENERATING` and the state check
  answered first. The guard defends a state the system believes it cannot
  produce, so the new test manufactures it: admit normally, then force the
  request back to `PENDING`.
- **M225** — the `RUNNING` arm of the ordering had no test at all. The new case
  gives the oldest verdict a lease that expired a second ago and asserts it
  queues behind a newer verdict that has genuinely been waiting.

After those, the impacted set is **56 run, 56 killed, 0 survivors, 0
anchor-missing**, with **M210 KILLED**. Restoration was proved against a fresh
SHA-256 snapshot taken with the corrected tests in place: **zero mismatches**
across 482 files.

No schema change: migration 13 is untouched and `git diff` over
`packages/database/prisma/` is empty.

### No third complete ledger

By explicit CTO authorization, a third 213-mutation run was **not** performed.
The production tree, the mutation definitions and the other 212 kill proofs are
all unchanged by a test-only correction, and strengthening one regression cannot
invalidate a kill proof for a different mutation.

**Honest summary:** the complete corrected-production ledger result is
**213 run, 212 killed, 1 survivor, 0 anchor-missing**. All 213 mutation
definitions now have a kill proof on the final production implementation, with
M210 closed by the deterministic test-only correction above.

Restoration for the targeted M210 runs was proved against a **fresh** SHA-256
snapshot taken after the test correction was in place and before the mutation
was injected: **zero mismatches** across 482 files, with `git status --short`
showing only the corrected test and `git diff --check` clean.

## Not done, on purpose

Concurrent revision cycles, revision-cycle identity, a durable
deliverable-composition record, quota `CONSUME` (Transaction G), composition,
production scheduler/cron/worker, FX network integration, provider execution,
`FAL_KEY` or AWS credential wiring.

## Carried forward

- **Production activation is a separate reviewed decision.** A scheduler must be
  designed with the retry delay and batch size reviewed against real failure
  volume.
- **A real FX source** must sit behind `FxRateSource` before any recovery can be
  planned in production.
- **Transaction G** remains deferred. This phase may RELEASE a hold but never
  CONSUME one, and the delivery path its rollback returns jobs to still ends at
  `DELIVERABLE_VALIDATING -> DELIVERABLE_READY`, which Transaction G owns.
- **Concurrent revisions** stay refused until a revision-cycle model exists.
