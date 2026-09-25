# Phase 5A — Durable deliverable composition plan and atomic composition admission

Decision record: `docs/decisions/0049-durable-deliverable-composition-plan.md`.

Phase 6C ends a generation cycle with every Scene `READY`, the Job
`SCENES_READY`, and each Scene's `currentDeliveredRequestId` naming the rendition
the customer is entitled to see. This phase answers the next question durably:

> exactly which immutable scene renditions belong to the next customer
> deliverable?

**Nothing is composed.** No `ffmpeg`, no `ffprobe`, no object store, no HTTP, no
final deliverable object, no unit consumed. The plan is inert until Phase 5B
wires an actor to it.

## Gap analysis — what was missing before this phase

| gap | consequence | closed by |
| --- | --- | --- |
| No durable record of which renditions make up a deliverable | a restarted composition re-derives the selection from live rows, which move under regeneration and rollback | `GenerationDeliverableVersion` + `GenerationDeliverableInput` (Decisions 1, 2) |
| No deliverable identity at all | a job cannot have a *history* of deliverables, so recomposition has nothing to be the successor of | job-scoped `ordinal`, derived `MAX + 1` under the job lock (Decision 1) |
| `GenerationJob.currentDeliverableVersionId` carried no foreign key | a job could name a nonexistent version, or another job's | composite FK through `UNIQUE(id, generationJobId)` (Decision 10) |
| `SCENES_READY` had no outgoing actor | a job finished generating and stopped there | Transaction I, `SCENES_READY -> COMPOSITION_PENDING` (Decision 7) |
| `COMPOSITION_PENDING -> COMPOSING` and `COMPOSING -> DELIVERABLE_VALIDATING` were generically writable | a caller could walk a job to `DELIVERABLE_VALIDATING` with no bytes produced | both reserved ahead of their owners (Decision 13) |
| No way to prove two plans equal, or a plan unchanged | no comparison between two attempts at the same video | `sha256:deliverable-input:v1:` fingerprint (Decision 6) |

## What this phase adds

- **`GenerationDeliverableVersion`** (migration 14) — durable deliverable
  identity: job-scoped ordinal, input fingerprint, created instant.
- **`GenerationDeliverableInput`** — one immutable row per Scene in the version,
  naming the Scene, the delivered request, the latest verified attempt, the
  `VALID` media verdict, and the frozen receipt of the bytes selected.
- **Transaction I** (`admitCompositionPlan`) — the version, every input row, the
  `DELIVERABLE` event, the Job move and the Job event, in one commit.
- **`computeDeliverableInputFingerprint`** — a new versioned hash vocabulary,
  deliberately distinct from the storyboard fingerprint and the request hash.
- **The composite foreign key** that finally binds
  `GenerationJob.currentDeliverableVersionId` to a version of the *same* job.
- **Three more reserved job edges** on the generic transition API.

## The business fact

```text
Job SCENES_READY
  └─ for every GenerationScene, in position order:
       scene.state = READY
       scene.currentDeliveredRequestId -> request.state = DELIVERED  (same scene)
         └─ latest attempt by MAX(attemptOrdinal), OUTPUT_VERIFIED
              └─ media verdict VALID, receipt == attempt receipt

  └─ cycle authority:
       initial        pointer null      + reservation RESERVED
       recomposition  pointer non-null  + reservation CONSUMED

  => GenerationDeliverableVersion (ordinal = MAX + 1)
     + one GenerationDeliverableInput per scene
     + DELIVERABLE event  null -> PLANNED
     + Job SCENES_READY -> COMPOSITION_PENDING (+ event)

  currentDeliverableVersionId: UNCHANGED
```

### Sequence — an initial composition plan

```mermaid
sequenceDiagram
    participant C as Caller (dormant)
    participant T as Transaction I
    participant DB as PostgreSQL

    C->>T: admitCompositionPlan(org, jobId, versionId, ctx)
    T->>DB: SELECT job JOIN project LEFT JOIN reservation FOR UPDATE OF j
    DB-->>T: SCENES_READY, pointer null, hold RESERVED, frozen target
    Note over T: replay? job is not COMPOSITION_PENDING → no
    Note over T: cycle? null + RESERVED → INITIAL
    T->>DB: SELECT scenes ORDER BY position, id FOR UPDATE
    T->>DB: SELECT selected requests + latest attempts FOR UPDATE OF r, a
    T->>DB: SELECT full candidacy per scene (outer joins)
    Note over T: per-scene proofs; any failure → NOT_ELIGIBLE, nothing written
    Note over T: fingerprint over the ordered set + frozen target
    T->>DB: MAX(ordinal) → 0 ⇒ ordinal 1
    T->>DB: INSERT deliverable version
    T->>DB: INSERT one input row per scene
    T->>DB: INSERT DELIVERABLE event (null → PLANNED)
    T->>DB: UPDATE job SCENES_READY → COMPOSITION_PENDING (CAS on version)
    T->>DB: INSERT JOB event
    T->>DB: SELECT currentDeliverableVersionId  (must be unchanged)
    DB-->>T: null
    T-->>C: PLANNED(versionId, ordinal 1, fingerprint)
```

## Entity relationships added

```mermaid
erDiagram
    GenerationJob ||--o{ GenerationDeliverableVersion : "has versions"
    GenerationJob |o--o| GenerationDeliverableVersion : "currentDeliverableVersionId (same job, composite FK)"
    GenerationDeliverableVersion ||--|{ GenerationDeliverableInput : "freezes"
    GenerationScene ||--o{ GenerationDeliverableInput : "appears once per plan"
    SceneGenerationRequest ||--o{ GenerationDeliverableInput : "selected rendition"
    SceneGeneration ||--o{ GenerationDeliverableInput : "source attempt"
    ManagedOutputMediaValidation ||--o{ GenerationDeliverableInput : "media authority"
```

Every foreign key above is `ON DELETE RESTRICT`. This names paid generated
history end to end, so a physical deletion must resolve retention policy
deliberately rather than cascading it away.

## Authorities, and what was deliberately not used

| decision | authority | rejected alternative |
| --- | --- | --- |
| which rendition | `GenerationScene.currentDeliveredRequestId` | newest request by `createdAt`; highest regeneration ordinal; newest successful request |
| which attempt | `MAX(attemptOrdinal)` | `createdAt` — two attempts in one millisecond have no order |
| media validity | durable `ManagedOutputMediaValidation.status = VALID` with `validatedAt` | re-probing; trusting `OUTPUT_VERIFIED` alone |
| these bytes | `receiptSha256`/`receiptSizeBytes` == attempt's verified receipt | assuming the verdict is about the current object |
| which cycle | pointer + reservation state together | either one alone |
| the ordinal | `MAX + 1` under the job lock | caller-supplied |

A Scene that cannot prove all of this fails the **whole** admission closed — not
"plan the scenes that qualify". A deliverable missing a scene the customer paid
for is worse than no deliverable, and it would look complete.

## The current pointer does not move

```text
INITIAL        COMPOSITION_PENDING, currentDeliverableVersionId = null
RECOMPOSITION  COMPOSITION_PENDING, currentDeliverableVersionId = previous version
```

and it stays there through `COMPOSING` and `DELIVERABLE_VALIDATING` too. The
customer keeps the video they already have until a validated replacement is
published by Transaction G, which is deferred.

Proved rather than asserted, three ways: the transaction re-reads the pointer
after its writes and raises `CURRENT_DELIVERABLE_POINTER_MOVED` on any change; a
static allowlist in the dormancy suite permits only the lines of the repository
that *read* the column; and the DB suite asserts the pointer's value after both
cycles.

## Locks

```text
GenerationJob                      FOR UPDATE OF j
  → GenerationScenes               FOR UPDATE            (position ASC, id ASC)
    → selected Requests + latest Attempts   FOR UPDATE OF r, a
      → ManagedOutputMediaValidations       read under those locks
```

Job-first, matching Transaction F, the recovery admission and Transaction H, so
none can close a deadlock cycle with this one.

Two lock statements rather than one, and not by preference: PostgreSQL refuses
`FOR UPDATE` on the nullable side of an outer join, and the authoritative read
*must* be an outer join so a Scene with no delivered pointer still appears and is
refused by name rather than silently vanishing from the plan.

The reservation is joined as evidence and **not** locked. There is **no**
cost-admission advisory lock: planning authorizes no provider call and moves no
quota.

## Concurrency

**Two admitters** serialize on the job row. The winner creates the version and
moves the job; the loser re-reads a `COMPOSITION_PENDING` job, takes the replay
path, and answers `ALREADY_PLANNED` **with the winner's version id**. No raw
Prisma uniqueness error reaches a caller.

**A concurrent revision start** cannot commit a stale plan, and the reason is
stronger than "the lock is held": the two authorities require *disjoint* job
states and both take the job row lock first.

```text
job SCENES_READY       → plan admitted,    revision refused JOB_NOT_REVISABLE
job DELIVERABLE_READY  → revision admitted, plan refused    NOT_ELIGIBLE
```

Both directions are proved against live PostgreSQL behind a real row-lock
barrier, with `pg_stat_activity` showing both contenders genuinely blocked before
the barrier is released. No `sleep` is used as a synchronization authority.

## Idempotency

`ALREADY_PLANNED` requires three facts of the highest-ordinal version: it exists,
it holds one input per Scene of this job and no others, and its recorded
fingerprint recomputes from its **own stored rows** under this job's frozen
target. Anything else raises `PARTIAL_PLAN_STATE` and is not repaired — a
half-written plan is evidence about a defect, and quietly completing it would
erase that evidence.

## Reserved edges

| aggregate | edge | owner |
| --- | --- | --- |
| JOB | `SCENES_READY -> COMPOSITION_PENDING` | Transaction I |
| JOB | `COMPOSITION_PENDING -> COMPOSING` | reserved ahead of Phase 5B |
| JOB | `COMPOSING -> DELIVERABLE_VALIDATING` | reserved ahead of Phase 5B |
| JOB | `DELIVERABLE_VALIDATING -> DELIVERABLE_READY` | Transaction G (deferred) |

## Schema and migration notes

Migration `00000000000014_phase5a_deliverable_composition_plan`:

- two tables, no enums;
- four CHECK constraints (`ordinal >= 1`, `position >= 0`, canonical lowercase
  hex receipt digest, positive receipt size bounded at `Number.MAX_SAFE_INTEGER`);
- four unique indexes (`(job, ordinal)`, `(id, job)`, `(version, position)`,
  `(version, scene)`);
- six foreign keys, every one `ON DELETE RESTRICT`;
- **no backfill.** The migration contains no `INSERT`, no `UPDATE "`, no
  `DELETE FROM` and no `SELECT`. The only statement touching `generation_jobs`
  adds the composite foreign key; no column is added, dropped or rewritten.

### Current-pointer migration safety (work-package §31)

Inspected before the migration was written:

- the column was introduced by migration 10 as a plain nullable `TEXT` with no
  default and no foreign key;
- **no migration in 0–13 writes any value into it** — the only `UPDATE` tokens
  anywhere in the migration history are `ON UPDATE CASCADE` foreign-key clauses;
- **no seed script exists** in the repository: `packages/database/prisma/`
  contains only `migrations/` and `schema.prisma`, and no package declares a
  `seed` entry;
- the repository layer has no write path that sets it.

The only non-null values in existence were written by two integration fixtures
(`tests/integration/orchestration-fixture.ts` and
`tests/integration/media-failure-fixture.ts`), after schema setup, into a
disposable database. Per §31 that is the "only test fixtures" case, so the
fixtures were updated normally: both now create a real `GenerationDeliverableVersion`
row through a shared `seedPriorDeliverable` helper. **No production-compatible
row can carry a non-null pointer, so no STOP condition arose and no value was
nulled or synthesized.**

The fixture's stand-in version carries **no input rows**, and its fingerprint is
the real domain function applied to an empty input set — a value no admission can
produce, because every real job has at least one scene. A fixture that invented a
plausible-looking fingerprint over invented inputs would be asserting a plan that
was never admitted.

## Freeze

Not done, on purpose, and each with a reason rather than an omission:

| not done | why |
| --- | --- |
| `ffmpeg` adapter, byte concatenation, scaling, crop, padding | Phase 5B freezes the concrete composition profile before any byte is produced |
| codec, bitrate, frame rate, transition, audio mix, watermark | a guess recorded now would store a policy nobody chose, as if someone had |
| final deliverable object and its validation | Phase 5B/5C |
| `COMPOSITION_PENDING -> COMPOSING` actor, runner, scheduler | dormant by design; the two edges are reserved so nothing can walk the pipeline without them |
| candidate-discovery query | a queue with nothing draining it would suggest work is happening that is not |
| unit `CONSUME`, Transaction G | a unit may be consumed only after a usable, media-valid final deliverable exists |
| moving `currentDeliverableVersionId` | the customer keeps their existing video until a replacement is validated |
| optional version metadata | nothing beyond the fingerprint is authoritative at admission time |

## Required phase documentation (CLAUDE.md v1.3)

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` — component table updated with the plan module, the not-yet-implemented composition executor, and the two reserved edges |
| Entity-relationship diagram | `docs/er-diagram.md` (new Phase 5A section) and inline above |
| Critical sequence diagram | inline above — initial composition plan admission |
| OpenAPI specification / API change summary | **Not applicable.** Phase 5A adds no HTTP route, no request or response shape, and no change to an existing one. The only new surface is `DeliverableCompositionPlanRepository`, an internal port with no production caller |
| Change log | `CHANGELOG.md` |
| Release notes | **Not applicable.** Nothing here is customer-observable: no route, no UI, no behaviour change to any running path, and the capability is dormant. The first customer-visible change in this area is the composed video itself, in Phase 5B/5C |
| Database migration notes | `docs/migration-notes.md` (new Phase 5A section) |
| Phase completion report | this document |

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | clean, 0 errors |
| `pnpm lint` | clean |
| `pnpm test` | **4379 passed / 135 files** (from 4332 / 133) |
| `pnpm test:db` | **1051 passed / 33 files** (from 975 / 31) |
| `pnpm build` | success |
| `prisma validate` | valid |
| `prisma format` | no change on re-format |
| migrations 1–14 against an empty database | all applied |
| `prisma migrate diff` against the shadow database | **empty — zero drift** |

New tests: 45 unit (`packages/domain/src/deliverable-composition/`), 69 DB
(51 plan + 18 races/foreign-key/reserved-edge).

## PR #70 review corrections

Three correctness gaps were found in review and corrected. All three were
*authority read without a lock* or *authority not actually proved*; none changed
the schema, and migration 14 required no structural change.

### Blocker A — the entitlement hold was read without its row lock

`Reservation.state` decides which composition cycle this is, so it is authority.
It was joined as unlocked evidence, which is a time-of-check/time-of-use hole: a
concurrent release or reconciliation hold could move it after the read and before
the plan committed, admitting a deliverable against an entitlement that no longer
authorized one.

The hold is now locked, and the state used by the decision is the one read *under
that lock*. The Job read no longer joins the reservation at all, so no unlocked
value exists for a later edit to start trusting by accident.

**The lock order took two attempts to get right, and the final order is the
reverse of the first correction's.**

The first correction locked the reservation but ordered it *after* the Job,
justified by a probe that used a hand-written two-table join filtered on
`j."id"`. That plan scanned jobs first and reported Job → Reservation. It
measured the substitute, not production.

Re-measured against the **real** `settleExhaustedMediaFailure`:

| session A holds | settlement blocks on | third session probes | result |
| --- | --- | --- | --- |
| the reservation row | the reservation | the Job row | **acquired** — settlement does not hold it |
| the Job row | the Job | the reservation row | **refused** — settlement holds it |

`pg_locks` confirms it: while blocked on the reservation, the settling backend
holds only table-level `RowShareLock`s and no row lock on `generation_jobs`.

Transaction H takes **Reservation → Job**, and Transaction I now does too.
Taking the Job first closes a real cycle, and disjoint business states do not
prevent it: both transactions lock *before* concluding eligibility, so a
Transaction I call destined for `NOT_ELIGIBLE` still holds what it locked while
settlement runs.

Both orders are now pinned behaviourally against their own real paths, in
`media-failure-settlement-races.db.test.ts` and
`deliverable-composition-races.db.test.ts`.

**Audit of every workflow locking both rows.** Only Transaction H and
Transaction I lock both, and both take the reservation first. Paid-submission
authorization, reconciliation and submission outcome lock the reservation alone.
Transaction F, media recovery, revision start and revision rollback lock the Job
(and scene/request/attempt) with no reservation row lock. **No production
workflow establishes a Job row lock followed by a reservation row lock.** Two
workflows read the reservation's state through a `LEFT JOIN` while holding a Job
lock — MVCC reads, not row locks, so not a cycle — recorded separately in
`docs/decisions/TODO.md`.

No cost-admission advisory lock is taken by Transaction I, and no unit is
consumed or released.

### Blocker B — a recomposition replay could return the customer's current deliverable

A recomposition legitimately leaves the job pointing at the previous,
still-usable deliverable while the new plan is non-current. So a job stuck in
`COMPOSITION_PENDING` with **no** new version found the customer's *old* version
at the top of the ordinal order, proved it self-consistent — it is — and reported
`ALREADY_PLANNED` for a deliverable that is not this cycle's.

Replay now proves the pending cycle:

```text
INITIAL        pointer null      → latest planned version must be ordinal 1
RECOMPOSITION  pointer non-null  → resolve current under THIS job,
                                   latest.id != current.id,
                                   latest.ordinal == current.ordinal + 1
```

The current version is resolved by `(id, generationJobId)` rather than trusted
from the caller. `ordinal + 1` exactly is a deliberate Phase 5A choice: with no
retry lifecycle, a pending cycle produces exactly one new version.

### Blocker C — the selected media verdicts were not locked

The authorized lock contract named the validation rows, and the previous report
claimed them; `lockSceneChain` locked only scenes, requests and attempts. They
are now locked last, after the attempts, in the same deterministic scene order.
The media-validation lifecycle itself is unchanged.

### One mutation re-aim, reported honestly

`M267` (remove the replay identity guard) **survived** its first spot run, and
the reason was a weakness in my own regression rather than a missing test: the
identity check is dominated by the succession check — an equal id implies an
equal ordinal — and the partial-plan fixture's stand-in version carried no input
rows, so the coverage check refused it before either cycle guard ran.

Both were fixed. The regression now uses a **real ordinal-1 plan produced by
Transaction I** as the current version, so coverage and fingerprint both pass and
only the cycle guards can refuse; and `M267` is re-aimed at *both* guards, since
removing either alone is unobservable. It now kills.

## A flake this phase introduced, found in final verification

Final verification failed on `pnpm test:db`, and the cause was Phase 5A's own
fixture change. It is recorded here in full because it also bears on the mutation
ledger below.

**What broke.** `makeJobRevisable` previously wrote a synthetic string into
`GenerationJob.currentDeliverableVersionId`, which is idempotent under
concurrency. With the composite foreign key it must create a real
`GenerationDeliverableVersion` instead, and `seedPriorDeliverable` did that as
read-then-create. In `generation-regeneration-entitlement.db.test.ts` the helper
`admitRegen` re-armed the job *inside* each of two deliberately concurrent calls,
so both re-arms raced: both observed no version, both inserted ordinal 1, and one
lost on `(generationJobId, ordinal)`. The unique violation escaped as a rejected
promise.

**Measured, not assumed.** Six isolated runs of that one test: **three failures**
— roughly 50%. Two distinct signatures, and both were diagnostic:
`['fulfilled','rejected']` (the unique violation) and `expected [] to have a
length of 1` (zero admissions, because the interleaved re-arms left the job
non-revisable for both callers).

**Two fixes, both test-only. No production behaviour changed.**

1. `seedPriorDeliverable` now inserts with `skipDuplicates` and re-reads the
   winner's row on a collision. A fixture that explodes under contention makes
   every concurrency test around it flaky for a reason unrelated to what the test
   asserts.
2. The concurrency test re-arms **once, before** the race, and then races only
   the two `admitUserRegeneration` calls. Re-arming inside them put the *fixture*
   in the race, which is not the rule under test.

The second fix changed what the loser's outcome may be, and the test now says so
rather than pinning the scheduler: the loser is refused under the job lock by
either `JOB_NOT_REVISABLE` (the winner already moved the job) or
`REGENERATION_ALREADY_ACTIVE` (the winner's request is in flight). Both are
correct, and the invariant that matters is unchanged and still asserted —
**exactly one `ADMITTED`, exactly one stored request at ordinal 1, and no
database error escaping as a business outcome.**

Ordering-dependence in that test pre-dates Phase 5A; the unique-violation failure
mode does not. This phase made a latent flake frequent, and the fix removes both.

Determinism after the fix: **10/10 consecutive passes** of the isolated suite,
then **3/3 consecutive passes** of the entire 33-file DB suite.

## Mutation ledger

### Historical run — contaminated, kept for the record

> **Not final evidence.** This run happened *before* the flake above was found,
> against the version of `generation-regeneration-entitlement.db.test.ts` that
> failed roughly half the time. The harness kills a mutation whenever any suite
> reports a failure, so a mutation that should have survived could have been
> recorded as `KILLED` by that flake rather than by the defect it injected. The
> 264/264 result below is therefore **not fully trustworthy as evidence**, and I
> am not presenting it as if it were. It is reported as run; re-running it
> against the now-deterministic suite is the only thing that would restore its
> value, and that decision is recorded as outstanding.

| | |
| --- | --- |
| Mutations run | 264 |
| Killed | 264 |
| Survivors | 0 |
| Anchor-missing | 0 |

The flake history is deliberately not erased: this run is what a contaminated
ledger looks like, and the reason a clean one was required.

### Intermediate run — superseded by the lock-order correction

Run once on the tree that carried the first round of review corrections, after
the entitlement flake was fixed.

| | |
| --- | --- |
| Mutations run | 271 |
| Killed | 271 |
| Survivors | 0 |
| Anchor-missing | 0 |

All 264 earlier definitions preserved; M264–M270 were the seven correction
mutations. Valid for the tree it ran on, and **not** final evidence: that tree
acquired the Job row before the entitlement hold, and the executable production
code has since changed.

### Final complete run — the authoritative one

Run once on the corrected **Reservation → Job** tree.

_(filled in below)_

### What the seven correction mutations cover

| Mutation | Defect it injects |
| --- | --- |
| M264 | the entitlement hold is not locked before its state is trusted |
| M265 | the reservation state is read from an unlocked join again |
| M266 | the selected media verdict rows are not locked |
| M267 | a recomposition replay reports the customer's current deliverable as the plan |
| M268 | a recomposition replay drops the ordinal-after-current rule |
| M269 | an initial replay no longer requires the first ordinal |
| M270 | the replay accepts a current pointer naming another job's version |

### Re-aims, stated rather than buried

**M267** is aimed at *two* sites, not one. Removing the replay's identity guard
alone is unobservable: an equal id implies an equal ordinal, so the succession
rule refuses it anyway. Both guards are kept — they assert different things — and
the mutation removes both, which the strengthened regression observes.

That regression was itself corrected. Its first form used the fixture's stand-in
prior version, which carries no input rows, so the coverage check refused the
replay before either cycle guard ran; the test passed for the wrong reason and
M267 survived. It now uses a **real ordinal-1 plan produced by Transaction I** as
the current version, so coverage and fingerprint both pass and only the cycle
guards can refuse.

Three guards in total are documented as structurally redundant rather than
counted as clean individual kills — the latest-attempt comparison, the
delivered-pointer null check, and the replay identity check. All are kept, and
every mutation aimed at them removes each site at once.

All 227 pre-existing definitions were preserved unchanged; M227–M263 are this
phase's 37 additions. Every one of the 37 is killed by the test suites, none by
`typecheck` — this phase's defects are behavioural, not shape violations, and a
mutation that only failed to compile would not have proved a test existed.

Runtime was measured before committing to a complete run rather than assumed: a
single timed mutation took 67s, projecting ~4.9 hours for 264. That is inside the
12–14 hour class the work package set as the threshold, so no substitution was
requested.

### What the 37 cover

| Area | Mutations |
| --- | --- |
| Per-scene authorities (scene `READY`, request `DELIVERED`, attempt `OUTPUT_VERIFIED`, `VALID` verdict, receipt binding on both axes) | M227–M231, M234, M235 |
| Latest-attempt rule (`createdAt` substituted for the ordinal; the restriction removed from both sites) | M232, M233 |
| Reservation and pointer cycle authority | M236–M238 |
| The current deliverable pointer published during planning | M239 |
| Caller-supplied ordinal | M240 |
| Idempotency and the partial-plan defect | M241–M244 |
| The job row lock and the tenant predicate | M245, M246 |
| Deterministic scene order; the empty-job refusal; source-history immutability | M247–M249 |
| Every fingerprint tuple dimension, the target triple, the versioned prefix, the order and duplicate rules | M250–M260 |
| The three reserved job edges | M261–M263 |

### Two redundant guards, reported rather than hidden

Two guards in `proveSceneInput` cannot be killed *individually*, and the reason
is a property of the code rather than a gap in the tests. Both are stated here
rather than left to look like clean kills.

**The latest-attempt comparison.** The SQL join already restricts the attempt to
`MAX(attemptOrdinal)`, so `row.attemptOrdinal !== row.maxAttemptOrdinal` can
never be the sole cause of a refusal. Removing either site alone changes nothing
observable. **M233 therefore removes both**, and the behaviour it breaks is real:
with no restriction, a superseded request yields two rows for one scene, the
duplicate-scene rule fires, and the admission raises
`PLAN_INPUT_ORDER_INVALID`. The positive direction is pinned separately by a DB
test in which the newer attempt by ordinal is deliberately the *older* one by
`createdAt`, so the two authorities disagree and the plan says which was used —
that test is what kills M232.

**The delivered-pointer null check.** Every join below the Scene is an outer
join, so a Scene with no `currentDeliveredRequestId` nulls the request, the
attempt and the verdict together. Any downstream guard catches it, which means
`row.currentDeliveredRequestId === null` alone is unreachable as a cause. M229
removes the whole chain down to the verdict, and *that* is killable: the receipt
comparison then runs against a null digest and raises
`SOURCE_RECEIPT_BINDING_CONFLICT` where the suite expects `NOT_ELIGIBLE`.

Both guards are kept. They document different facts, they fail closed, and the
cost of keeping them is one honest note rather than a removed defence.

### Restoration

Verified after the harness exited, not asserted:

```text
mutation/harness processes         0
sha256sum -c pre-ledger snapshot   657 files checked, 0 mismatches
git status --short                 empty
git diff --check                   empty
HEAD                               d5edef3 (the Phase 5A commit)
```

The first process check appeared to report one match; that was this session's own
shell, whose command line contained the harness name as an argument. A re-check
naming the full process lines showed no matching process and no `python3` process
at all.

## Carried forward

- Phase 5B: the composition profile, the `ffmpeg` adapter, the two reserved
  execution edges, the final deliverable object and its receipt.
- Phase 5C / Transaction G: deliverable-level media validation,
  `DELIVERABLE_VALIDATING -> DELIVERABLE_READY`, moving the current pointer, and
  unit `CONSUME`.
- Recorded in `docs/decisions/TODO.md`.
