# ADR-0045 — Durable managed-output media-validation lifecycle

- Status: Accepted (Phase 4C-3B-2H-3B-5)
- Supersedes: nothing. Extends ADR-0044 (dormant media validation) and ADR-0038
  (managed output integrity).

## Context

ADR-0044 added a media validator that can answer, for an object already at a
canonical managed key, "is this an MP4-family container with a usable video
stream and a real duration?" — and nothing kept the answer. The validator was
dormant and its result was ephemeral.

This phase makes that answer **durable and safely retryable**. It does not make
it *mean* anything yet: no Scene becomes ready, no recovery attempt is created,
no quota moves. Production media validation is **not** active — nothing
constructs the runner, schedules it, or calls it.

## Decision 1 — Media validity is a separate record, not another attempt state

`OUTPUT_VERIFIED` remains terminal for the provider-attempt byte-integrity
lifecycle and keeps its exact meaning:

```text
canonical managed bytes were copied and byte-level integrity was verified
```

Appending a media state after it would do two bad things at once. It would
retroactively redefine what every already-`OUTPUT_VERIFIED` row claimed — rows
written months ago would suddenly be asserting something nobody checked. And it
would bind a question about container structure to a state machine about
provider execution, so a future change to one would drag the other along.

So media validity gets its own one-to-one record, `ManagedOutputMediaValidation`,
with its own closed vocabulary. The existing `GenerationAttemptState`,
`GenerationSceneState`, `GenerationJobState`, reservation states, submission
certainty and pricing schema are untouched.

## Decision 2 — One-to-one, keyed by the attempt

One attempt's output is one object, so one verdict. The uniqueness on
`sceneGenerationId` is not merely tidiness: it is the mechanism that resolves
the concurrent-creation race, because exactly one insert can win.

### Losing that race must not poison the transaction

Two workers can both read the row as absent and both try to create it. *How*
the loser loses decides whether the claim transaction survives.

A unique-constraint violation **aborts the PostgreSQL transaction**. Catching the
driver's error in JavaScript does not restore it: every subsequent statement on
that connection fails with `25P02 current transaction is aborted, commands
ignored until end of transaction block`. So "insert, catch the duplicate-key
error, then re-read inside the same transaction" is not bounded recovery — it is
a second, worse failure, and the re-read never runs.

The first-record insert is therefore conflict-free:

```sql
INSERT INTO "managed_output_media_validations" (…)
VALUES (…)
ON CONFLICT ("sceneGenerationId") DO NOTHING
RETURNING "id", "version"
```

It inserts at most one row and returns zero rows when another worker already
holds the key — no error is raised, so the transaction stays healthy and the
loser simply reads what the winner wrote. One read, no loop, and the winner is
never reclaimed or overwritten during the first-record race. Every value is
bound as a parameter by Prisma's tagged template; nothing is interpolated into
SQL.

## Decision 3 — The receipt binding is immutable

Every record permanently carries the `receiptSha256` and `receiptSizeBytes` it
was created against, and they must equal the attempt's `outputSha256` and
`outputSizeBytes`.

A validation answers a question about *specific bytes*. Without naming them
permanently, a record created against one object could later be read as a
verdict about a different object at the same key — precisely the situation
`INTEGRITY_MISMATCH` exists to detect, and one that "repairing" the record would
silently erase.

So the binding is never rewritten. If a record's receipt disagrees with the
attempt's durable receipt, that is a fixed internal consistency defect: neither
side is overwritten, and no validation runs under the old record. Validating new
bytes under an old record would silently answer a different question from the
one the record claims to answer.

Every post-claim write also carries the receipt in its `WHERE` clause, so a
record cannot be closed over bytes other than the ones it is bound to.

## Decision 4 — Absent records are discovered, never backfilled

The completion transaction is deliberately **not** modified to create validation
rows, and no data migration creates them for existing attempts.

An attempt that reached `OUTPUT_VERIFIED` before this phase has no record, and a
backfilled row would have to claim a status nobody established. Instead the
*absence* of a row is itself an eligible state: the candidate sweep uses a
`LEFT JOIN` and treats `NULL` as work to do. Historical attempts are therefore
validated for the first time, lazily, and completion keeps its existing shape and
its existing tests.

## Decision 5 — Lease and version concurrency

A worker takes ownership by writing an opaque random lease token and an expiry,
and by incrementing `version`. Every write after the claim carries three things
in its `WHERE` clause:

```text
version        the row has not moved since the claim
leaseToken     this worker, not one that reclaimed the row
receipt        still the same bytes the claim was established against
```

A stale worker's late finalize therefore matches zero rows. That is reported as
`LOST` — a correct outcome, not an error — and the reclaiming worker's verdict
stands. Terminal rows are never reopened: the claim refuses them outright.

The lease token is opaque and random, carrying no organization, scene, attempt,
key or provider identity, so it discloses nothing if it is ever logged.

## Decision 6 — Lease expiry is crash recovery, not a deadline

The lease defaults to **five minutes**, injected and validated rather than
hard-coded, because the validator may stream a large managed object out of
object storage before it inspects it — a two-minute assumption would make
ordinary work look like a crash.

Expiry says how long the system waits before assuming the owner died. It does
**not** claim the validation must finish by then. A validation that outlives its
lease may be redundantly re-executed, and the stale worker loses safely at
finalize. That is acceptable precisely because this work has no paid-provider
side effect: it re-reads an object the platform already owns. No heartbeat is
implemented in this phase.

## Decision 7 — `RETRYABLE_FAILURE` is not a durable verdict

The validator's transient outcome is not a statement about the video; it is the
absence of one. It returns the row to `PENDING`, clears the lease, and sets
`nextAttemptAt` to now plus a validated retry delay (default 30 seconds).

There is deliberately **no** durable `RETRYABLE_FAILURE` status. A storage
hiccup must never become a permanent record that a customer's output is
unusable. A fixed delay is used rather than an exponential backoff curve and a
dead-letter policy: those are real decisions about how long to keep retrying and
when to escalate, and this phase has no authority to make them.

A thrown validator, or a result the existing closed parser rejects, is handled
the same way — the lease is handed back best-effort — and then a fixed
application-owned defect is raised. Neither is ever persisted as
`INVALID_MEDIA`, and no external exception text, offending value or `cause`
crosses the boundary.

## Decision 8 — No database transaction spans external I/O

This is enforced by the **shape** of the repository port, not by a comment. No
method accepts a callback, so there is no way to write:

```ts
repository.withClaim(id, async (claim) => { /* S3 GET, ffprobe, … */ })
```

The runner must call three separate operations, each opening and closing its own
short transaction:

```text
claim (tx opens, tx closes)
  → validate()            no transaction open, no row lock held
    → finalize (tx opens, tx closes)
```

A convenient callback API would silently hold a row lock and a pooled connection
for the entire duration of a multi-megabyte download. Under load that is how a
connection pool is exhausted by work that is not touching the database at all.

## Decision 9 — The database enforces the row shape

TypeScript cannot keep a row honest. A direct SQL write, a future repository
bug, or a partially-applied update can all produce a row whose status and
columns disagree — a `VALID` row with no facts, a terminal row still holding a
lease, a `PENDING` row carrying a verdict. Each would be read later as a durable
claim about a customer's video.

So a `CHECK` constraint enumerates the permitted column shape for each status,
alongside constraints on the receipt format, the receipt range, the counters and
every media-fact range. `ELSE FALSE` means a status added to the enum without
updating the shape rule is rejected rather than silently unconstrained.

## Decision 10 — Closed vocabularies and BigInt facts

Status, invalid reason and container are database enums, not text. A raw ffprobe
format name, codec, stderr line, JSON blob, command string, signal name, AWS
error or temporary path cannot become persisted state even through a direct SQL
write.

The receipt size and all five media facts are `BIGINT`, matching
`scene_generations.outputSizeBytes`: the domain admits any positive safe integer
and `int4` overflows at 2 GiB on a value the validator accepted. Each is bounded
at `Number.MAX_SAFE_INTEGER` by `CHECK`, so the column's range and the domain's
range are the same range, and the repository refuses to narrow an out-of-range
value on read — because a constraint added by a migration is not evidence about
a database that migration has not reached. `audioStreamCount` may be zero; the
rest are positive.

## Decision 11 — Scene, Job and quota semantics are deferred, deliberately

A `VALID` record does not make a Scene ready. An `INVALID_MEDIA` or
`INTEGRITY_MISMATCH` record does not create a `SYSTEM_RECOVERY` attempt, fail a
Scene, release or consume quota, or touch a reservation.

Those are decisions about what a media verdict *means*, and they interact with
entitlement accounting and customer-visible failure. Making them in the same
change that introduces the durable fact would mean reviewing two very different
risks at once. This phase's job is to produce a trustworthy fact; the next
reviewed package decides what to do with it. Static tests assert the lifecycle
code cannot name any of that vocabulary.

## Decision 12 — No production scheduler

Nothing constructs the runner, schedules it, or invokes it. No cron, interval,
worker loop or queue consumer exists for it. No `FAL_KEY`, AWS credential or
`FFPROBE_PATH` enters the environment schema, and no test touches a real fal,
AWS or `ffprobe` surface. Activating the sweep is a separate, reviewed decision
with its own operational questions — concurrency, rate, alerting — none of which
this phase answers.

## Consequences

- Media validity becomes a durable, auditable, crash-recoverable fact.
- Historical `OUTPUT_VERIFIED` attempts become discoverable without a backfill.
- `OUTPUT_VERIFIED` keeps its meaning, and no existing state vocabulary changed.
- Nothing runs yet; a later package decides what a verdict means and turns the
  sweep on.
