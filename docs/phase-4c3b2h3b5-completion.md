# Phase 4C-3B-2H-3B-5 — Durable managed-output media-validation lifecycle

- Base: `fc9c5a3dbc10a33d3ae3046ba83fdbd6dd0101f8` (merge commit of PR #65)
- Decision record: ADR-0045
- Migration: **`00000000000012_phase4c3b2h3b5_media_validation_lifecycle`**
- Durable lifecycle change to existing states: **none** — `OUTPUT_VERIFIED` is unchanged
- Paid provider / AWS / ffmpeg activation: **still blocked**
- Production scheduler: **none**

## What this phase adds

ADR-0044's validator could answer whether a byte-verified managed output is
media. Nothing kept the answer. This phase makes that answer durable and safely
retryable — and deliberately stops there.

1. **`ManagedOutputMediaValidation`** — a one-to-one durable record with a
   closed status vocabulary, an immutable receipt binding and database-enforced
   row shape.
2. **A lease/version claim → finalize lifecycle** in `@app/database`.
3. **`MediaValidationLifecycleRunner`** in `@app/domain` — a dormant runner over
   ports, consuming the existing `ManagedOutputMediaValidationPort`.
4. **Deterministic concurrency, recovery, database and mutation coverage.**

## `OUTPUT_VERIFIED` is not redefined

| Fact | Meaning | Where it lives |
| --- | --- | --- |
| `OUTPUT_VERIFIED` | canonical managed bytes were copied and byte-level integrity was verified | unchanged attempt state |
| media validity | MP4-family container, usable video stream, real duration | **new** one-to-one durable record |

No state was appended after `OUTPUT_VERIFIED`. `GenerationAttemptState`,
`GenerationSceneState`, `GenerationJobState`, reservation states, submission
certainty and the pricing schema are untouched.

## The durable state model

```text
(absent)            discovered by the runner; never written at completion time
PENDING             eligible at or after nextAttemptAt
RUNNING             one worker holds a lease
VALID               terminal, with all six normalized media facts
INVALID_MEDIA       terminal, with exactly one closed reason
INTEGRITY_MISMATCH  terminal, the object is no longer the verified bytes
```

`RETRYABLE_FAILURE` is **not** in this vocabulary. It is the validator's
transient outcome — the absence of a verdict — and returns the row to `PENDING`.

## Schema

| Choice | Why |
| --- | --- |
| Separate table, one-to-one on `sceneGenerationId` | Media validity is orthogonal to provider execution; appending a state would retroactively redefine existing rows |
| `sceneGenerationId` UNIQUE | Also the race resolver: exactly one concurrent insert wins |
| `onDelete: Restrict` | Durable validation history of a possibly-paid attempt is not erasable through a cascade |
| Enums for status, invalid reason, container | No raw ffprobe name, codec, stderr, JSON, command, signal, AWS error or temp path can ever be persisted |
| `BIGINT` for receipt size and all five media facts | The domain admits any positive safe integer; `int4` overflows at 2 GiB |
| `CHECK` bounds at `Number.MAX_SAFE_INTEGER` | Column range and domain range are the *same* range |
| Two worker indexes + one `scene_generations` index | Exactly what the sweep needs; none speculative |

## Immutable receipt binding

Every record carries the `receiptSha256` and `receiptSizeBytes` it was created
against, frozen at creation and equal to the attempt's `outputSha256` and
`outputSizeBytes`.

| Rule | How it is held |
| --- | --- |
| Bound at creation | The claim reads the attempt's durable receipt and writes it into the new row |
| Never repaired | A record whose receipt disagrees with the attempt's is a fixed internal defect; neither side is overwritten and no validation runs |
| Enforced on every write | The receipt is in the `WHERE` clause of every post-claim mutation, so a record cannot be closed over other bytes |
| Derived key, never trusted | The claim re-derives the managed key from organization + attempt and refuses a row whose stored key differs |

## Eligibility and discovery

An attempt is eligible only when `orchestrationState = OUTPUT_VERIFIED` and all
four output facts are present, and its record is absent, `PENDING` and due, or
`RUNNING` with an expired lease. Active leases and all three terminal states are
excluded.

**Absent records are discovered, not backfilled.** The completion transaction is
unmodified and no data migration creates rows. A `LEFT JOIN` treats `NULL` as
work to do, so attempts that reached `OUTPUT_VERIFIED` before this phase are
validated for the first time, lazily.

Candidate order is `outputVerifiedAt ASC, id ASC`, bounded by a validated limit
(1–100, refused rather than clamped). The listing is a hint only: the claim
re-checks every condition under its own transaction, proven by tests that change
the attempt's state between listing and claim.

## Concurrency and recovery

| Rule | How it is held |
| --- | --- |
| Three guards on every post-claim write | `version`, `leaseToken` and the receipt are all in the `WHERE` clause; a zero-row write reports `LOST`, which is a correct outcome |
| Concurrent creation | The unique index picks the winner; the loser re-reads once, bounded, and no Prisma exception escapes |
| Crash recovery | An expired lease is reclaimed with a fresh token, and `attemptCount` and `version` both advance |
| Stale finalize | A worker whose lease expired and whose row was reclaimed matches zero rows and cannot overwrite the winner |
| Terminal rows | Never reopened — the claim refuses them, whatever they say |
| Lease token | Opaque and random; carries no organization, scene, attempt, key or provider identity |

**Lease expiry is crash recovery, not a deadline.** Five minutes by default,
injected and validated, because the validator may stream a large object before
inspecting it. Nothing requires the work to finish by then; a validation that
outlives its lease may be redundantly re-executed, and the stale worker loses
safely. Acceptable because this work has no paid-provider side effect. No
heartbeat in this phase.

## No transaction spans external I/O

Structural, not conventional: **no repository method accepts a callback**, so
there is no shape in which a transaction can wrap an S3 GET, a stream
materialization, a temp-file write or `ffprobe`.

```text
claim (tx opens, tx closes)
  → validate()            no transaction open, no row lock held
    → finalize (tx opens, tx closes)
```

Proven three ways: a call-order assertion, a static ban on callback-shaped
signatures in `ports.ts`, and a live-database test that reads the committed
`RUNNING` row from inside the validator.

## Database-enforced row shape

`CHECK` constraints enumerate the permitted columns for each status, because
TypeScript cannot keep a row honest against a direct SQL write or a
partially-applied update:

| Status | Required | Forbidden |
| --- | --- | --- |
| `PENDING` | — | lease, reason, facts, `validatedAt` |
| `RUNNING` | non-empty `leaseToken`, `leaseExpiresAt` | `nextAttemptAt`, reason, facts, `validatedAt` |
| `VALID` | all six facts, `validatedAt` | lease, `nextAttemptAt`, reason |
| `INVALID_MEDIA` | `invalidReason`, `validatedAt` | lease, `nextAttemptAt`, facts |
| `INTEGRITY_MISMATCH` | `validatedAt` | lease, `nextAttemptAt`, reason, facts |

`ELSE FALSE` means a status added to the enum without updating the shape rule is
rejected rather than silently unconstrained.

## State freeze

| Aggregate | Proof |
| --- | --- |
| `SceneGeneration.orchestrationState` | Remains `OUTPUT_VERIFIED`; `stateVersion` unchanged, asserted against live rows |
| `GenerationScene`, `GenerationJob` | Row counts unchanged across a full run; the lifecycle names none of their vocabulary |
| `GenerationReservation`, quota | No `CONSUMED`, no `RESERVATION_*`, no reservation handle anywhere in the module |
| `SceneGenerationRequest` | Unchanged |
| `SYSTEM_RECOVERY` | No attempt created — asserted by count on every terminal path |

A static test bans the entire vocabulary of those aggregates from the lifecycle
module, so reaching them would require a visible, reviewable change.

## Dormancy

| Claim | How it is held |
| --- | --- |
| Nothing constructs the runner | Static scan for `new MediaValidationLifecycleRunner` across every production tree |
| Nothing schedules or invokes it | Static scan for `.runOnce(`/`.runOne(` and for `setInterval`, `setTimeout`, `cron`, `schedule(` |
| No production media validator | Unchanged scans for `new S3ManagedOutputMediaValidator`, `new FfprobeMediaProbe`, `createDefaultProcessRunner(` |
| No subprocess, network or storage client in the lifecycle | Static bans on `node:child_process`, `execFile`, `fetch(`, `S3Client`, `process.env` |
| No credential wiring | `FAL_KEY`, AWS keys, `S3_BUCKET`, `FFPROBE_PATH` absent from the environment schema |
| Dependency direction | Domain imports no `@app/storage`, `@app/database` or `@prisma/client`; the repository imports no `@app/storage` |
| No real ffprobe/AWS/fal in CI | Every test drives a scripted fake validator |

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass — all projects |
| `pnpm lint` | Pass — 0 problems |
| `pnpm test` | **4209 passed**, 126 files |
| `pnpm test:db` (live PostgreSQL) | **796 passed**, 24 files |
| `pnpm build` | Pass |
| `prisma validate` / `format` | Pass |
| Migrations against an empty database | Pass — applied cleanly to a fresh database |
| Prisma drift | `No difference detected` |

## Mutation ledger

M01–M65 carry forward. M66–M78 added for the new durable failure domain; M71 was
re-aimed once during development, documented below.

| # | Defect | Killed by |
| --- | --- | --- |
| **M66** | A non-`OUTPUT_VERIFIED` attempt becomes eligible | direct-claim refusal tests |
| **M67** | The record is bound to a caller-shaped receipt, not the attempt's | receipt-binding tests |
| **M68** | A transient failure is written as a terminal invalid-media verdict | release-to-`PENDING` tests |
| **M69** | Finalize ignores the lease token | stale-worker tests |
| **M70** | Finalize ignores the durable version | stale-version tests |
| **M71** | A terminal record may be reopened by a new claim | terminal-reopen tests |
| **M72** | An expired `RUNNING` lease can never be reclaimed | crash-recovery tests |
| **M73** | Due time and active leases are ignored by discovery | candidate-eligibility tests |
| **M74** | The finalize receipt guard is dropped | receipt-mismatch tests |
| **M75** | An out-of-range persisted integer is narrowed lossily | corrupt-fact narrowing tests |
| **M76** | A malformed validator result is persisted as a verdict | malformed-result tests |
| **M77** | A thrown validator escapes raw | defect-leakage tests |
| **M78** | The batch limit is no longer bounded before SQL | limit-validation tests |

**M71 re-aim, stated explicitly.** It first targeted the `status: "RUNNING"`
clause in the finalize `WHERE`. That mutation is *unobservable*: every transition
increments `version` and clears `leaseToken`, so a replayed claim already fails
on both guards, and the database's shape constraint forbids a terminal row from
holding a lease at all. The clause is deliberately kept as redundant defence, but
it cannot be killed by any test, so M71 was re-aimed at the claim-level terminal
branch — the guard that actually protects a settled verdict from being reopened.
The mutation's stated intent is unchanged.

## Not done, on purpose

- No Scene `READY`, Job `SCENES_READY`/`READY_FOR_COMPOSITION`, Scene delivery
  or Job readiness.
- No quota `CONSUME`, no reservation settlement.
- No `SYSTEM_RECOVERY` creation on `INVALID_MEDIA` or `INTEGRITY_MISMATCH`.
- No provider retry policy, submission, composition, upscale or payment.
- No scheduler, cron or worker activation; no production wiring of any kind.
- No exponential backoff or dead-letter policy — a fixed retry delay only.

Where a media verdict enters the product lifecycle is the next reviewed
package's decision.
