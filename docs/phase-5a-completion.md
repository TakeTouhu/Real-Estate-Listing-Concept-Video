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
| `pnpm test` | **4377 passed / 135 files** (from 4332 / 133) |
| `pnpm test:db` | **1044 passed / 33 files** (from 975 / 31) |
| `pnpm build` | success |
| `prisma validate` | valid |
| `prisma format` | no change on re-format |
| migrations 1–14 against an empty database | all applied |
| `prisma migrate diff` against the shadow database | **empty — zero drift** |

New tests: 45 unit (`packages/domain/src/deliverable-composition/`), 69 DB
(51 plan + 18 races/foreign-key/reserved-edge).

## Mutation ledger

_(filled in below)_

## Carried forward

- Phase 5B: the composition profile, the `ffmpeg` adapter, the two reserved
  execution edges, the final deliverable object and its receipt.
- Phase 5C / Transaction G: deliverable-level media validation,
  `DELIVERABLE_VALIDATING -> DELIVERABLE_READY`, moving the current pointer, and
  unit `CONSUME`.
- Recorded in `docs/decisions/TODO.md`.
