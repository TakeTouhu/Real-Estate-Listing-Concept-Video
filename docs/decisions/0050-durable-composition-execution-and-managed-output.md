# ADR-0050 — Durable composition execution and the managed final output

Status: Accepted (Phase 5B)
Supersedes: nothing. Extends ADR-0049 (durable deliverable composition plan),
ADR-0046 (atomic validated Scene delivery) and ADR-0024 (state-driven workers,
no broker).

## Context

ADR-0049 froze *which* immutable scene renditions belong to a customer's next
deliverable, and left the job in `COMPOSITION_PENDING` with nothing draining it.
Phase 5B answers the next question, and it is the first one in this system whose
answer runs an encoder over paid generated media and publishes a file a customer
will eventually be shown:

> how does one frozen plan become one managed object, and what happens every
> way that can fail?

Three properties make this different from every earlier durable workflow.

**The work is long and expensive.** A composition downloads up to two gigabytes
and may run an encoder for twenty minutes. Anything holding a database
transaction across that pins a pooled connection for the whole encode, and one
slow deliverable becomes a database-wide outage.

**The work is duplicable.** A lease can expire under a healthy worker, so two
workers may compose the same deliverable. That has to be *safe*, not prevented,
because preventing it reliably would require a heartbeat protocol this phase has
no reason to introduce.

**Most of the ways it fails are not transient.** This is the part earlier phases
did not have to face. A provider call that fails may succeed next time. A plan
whose frozen source bytes total three gigabytes will total three gigabytes
forever.

---

## Decision 1 — Composition profile v1 is a closed table, not a computation

`vtavision-compose:v1` fixes every encoder decision: H.264 in MP4, `yuv420p`,
constant 30/1 frame rate, CRF 18, `medium` preset, `+faststart`, hard cuts, no
audio, and contain-and-pad to one of six rasters.

The raster table is written out rather than derived:

| aspect | 720p | 1080p |
| --- | --- | --- |
| 16:9 | 1280×720 | 1920×1080 |
| 9:16 | 720×1280 | 1080×1920 |
| 1:1 | 720×720 | 1080×1080 |

A formula over a free-form aspect string is how `21:9` silently becomes 16:9 — a
letterboxed delivery the customer never agreed to, produced by rounding. An
unsupported combination refuses instead.

Every dimension is even because `yuv420p` subsamples chroma by two on both axes.
That is a property of the format, not a preference, and the migration asserts it
on the persisted columns too.

Nothing in the profile is inferred from a provider, a model id, a capability
descriptor or the source media's own properties. A profile inferred from the
provider would change under the customer's feet the day a model's native output
changed, and two deliverables of one job would encode differently for a reason
nobody chose.

### What v1 deliberately does not do

No crop, no speed change, no transition beyond a hard cut, no audio, no overlay,
no watermark, no disclosure burn-in. Each is a product decision with its own
review, and several are legally meaningful.

`force_original_aspect_ratio=decrease` with a pad is the whole no-crop policy: a
9:16 source delivered into a 16:9 raster is shown whole with black at the sides.
Cropping decides for the customer which part of their property photo is worth
keeping, and this phase has no authority to make that decision.

## Decision 2 — The profile is frozen at first claim and reused verbatim

Every column of the profile is written onto the work row the first time it is
created, and a retry reads it back rather than re-deriving it. A build carrying
profile v2 that re-derived would encode the retry of a v1 deliverable with v2
settings, and the two halves of one deliverable's history would disagree about
what the customer was promised. A profile whose key is not v1 refuses to run at
all, which turns a silent product change into an operational decision.

## Decision 3 — `GenerationDeliverableComposition` is the durable work

One row per planned deliverable version, unique on `deliverableVersionId`, and
it *is* the queue — ADR-0024's rule, unchanged. There is no broker, no Redis, no
SQS. A worker discovers work by querying rows.

```text
(absent)         a COMPOSITION_PENDING job whose plan nobody has claimed
PENDING          eligible again at or after nextAttemptAt
RUNNING          one worker holds a lease
BLOCKED          automatic execution cannot progress against these facts
OUTPUT_VERIFIED  canonical final bytes exist, with a SHA-256 receipt
```

## Decision 4 — Transient and deterministic failures are different states

This is the decision the rest of the phase is shaped around.

`PENDING` means *try again later*. `BLOCKED` means *trying again cannot help*.
Two disjoint closed vocabularies carry the reasons, and no value appears in both:

| `lastRetryCode` (transient) | `blockCode` (deterministic) |
| --- | --- |
| `SOURCE_READ_RETRYABLE` | `SOURCE_BYTES_LIMIT_EXCEEDED` |
| `COMPOSER_RETRYABLE` | `DURATION_INVARIANT_MISMATCH` |
| `OUTPUT_PUBLISH_RETRYABLE` | `SOURCE_INTEGRITY_MISMATCH` |
| | `OUTPUT_SIZE_LIMIT_EXCEEDED` |

Every block code is decidable against facts that cannot change by themselves:
the plan is immutable, the profile is frozen, and canonical source objects are
first-wins. Re-running the identical work would reach the identical answer.

Deferring one of them instead produces an automatic infinite retry the moment a
scheduler exists — the work is re-offered every five minutes, fails identically
every time, and nothing in the system ever says so. That is the failure mode
this decision exists to prevent, and it is invisible until the scheduler is
switched on.

### `lastRetryCode` means exactly one thing

It is *why this work is currently deferred for automatic retry*, so it is
cleared the moment the work stops being deferred: on claim, and on block. A
column that sometimes means "why it is waiting" and sometimes means "what once
went wrong" is a column no operator can read, and a blocked row showing both a
transient and a terminal reason shows two competing explanations for one fact.
`attemptCount` already records that the work was tried. Retry-reason *history*,
if it is ever wanted, is a separate audited design rather than an overload of
this field.

## Decision 5 — `BLOCKED` is not customer failure, and invents no lifecycle state

There is no `FAILED` here and `BLOCKED` is not one. It terminates *this phase's
automatic work* and nothing else:

- the job stays `COMPOSING` and is never terminalized,
- no unit is consumed and no reservation is read or released,
- `currentDeliverableVersionId` does not move,
- no customer-facing failure is recorded,
- **no transition event is appended, on either aggregate.**

The reason is sharpest for recomposition: the customer may already hold a
perfectly good video while a regeneration's replacement cannot be encoded.
Terminalizing that job would destroy a deliverable they already have, and
settling an entitlement over an encoder limit charges the platform's problem to
them.

The no-event rule follows from the same honesty. The job really does stay
`COMPOSING`, so a job event would assert a state change that did not happen —
and inventing a `COMPOSITION_BLOCKED` deliverable state to carry the fact would
put a value in the transition-event stream that no reviewed state machine
contains, which every later reader would then have to interpret. The durable row
says it exactly: `status = BLOCKED`, with a `blockCode` and a `blockedAt`.

There is deliberately **no unblock operation** in this phase. An operator
recovery path is its own reviewed surface, and it can add an event model when it
needs one.

## Decision 6 — Deterministic refusals are proved before any adapter runs

Two facts are decidable from the claim alone, and both are checked after the
claim and before the materializer, composer or publisher is touched:

1. the plan's frozen `sourceSizeBytes` must total at most 2 GiB;
2. the frozen `snapshotDurationSeconds` must sum to the job's
   `requestedDurationSeconds`.

The order is fixed — budget, then duration — so a plan violating both always
records the same code on every worker and every attempt.

There is deliberately **no redistribution rule** for a duration mismatch.
Stretching or trimming scenes to reach the admitted length would silently change
what was agreed, and the honest answer is to stop.

Checking first is not an optimization. Downloading gigabytes to rediscover
arithmetic that was already knowable wastes a worker, and it is the difference
between a refusal that costs nothing and one that costs a full transfer every
time it is retried.

## Decision 7 — An unsupported delivery target is an outcome, not a defect

A job whose frozen `targetAspectRatio` is outside profile v1 is answered with
`UNSUPPORTED_TARGET`, and the transaction writes nothing: no work row, no lease,
no job transition, no event. Such a job was admitted legitimately under a target
this profile version cannot deliver, which is an ordinary fact about the
deployment rather than a corrupted state. Manufacturing a `RUNNING` row for work
that can never run would make it a candidate forever.

Candidate discovery filters those pairs out using the domain's own raster table
rather than a second hand-written list in SQL. Leaving them listable would let
enough of them crowd out work that can actually be composed — the starvation the
bounded batch exists to prevent.

`targetOutputResolution` is already constrained by
`generation_jobs_target_resolution_check` to exactly the two resolutions v1
composes, so the aspect ratio, which is free-form text, is the only reachable
vector today. The profile's resolution refusal remains as defence against a
future product tier being added to the job vocabulary without being added to the
raster table.

## Decision 8 — Transactions J1 and J2, with all external work between them

```text
J1  claim     COMPOSITION_PENDING -> COMPOSING, work created RUNNING
    (retry)   PENDING | expired RUNNING -> RUNNING, job untouched
--- external: materialize, compose, publish ---
J2  finalize  work -> OUTPUT_VERIFIED, COMPOSING -> DELIVERABLE_VALIDATING
    defer     work -> PENDING with a retry code, job untouched
    block     work -> BLOCKED with a block code, job untouched, no event
```

Each is short and database-only: no object-store read, no subprocess, no HTTP
and no temporary file is reachable from inside any of them.

**Lock order: `GenerationJob → GenerationDeliverableVersion → composition work`.**
The reservation is neither joined nor locked, because composition execution moves
no entitlement. The system-wide `Reservation → Job` rule constrains transactions
that lock *both* rows; adding a reservation lock here purely for symmetry would
create contention with settlement over a row this code never touches.

A first claim also moves the job and appends two events. A retry claim does
neither: the job is already `COMPOSING`, and a second
`COMPOSITION_PENDING -> COMPOSING` event would record a state change that did
not happen.

## Decision 9 — Duplicate execution is designed for, not prevented

A lease can expire under a healthy worker. That is safe by construction rather
than by luck:

- the plan and the profile are immutable, so both workers intend the same video;
- canonical publication is first-wins, so the second never overwrites the first;
- finalize, defer and block are all guarded by lease token **and** row version,
  so only one writes history.

The loser's work is wasted, never wrong.

The lease is 30 minutes by default and two hours at most — far longer than the
media lifecycle's, because this work downloads gigabytes and runs an encoder. It
must always exceed the composer timeout plus the I/O around it, or a healthy long
encode has its lease stolen and two workers encode the same deliverable for no
reason.

## Decision 10 — The receipt is read back from the object that is actually there

`putObjectIfAbsent` is a conditional create, so a retry never overwrites an
existing canonical object. Whether the call created the object or found it
occupied, the publisher then **re-reads the object at the key** and returns its
real digest and byte count.

That is what makes "published, then crashed before the database learned of it"
recoverable: the retry finds an object it did not write and finalizes against
its actual digest. Assuming the local file and the canonical object are equal
would durably record a receipt for an object nobody read.

An ETag is never used as a SHA-256. It is not one for a multipart object, and
trusting it would record a receipt no reader could reproduce.

## Decision 11 — The managed deliverable key is its own brand

```text
org/{organizationId}/deliverables/{deliverableVersionId}/output
```

Two application-generated identifiers and nothing else. No project or property
name, no customer filename, no timestamp, no ordinal: a key built from external
text is a path traversal and a cross-tenant write waiting for the first
unexpected input, and an ordinal would change if it were ever recomputed.

`ManagedDeliverableOutputKey` is deliberately a **different brand** from
`ManagedGenerationOutputKey`. A provider attempt's output and a composed
deliverable are different identities with different lifecycles, and one type
covering both would let a deliverable be published over an attempt's object with
the compiler's blessing.

The key is extensionless for the same reason the generation key is: the receipt
proves a digest and a byte count, not a container.

## Decision 12 — Four ports, four boundaries, and no shell

The repository is the only thing that touches a database, the materializer the
only thing that reads object storage, the composer the only thing that runs a
subprocess, and the publisher the only thing that writes the canonical object.
Every port returns a **closed** outcome: storage messages, `ffmpeg` stderr, OS
errno values, bucket names and local paths stop at each boundary.

The composer is invoked through an injected `ProcessRunner` — a fixed program
and a fixed argument vector, with no shell. There is no command *string*
anywhere in the module, because nothing is parsed by a shell. No customer text,
prompt, filename, bucket, key or provider URL is ever an argument.

`ProcessRunner` moved into a types-only module this phase, shared by the media
inspector and the composer. The seam belongs to neither adapter, and reaching it
through the inspector's module made a type-only import look like coupling to
media inspection — which the repository's dormancy tripwire reads as exactly
that. Extracting it keeps the tripwire at full strength rather than adding an
exemption that would also excuse the constructor bans it enforces in the same
pass. It remains narrow on purpose: no `cwd`, no environment, no stdin, no
command string.

### Temporary files carry no identity

One random directory per execution and fixed names inside it: `input-0000`,
`input-0001`, …, `output.mp4`. Nothing is derived from an organization, job,
scene, property or customer filename. A local path built from customer data is
how a filename ends up in a log line, an error message or a crash dump — and the
composer's arguments are exactly where that would be most visible.

Cleanup is unconditional and never the answer: the directory is removed on every
exit path and a cleanup failure is swallowed. Leaving a temporary directory
behind is an operational annoyance; replacing a successful composition's outcome
with an `rmdir` error is a defect.

## Decision 13 — Sources are proved against the plan's receipt, streaming

Each canonical source is streamed to disk while being hashed and counted, never
buffered whole — a 512 MiB clip held in memory per scene is how one worker takes
a machine down. The plan's frozen byte count is the stream's ceiling, so an
object longer than its receipt is concluded wrong there rather than after another
gigabyte of reading.

The receipt comparison is the last step and the only one that may conclude the
bytes are wrong. A read failure is not evidence that the bytes are wrong, and
calling it one would have an operator chasing a corrupt object that does not
exist.

Any single disagreement refuses the whole materialization. A deliverable
composed partly from bytes nobody validated is worse than no deliverable.

## Decision 14 — `OUTPUT_VERIFIED` claims less than it sounds like

It claims exactly this: an object exists at the canonical deliverable key, and
its digest and byte count were established by reading the bytes that are actually
there.

It does **not** claim the file is playable, that the container is well formed,
that a customer may see it, that the deliverable pointer moved, or that anything
was billed. Deliverable-level media validation is Phase 5C's, and it deliberately
does not reuse `ManagedOutputMediaValidation` — that record is one-to-one with a
*provider attempt*, and a composed deliverable is not one.

## Decision 15 — Dormant

Nothing constructs the execution repository, the runner, the materializer, the
composer or the publisher anywhere in production. There is no scheduler, no
timer, no loop and no environment variable. The runner exists, is fully tested,
and has no production caller. Activating it is its own reviewed decision.

`ffmpeg` is not required by CI: no test in this phase launches a subprocess. The
composer's argument vector is pinned element by element without running anything.

---

## Phase boundary

Phase 5B ends with a managed object and a durable receipt, and the job in
`DELIVERABLE_VALIDATING`. It does not validate that object, publish it to a
customer, move `currentDeliverableVersionId`, consume a unit, settle a
reservation, notify anyone, or provide an operator path out of `BLOCKED`. Each of
those is a later, separately reviewed decision.

## Consequences

**Good.** A crashed composition is reconstructable from durable rows alone. A
deterministic refusal is visible and finite instead of an invisible infinite
retry. Two workers racing produce one deliverable and one history. No customer's
existing video can be destroyed by a failure to compose its replacement. The
encoder cannot be handed customer text in any form.

**Accepted cost.** A `BLOCKED` deliverable needs a human, and this phase gives
them no button — only a row that says exactly what happened and when. That is
deliberate: an unblock operation that re-queues work without deciding *why* it
was blocked would re-enter the loop this phase exists to end.

**Accepted cost.** Duplicate execution wastes a worker's transfer and encode when
a lease expires under a healthy run. The alternative — a heartbeat protocol —
adds a failure mode of its own, and the wasted work is bounded by the lease.
