# ADR-0049 — Durable deliverable composition plan and atomic composition admission

Status: Accepted (Phase 5A)
Supersedes: nothing. Extends ADR-0046 (atomic validated Scene delivery) and
ADR-0048 (durable media-failure resolution and settlement).

## Context

Phase 6C ends a generation cycle in a well-defined place: every
`GenerationScene` is `READY`, the `GenerationJob` is `SCENES_READY`, and each
Scene's `currentDeliveredRequestId` names the rendition the customer is entitled
to see.

The next question is narrow and has no durable answer yet:

> exactly which immutable scene renditions belong to the next customer
> deliverable?

Until now, nothing recorded it. A composition process would have re-derived the
answer from live rows every time it ran — and live rows move. A regeneration can
replace a Scene's delivered pointer between two attempts at the same video, a
rollback can put the old one back, and a delayed media verdict can arrive in
between. A customer could then receive a video assembled from a selection nobody
ever approved, and afterwards no record would exist of which selection any
attempt used.

`GenerationJob.currentDeliverableVersionId` had also carried no foreign key since
migration 10, because the table it named did not exist. A pointer that can name
anything is not a pointer.

---

## Decision 1 — A deliverable version is its own durable identity

`GenerationDeliverableVersion` is a row, not a column on the job:

```text
id, generationJobId, ordinal, inputFingerprint, createdAt
```

Three properties make it a separate identity rather than job state.

**It is versioned.** A successful `USER_REGENERATION` followed by recomposition
produces the next one. A job therefore has a *history* of deliverables, and the
customer holds exactly one of them at a time.

**It is immutable.** Once admitted, a version's input set never changes. That is
what makes a crashed composition reconstructable: the restarted run composes the
same bytes, because the selection is stored rather than re-derived.

**It is the thing composition executes.** Phase 5B's composition workflow takes a
version id and needs nothing else — not a Scene query, not a delivered pointer,
not a "latest attempt" rule. The plan is the contract between planning and
execution.

`ordinal` is job-scoped, starts at 1, and is derived as `MAX + 1` **inside the
admission transaction under the job's row lock**. It is never accepted from a
caller: an ordinal chosen outside that transaction is a claim about rows the
caller did not lock. The unique index on `(generationJobId, ordinal)` remains the
database's own defence against any writer that never took the lock.

Deliverable ordinal is deliberately **not** scene regeneration ordinal. One
regeneration of one scene produces one new deliverable version covering *every*
scene.

## Decision 2 — The input set is frozen row by row, with its receipts

`GenerationDeliverableInput` holds one row per Scene in the version:

```text
deliverableVersionId, position, generationSceneId,
sceneGenerationRequestId, sceneGenerationAttemptId, mediaValidationId,
sourceSha256, sourceSizeBytes
```

The four foreign keys are the whole selection, recorded rather than
re-derivable, and all four are `ON DELETE RESTRICT` — this names paid generated
history end to end.

`sourceSha256` and `sourceSizeBytes` duplicate the attempt's verified receipt,
and that is the only duplication here. They make the plan self-describing: a
later reader can tell which bytes were planned without joining four tables, and a
receipt that ever disagreed with the attempt's becomes visible rather than
assumed away. No other media metadata is copied — duration, dimensions and
container stay where they were measured.

Two uniqueness constraints hold the shape: `UNIQUE(version, position)` and
`UNIQUE(version, generationSceneId)`. A Scene appears exactly once, at exactly
one position, in one plan. `position` is the `GenerationScene.position` frozen as
it was; planning never renumbers.

## Decision 3 — `currentDeliveredRequestId` is the scene input authority

The selected request for a Scene is **exactly** its `currentDeliveredRequestId`.

Not "the newest request by `createdAt`", not "the highest regeneration ordinal",
not "the newest successful request". Each of those guesses at what the customer
currently holds, and a rolled-back regeneration is precisely the case where the
guess is wrong: the newest request exists, it is newer by every measure, and it
failed. The pointer is what Transaction F set and what Transaction H restored,
and it is the only value in the system that means *this is what the customer has*.

The plan then proves the pointed-at request rather than trusting it: it must
belong to that exact Scene (enforced by the composite foreign key
`(id, generationSceneId)` that already existed) and be `DELIVERED`.

## Decision 4 — The latest attempt is chosen by `attemptOrdinal`, never `createdAt`

For each selected request, the source attempt is the one with
`MAX(attemptOrdinal)`, and it must be `OUTPUT_VERIFIED`.

`createdAt` is not used, for the reason ADR-0046 already gives: two attempts
admitted in the same millisecond have no order, and the ordinal does. A plan
built on timestamp order can silently compose a superseded attempt's bytes.

## Decision 5 — `VALID` media, with exact receipt binding

The attempt's `ManagedOutputMediaValidation` must be `VALID` with
`validatedAt != null`, and its frozen receipt must equal the attempt's verified
receipt on **both** axes:

```text
validation.receiptSha256    = attempt.outputSha256
validation.receiptSizeBytes = attempt.outputSizeBytes
```

`INVALID_MEDIA`, `INTEGRITY_MISMATCH`, `PENDING`, `RUNNING` and a missing record
all refuse. A receipt mismatch is different in kind: it is a state the system
believes it cannot produce, so it raises the fixed defect
`SOURCE_RECEIPT_BINDING_CONFLICT` rather than returning an outcome. Composing
around it would be composing bytes nobody validated.

**Any Scene that cannot prove all of this fails the whole admission closed.** Not
"plan the scenes that qualify" — a deliverable missing a scene the customer paid
for is worse than no deliverable, and it would look complete.

## Decision 6 — Three fingerprints, three questions, three vocabularies

A new versioned hash vocabulary:

```text
sha256:deliverable-input:v1:<hex>
```

It is deliberately distinct from the two digests already in stored data:

| value | question it answers |
| --- | --- |
| `sha256:<hex>` (ADR-0012) | was the storyboard composed from the eligible analysis set that exists today? |
| `sha256:v2:<hex>` (ADR-0034) | are these two provider requests the same request? |
| `sha256:deliverable-input:v1:<hex>` | was this deliverable version planned from this exact ordered set of validated scene bytes, for this exact frozen job target? |

None of them is an object content hash. The final video's own SHA-256 is a fourth
thing entirely and does not exist yet. Making the vocabulary visible *in the
stored value* is what keeps a future reader from comparing two of them.

The canonical payload is a structure, not concatenated text — the same discipline
`computeCompositionFingerprint` and `computeGenerationRequestHash` use. Per Scene,
in position order:

```text
[position, generationSceneId, sceneGenerationRequestId,
 sceneGenerationAttemptId, mediaValidationId, sourceSha256, sourceSizeBytes]
```

plus the job's frozen delivery target — `targetOutputResolution`,
`targetAspectRatio`, `requestedDurationSeconds`. The same ordered bytes composed
for 1080p 16:9 and for 720p 9:16 are not the same deliverable, and those three
are snapshotted on the job at creation and never re-read from the mutable
project.

Two details are load-bearing:

- **`sourceSizeBytes` is serialized as a decimal string.** `JSON.stringify`
  refuses a `bigint` outright, and converting to `Number` would silently lose
  precision above 2^53 — on the one value in the payload whose whole purpose is
  to be exact.
- **No timestamps.** `createdAt`, `validatedAt` and `deliveredAt` all move
  between two runs that selected identical bytes, and a fingerprint that changed
  with them could never prove two plans equal.

The order is **not repaired**. The caller supplies scenes in ascending position
order because that is the order the transaction locked and read them in; sorting
inside the function would hide a reader that returned them in some other order,
and that reader's order is exactly what the fingerprint is supposed to witness.
A repeated scene, a repeated position or a descending order raises
`PLAN_INPUT_ORDER_INVALID`.

## Decision 7 — Transaction I: one commit, or nothing

`admitCompositionPlan` owns the whole business fact:

```text
create GenerationDeliverableVersion
create every GenerationDeliverableInput
append DELIVERABLE  null -> PLANNED
GenerationJob       SCENES_READY -> COMPOSITION_PENDING
append JOB          SCENES_READY -> COMPOSITION_PENDING
```

There is deliberately no `createDeliverableVersion`, `addDeliverableInput`,
`freezeDeliverablePlan` or `markJobCompositionPending`. Four calls are four crash
boundaries, and the states they would leave behind — a version with no inputs, an
input set no job moved for, a job awaiting composition with nothing to compose —
are exactly what this transaction exists to make impossible.

### Lock order

```text
GenerationJob
  → GenerationReservation
    → GenerationScenes (position ASC, id ASC)
      → selected SceneGenerationRequests
        → selected latest SceneGenerations
          → their ManagedOutputMediaValidations
```

The same Job-first order Transaction F, the recovery admission and Transaction H
take, so none of them can close a deadlock cycle with this one. Every row in that
list is locked; see *Why the Job is locked before the hold* below for the
measurement that fixed the Job/reservation pair's order.

The locks are taken in two statements rather than one, and not by preference:
PostgreSQL refuses `FOR UPDATE` on the nullable side of an outer join, and the
authoritative read *must* be an outer join so that a Scene with no delivered
pointer still appears and is refused by name rather than silently vanishing from
the plan. So the locks are taken first by inner join, and the read follows under
them.

The **reservation is locked**, and the correction that made it so is worth
recording plainly: it was originally joined as unlocked evidence, which was a
time-of-check/time-of-use hole. The hold's state is *authority* here — it is what
separates an initial composition from a recomposition, and what refuses a
released or reconciling hold — so a concurrent release could move it after the
read and before the plan committed, admitting a deliverable against an
entitlement that no longer authorized one.

Locking it is **not** an entitlement mutation. Transaction I authorizes no paid
provider call, moves no exposure, consumes no unit and releases none. There is
**no cost-admission advisory lock**: planning does not cross the paid boundary,
so serializing it against the gate that does would be contention for nothing.

### Why the Job is locked before the hold

The pair's order was chosen by measurement, not by convention. Transaction H is
the only other operation that locks both rows, and it does so in one statement
whose `FROM` clause reaches `generation_jobs` before `generation_reservations`. A
three-session probe against live PostgreSQL — hold the reservation row, run the
settlement-shaped join, then attempt the Job row `FOR UPDATE NOWAIT` from a third
session — reports `could not obtain lock on row in relation "generation_jobs"`.
Settlement therefore **already holds the Job while it waits for the reservation**.

The same probe with the two tables swapped in the `FROM` clause reports the Job
row as freely acquirable, which is what makes the instrument trustworthy rather
than a coincidence.

So a staged reservation-then-Job acquisition here would close a real cycle:

```text
Transaction I : holds reservation, waits for Job
Transaction H : holds Job,         waits for reservation
```

Job-then-reservation matches settlement's measured order and cannot deadlock with
it. The three cost workflows — paid-submission authorization, reconciliation and
submission outcome — lock the reservation *alone* and never the Job, so none of
them can participate in a cycle in either direction.

The reservation's state is read **only** under its own row lock. The Job read
does not join the reservation at all, so no unlocked value exists for a later
edit to start trusting by accident.

### The media verdicts are locked too

`ManagedOutputMediaValidation` rows are authority — the plan freezes a `VALID`
status and its receipt — and were originally read without being locked, the same
gap in a different place. They are locked last, after the attempts, in the same
deterministic scene order. A scene with no verdict yields no row to lock and is
refused by the authoritative outer-join read exactly as before; nothing about the
media-validation lifecycle itself changes.

### No external I/O

Database work only. No object-store read, no `ffprobe`, no `ffmpeg`, no HTTP and
no temporary file is reachable from inside the transaction. No transaction in
this system spans external I/O.

## Decision 8 — Two legitimate composition cycles, and no third

At admission the job's deliverable pointer and its reservation must agree about
which cycle this is:

| cycle | `currentDeliverableVersionId` | `Reservation.state` |
| --- | --- | --- |
| initial composition | `null` | `RESERVED` |
| recomposition after delivery | non-null | `CONSUMED` |

Every other combination fails closed, including the two that are individually
plausible and jointly impossible:

- **null pointer + `CONSUMED`** — the customer has been charged for something
  nobody received.
- **non-null pointer + `RESERVED`** — something was delivered that nobody was
  charged for.

`RECONCILIATION_HOLD`, `RELEASED`, `RESERVING` and a missing reservation all
refuse as well. A hold under reconciliation is precisely the case where the
platform does not know whether the entitlement was spent, and planning a
deliverable against it would commit to an answer.

## Decision 9 — Planning creates the version; it never publishes it

`Transaction I` never writes `GenerationJob.currentDeliverableVersionId`.

After admission:

```text
INITIAL:        state = COMPOSITION_PENDING, pointer = null
RECOMPOSITION:  state = COMPOSITION_PENDING, pointer = the PREVIOUS version
```

and the pointer stays there through `COMPOSITION_PENDING`, `COMPOSING` and
`DELIVERABLE_VALIDATING` alike. **The customer keeps the video they already have
until a validated replacement is published.** Publishing is Transaction G's fact,
at `DELIVERABLE_VALIDATING -> DELIVERABLE_READY`, and Transaction G is deferred.

The new planned version is discoverable by job plus highest ordinal, which needs
no pointer at all.

This is proved rather than asserted. The transaction re-reads the pointer after
its writes and raises `CURRENT_DELIVERABLE_POINTER_MOVED` if it changed, because
"we do not write that column here" is not a control — the re-read is. A static
assertion in the dormancy suite allowlists every line of the repository that may
name the column, so a line that *writes* it has nowhere to hide.

## Decision 10 — The job pointer finally names something, and only its own

`GenerationDeliverableVersion` carries a redundant `UNIQUE(id, generationJobId)`
so that the job can reference it compositely:

```text
GenerationJob(currentDeliverableVersionId, id)
  -> GenerationDeliverableVersion(id, generationJobId)
```

Exactly the pattern `GenerationScene.currentDeliveredRequestId` already uses. A
single-column foreign key would have accepted another job's version, and one
customer's video would be composed of another's. PostgreSQL now rejects both a
nonexistent id and a foreign job's version, and `ON DELETE RESTRICT` refuses to
delete a version a job currently points at.

No backfill was needed and none was performed. The column has been nullable with
no default since migration 10, no migration has ever written a value into it, no
seed script exists in the repository, and the repository layer has no write path
that sets it. Every non-null value in existence was created by an integration
fixture after schema setup, in a disposable database; those fixtures now create a
real version row instead of a synthetic string.

## Decision 11 — Idempotency is answering with the existing plan, never rebuilding one

A replay finds the job already `COMPOSITION_PENDING`. That job was planned by
someone, and the only honest answers are "here is that plan" or "the plan behind
this claim is broken". Re-deriving would create a second version for one cycle.

`ALREADY_PLANNED` is returned when four facts hold of the highest-ordinal
version: it exists, **it is the version planned for this pending cycle**, it
holds one input per Scene of this job and no others, and its recorded fingerprint
recomputes from its **own stored rows** under this job's frozen target. Anything
else raises `PARTIAL_PLAN_STATE`.

The second fact was missing originally, and its absence was a customer-facing
defect rather than a tidiness one. A recomposition legitimately leaves the job
pointing at the previous, still-usable deliverable while the new plan is
non-current — so a job stuck in `COMPOSITION_PENDING` with **no** new version
found the customer's *old* version at the top of the ordinal order, proved it
self-consistent (it is: it was planned correctly, once), and reported
`ALREADY_PLANNED` for a deliverable that is not this cycle's.

So the pending cycle is proved explicitly:

```text
INITIAL        pointer null      → latest planned version must be ordinal 1
RECOMPOSITION  pointer non-null  → resolve the current version under THIS job,
                                   latest.id != current.id,
                                   latest.ordinal == current.ordinal + 1
```

The current version is resolved from the database by `(id, generationJobId)`,
never trusted from the caller — the composite foreign key already guarantees the
pointer names a version of this job, and this uses that authority rather than
re-deriving it.

`ordinal + 1` exactly, not merely "greater", and that is a deliberate Phase 5A
choice: there is no failed-composition or retry lifecycle yet, so a pending cycle
produces exactly one new version and any gap is a plan nobody can account for. A
later phase introducing retry history must revisit this rule deliberately rather
than widening it by accident.

Self-consistency rather than re-derivation from live Scene rows, deliberately. A
`COMPOSITION_PENDING` job cannot have its Scenes moved — revision start requires
`DELIVERABLE_READY` — so the two are equivalent today, and the local check is the
one that stays meaningful if that ever stops being true: it asks whether the
stored plan is a plan, not whether the world still agrees with it.

Nothing is repaired. A half-written plan is evidence about a defect, and quietly
completing it would erase that evidence.

## Decision 12 — Concurrency, and why a stale plan cannot commit

**Two admitters.** Both take the job row lock first, so they serialize there. The
winner creates the version and moves the job; the loser re-reads a job that is
already `COMPOSITION_PENDING` and takes the replay path, answering
`ALREADY_PLANNED` with the *winner's* version id. No raw Prisma uniqueness error
ever reaches a caller — the outcome union is the contract, not a `P2002`.

**A concurrent revision start.** The dangerous outcome would be a plan committed
from a Scene selection a revision replaced underneath it. It cannot happen, and
the reason is stronger than "the lock is held": the two authorities require
**disjoint job states**. Planning needs `SCENES_READY`; revision start needs
`DELIVERABLE_READY`. Both take the same job row lock first. So whichever state
the job is committed in, exactly one of the two can proceed and the other is
refused *by state*:

```text
job SCENES_READY       → plan admitted,   revision refused JOB_NOT_REVISABLE
job DELIVERABLE_READY  → revision admitted, plan refused  NOT_ELIGIBLE
```

Both directions are proved against live PostgreSQL behind a real row-lock
barrier, with `pg_stat_activity` showing both contenders genuinely blocked before
the barrier is released. No `sleep` is used as a synchronization authority.

## Decision 13 — Three more job edges reserved from the generic API

`JOB_RESERVED_EDGES` gains:

```text
SCENES_READY        -> COMPOSITION_PENDING    (Transaction I owns it)
COMPOSITION_PENDING -> COMPOSING              (reserved ahead of its owner)
COMPOSING           -> DELIVERABLE_VALIDATING (reserved ahead of its owner)
```

alongside the existing `DELIVERABLE_VALIDATING -> DELIVERABLE_READY`.

The first is owned: a job awaits composition *because* a version and its frozen
inputs were admitted in the same commit.

The other two are reserved ahead of their owners, deliberately. The durable
composition execution workflow is Phase 5B's, and until it exists these edges
have no actor at all — but leaving them generically writable would let a caller
walk a job from `COMPOSITION_PENDING` to `DELIVERABLE_VALIDATING` without ever
producing bytes, and the only thing then standing between a customer and an empty
deliverable would be Transaction G's own guard. **The generic API must not be
able to assemble the delivery pipeline without its atomic authorities.**

## Decision 14 — Source history is immutable, and no unit moves

Transaction I modifies no `SceneGenerationRequest`, no `SceneGeneration`, no
`ManagedOutputMediaValidation`, no provider output receipt, no pricing snapshot
and no canonical object. It only records that those immutable facts were selected
as inputs. The reservation is read and left alone.

No `CONSUME`. Composition correctness and billing correctness are separate
failure domains:

```text
composition plan
  != composition success
  != durable final bytes
  != media-valid final bytes
  != DELIVERABLE_READY
  != unit CONSUME
```

A customer unit may be consumed only after a usable final deliverable exists and
has passed deliverable-level validation. Transaction G stays deferred until those
facts exist.

## Decision 15 — No normalization policy yet

No codec, bitrate, frame rate, transition, audio mix, crop, padding, letterbox,
watermark or interpolation decision is recorded. `UPSCALE` and `DOWNSCALE` are
not implemented.

The job already records `targetOutputResolution` and the attempt records its
native-generation normalization facts, so the *inputs* to that decision exist —
but the decision itself is a product commitment that has not been made. Recording
a guess now would store a policy nobody chose, as if someone had. Phase 5B
freezes the concrete composition profile before any byte is produced.

Optional version metadata was likewise not added: nothing beyond the fingerprint
is authoritative at composition-admission time.

## Decision 16 — Dormant

Phase 5A ships with **no runner, no scheduler and no actor** for
`COMPOSITION_PENDING -> COMPOSING`. There is also deliberately **no candidate
discovery method** — a queue with nothing draining it would suggest work is
happening that is not.

Nothing in `apps/web` or `apps/worker` constructs the repository, references the
module, or names `admitCompositionPlan`. The dormancy suite asserts each of those
architecturally, rather than describing them.

---

## Phase boundary

| phase | owns |
| --- | --- |
| **5A** (this) | the durable plan, the frozen input set, the fingerprint, Transaction I, `SCENES_READY -> COMPOSITION_PENDING` |
| **5B** | the concrete composition profile, the `ffmpeg` adapter, `COMPOSITION_PENDING -> COMPOSING -> DELIVERABLE_VALIDATING`, the final deliverable object and its receipt |
| **5C / Transaction G** | deliverable-level media validation, `DELIVERABLE_VALIDATING -> DELIVERABLE_READY`, moving `currentDeliverableVersionId`, and unit `CONSUME` |

## Consequences

- A deliverable is reconstructable from persistence alone, and two attempts at
  the same video are comparable by fingerprint.
- A composition that crashes mid-run resumes against the same bytes, because the
  selection is stored rather than re-derived.
- A job pointing at another job's deliverable is now impossible in PostgreSQL,
  not only in TypeScript.
- Nothing composes yet, and nothing is billed. The capability is inert until
  Phase 5B wires an actor to it.
