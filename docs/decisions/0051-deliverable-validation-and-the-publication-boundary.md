# ADR-0051 — Deliverable validation and the publication boundary (Transaction G)

Status: Accepted (Phase 5C)
Supersedes: nothing. Extends ADR-0050 (durable composition execution),
ADR-0049 (durable deliverable composition plan), ADR-0045 (durable managed-output
media validation lifecycle) and ADR-0046 (atomic validated Scene delivery).

## Context

ADR-0050 leaves a job in `DELIVERABLE_VALIDATING` with an `OUTPUT_VERIFIED`
composition behind it. `OUTPUT_VERIFIED` claims exactly one thing: an object
exists at the canonical deliverable key and its digest and byte count were
established by reading the bytes that are actually there. It does **not** claim
the file is playable, and nothing drains that state.

Phase 5C answers the last two questions in the delivery pipeline, and they are
different questions that people conflate:

> is the composed object *media a customer may be shown*?
>
> and, separately: at what exact moment does that become the customer's video and
> their unit become spent?

The second one is the only place in this system where a customer is charged for
something. Everything below is shaped by that.

---

## Decision 1 — A deliverable verdict is its own record, bound to the version

`ManagedOutputMediaValidation` is one-to-one with a `SceneGeneration`, and the
schema says so with a `@unique` column and a required foreign key. A composed
deliverable is not a provider attempt: it is the concatenation of many, with its
own canonical key, its own receipt and its own version history.

Widening that binding to mean "either an attempt or a deliverable" would make
every existing row's `sceneGenerationId` optional and every existing query
ambiguous, in order to express a relationship that is genuinely different. So
Phase 5C adds `generation_deliverable_validations`, one row per deliverable
*version*.

The **version**, not the composition row. The version is the immutable identity a
customer's pointer names; the composition row is execution state carrying a
lease, an attempt count and a retry code, and it is the thing Phase 5B rewrites.
A verdict hung off execution state would be a verdict about an attempt.

The media *vocabulary* is reused verbatim — `ManagedOutputMediaInvalidReason`,
`ManagedOutputContainerFamily`, and the five normalized facts. "Is this file
playable video" is the same question either way, and a second five-member copy of
those enums would drift from the first the moment either is extended. One
adapter answers both, through two distinct ports: the keys are different brands
with different lifecycles, so the compiler still refuses to hand a deliverable
receipt to an attempt's object.

**Statuses:** `PENDING`, `RUNNING`, `VALID`, `INVALID_MEDIA`,
`INTEGRITY_MISMATCH`. `RETRYABLE_FAILURE` is deliberately not one. It is not a
verdict about the video; it is the absence of one, and it returns the row to
`PENDING` with a future instant — the same discipline ADR-0045 settled for
attempts. A storage hiccup must never become a permanent record that a customer's
deliverable is unusable.

## Decision 2 — The verdict binds to the exact receipt, and three receipts must agree

The validation row freezes the composition's `outputSha256` and `outputSizeBytes`
when it is created, and never refreshes them. Every later write re-asserts three
things at once:

```text
the caller's receipt        what was validated, or is being published
the row's frozen binding    what this record has always been about
the composition's receipt   what the platform says it published
```

Comparing only two of them leaves the third free to move. An earlier draft of the
repository proved the claim against the frozen binding and then read the
composition receipt *without* comparing it, so a composition whose receipt
changed underneath a running validation was finalized as a verdict about bytes
nobody had measured. A database test found it, and the three-way proof is now one
function with one call site per transaction.

A disagreement is a defect, never a repair. "Repairing" the frozen binding to
match a newer receipt is precisely how the evidence that two different objects
were believed canonical is destroyed.

## Decision 3 — Transaction G is a separate commit from the verdict

The runner performs four steps, in three transactions:

```text
claim      (tx opens, tx closes)
  → validate()                 no transaction open, no row lock held
    → finalize (tx opens, tx closes)
      → publish  (tx opens, tx closes)   ← Transaction G
```

Folding the verdict and the publication into one commit would be simpler and
would delete a state this system needs: *validated, not yet published*. A process
that dies between them must be recoverable, and it is recoverable only because
the `VALID` row survives on its own and the next sweep finds a
`DELIVERABLE_VALIDATING` job standing behind it — a fourth candidate-discovery
arm exists for exactly that.

It also matters that Transaction G is **last**. It takes the entitlement lock, and
an entitlement lock held across a hundreds-of-megabytes download is contention
with every cost workflow in the system.

## Decision 4 — Publication is one commit: job, pointer, hold, events

Transaction G moves `DELIVERABLE_VALIDATING -> DELIVERABLE_READY`, writes
`GenerationJob.currentDeliverableVersionId`, consumes the hold where one is owed,
and appends every transition event — together or not at all. Both edges into
`CONSUMED` were already reserved for it in the generic transition API, and they
stay reserved now that it exists: reaching `DELIVERABLE_READY` generically would
deliver a video nobody validated, and reaching `CONSUMED` generically would charge
for one nobody received. Transaction G is also the only writer of `consumedAt`.

**Two publication shapes, and no third.** They are read back at the end of the
cycle from the same two facts Transaction I admits one for:

| pointer | hold | shape | unit |
| --- | --- | --- | --- |
| `NULL` | `RESERVED` or `RECONCILIATION_HOLD` | initial | spent |
| an earlier version | `CONSUMED` | recomposition | **not** spent |

Anything else fails closed. A job with no deliverable and a `CONSUMED` hold has
been charged for something nobody received; a job with a deliverable and a
`RESERVED` hold delivered something nobody was charged for.

A recomposition spends nothing, and that is not a special case bolted on: the
customer paid once for the job, `CONSUMED` has no outgoing edge in the state
machine, and Transaction I already refuses to plan a recomposition unless the
hold is already `CONSUMED`. The branch makes explicit what the state machine
already made impossible.

`RECONCILIATION_HOLD -> CONSUMED` is admitted rather than deferred. A validated
deliverable the customer is about to receive is exactly the evidence a hold was
waiting for, and deferring on a hold risks a deliverable that can never be
published if the hold later resolves to `RELEASED`.

## Decision 5 — The lock order is Reservation → Job, and the read is a separate statement

Transaction G locks:

```text
GenerationReservation → GenerationJob → deliverable version → composition → validation
```

**Reservation before Job**, the order Transaction H and Transaction I both take,
measured against the real settlement path. Taking the job first would close a real
deadlock cycle with settlement, which holds the reservation and then waits for the
job. Both directions are pinned behaviourally against the real publication path,
because the aliases after `FOR UPDATE OF` do not decide acquisition order and
neither does the `FROM` clause's text order.

The validation lifecycle transactions — claim, finalize, defer — lock
`Job → version → composition → validation` and do **not** touch the reservation at
all. That is not an inconsistency with the rule: the rule constrains transactions
that lock *both* rows. Validation moves no entitlement, and because these
transactions never take the reservation they cannot form the inverse pair with
Transaction G either.

**The lock and the read are separate statements**, and that is load-bearing rather
than stylistic. Under `READ COMMITTED`, a statement that blocks on `FOR UPDATE`
re-evaluates the *locked* row when released, but every other table in the same
statement is still read from the snapshot taken when the statement began. A single
locking statement with the validation row outer-joined into it therefore returns a
**pre-block** view of it: two workers racing to create the first record both saw
no row, both inserted, and the loser learned it through a raw uniqueness error
rather than through the outcome union its caller is written against. A race test
against two real connections found this and now pins it.

## Decision 6 — A verdict short of `VALID` changes nothing else

`INVALID_MEDIA` and `INTEGRITY_MISMATCH` are durable and terminal, and they append
**no transition event on any aggregate**. The job really does stay
`DELIVERABLE_VALIDATING`, so a job event would assert a change that did not
happen, and a `DELIVERABLE_INVALID` aggregate state would put a customer-visible
failure in the event stream that no reviewed state machine contains.

Nothing else moves either: the job is not terminalized, no unit is consumed, no
reservation is released, and the customer's pointer does not move. The reason is
sharpest for recomposition — the customer may already hold a perfectly good video
while its replacement cannot be validated, and terminalizing that job would
destroy what they already have. This is the same restraint ADR-0050 chose for
`BLOCKED`, and for the same reason.

A settlement policy for a permanently unusable deliverable is a separate, reviewed
decision. Phase 5C does not make it.

## Decision 7 — No pointer regression, ever

Once a recomposition begins, the job returns to `DELIVERABLE_VALIDATING` while the
customer's *existing* version still has an `OUTPUT_VERIFIED` composition and a
`VALID` verdict. Without a guard it would be listed as a candidate, offered to
Transaction G, and refused forever while occupying a slot in every bounded batch.

Two guards, at both ends. Candidate discovery offers only the job's
highest-ordinal version, and Transaction G refuses any version whose ordinal is
not strictly greater than the ordinal the pointer currently names. Ordinals are
job-scoped and strictly increasing, so "newer than what the customer holds" is
exactly "a higher ordinal", and an equal or lower one would replace a customer's
video with an older rendition.

---

## Consequences

A composed deliverable is proved playable before anyone can be shown it. A
customer's unit is spent in the same commit that makes the video theirs, once,
whatever crashes or races happen around it — replays answer `ALREADY_PUBLISHED`
and write nothing. A recomposition never charges twice. A deliverable that cannot
be validated leaves every durable fact exactly where it was.

**Accepted cost.** An `INVALID_MEDIA` or `INTEGRITY_MISMATCH` deliverable strands
its job in `DELIVERABLE_VALIDATING` with no automatic way forward, exactly as a
`BLOCKED` composition strands one in `COMPOSING`. That is deliberate: the two
honest alternatives are to fail a job whose customer may hold a good video, or to
charge for a video nobody can watch, and neither is a decision this phase has the
authority to make.

**Accepted cost.** A `VALID` verdict whose publication is outstanding is
rediscovered by a later sweep rather than retried in place, so publication can be
delayed by one sweep interval after a crash. The alternative — one commit for both
— removes the recoverable state entirely.

**Accepted cost.** Every lifecycle transaction now issues one extra statement: the
lock, then the read. It is a second round trip against rows already in cache, in
exchange for the loser of a creation race learning its outcome rather than a
uniqueness error nobody handles.

**Accepted cost.** A reservation that reached `RELEASED` behind a validated
deliverable raises a defect on every sweep rather than resolving itself. It is a
state the application believes it cannot produce, and the loud repetition is the
point — the quiet alternative is publishing a video nobody is paying for.

**Still dormant.** Nothing constructs the repository or the runner, nothing
schedules a sweep, and no timer, cron or scheduler exists. No paid provider is
activated, no credential is introduced, and no payment integration is touched.
