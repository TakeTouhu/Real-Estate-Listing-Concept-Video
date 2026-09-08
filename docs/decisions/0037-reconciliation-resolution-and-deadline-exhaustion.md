# ADR-0037: Uncertainty ends in exactly three ways, and giving up is not a refund

- Status: Accepted
- Date: 2026-09-08
- Phase: 4C-3B-2G-2
- Extends: ADR-0036, which decided how an attempt *enters* durable uncertainty;
  this ADR decides how it leaves
- Relates to: ADR-0035 (the submission-certainty axis), ADR-0024 (the row is the
  queue), and the Phase 4C-3B-2F-1 lock order this phase joins unchanged

## Context

Phase 4C-3B-2G-1 gave the platform a way to say "we do not know whether the
provider took this work." An attempt lands in `RECONCILIATION_PENDING +
SUBMISSION_UNKNOWN`, its customer's reserved unit is suspended in
`RECONCILIATION_HOLD`, a deadline is frozen from the submission boundary, and the
Safety Guard counts the attempt's cost as uncertain against the organization's
cycle.

Nothing knew how that state ended. Left alone it never would: an uncertain
attempt holds a customer's entitlement hostage indefinitely and carries an
unresolvable charge in every exposure calculation forever.

Three things about ending it are easy to get wrong, and each of them costs money
or trust rather than merely being untidy.

**Late news and no news are different facts.** An attempt that turns out to have
been accepted is a different outcome from one nobody could ever decide. Writing
them into the same shape — or stamping the second with the fields of the first —
puts a fabricated conclusion into the record an auditor reads.

**A deadline judged before waiting is not a deadline.** A resolver that reads the
clock, then queues behind a lock, then applies, is judging a window that may have
closed while it waited. The exhauster that legitimately owns the row from that
instant is now racing a writer that believes it is still in time.

**Releasing a customer's unit is not the same as forgiving a provider's bill.**
When the platform gives up, the customer must be made whole — they should not pay
for a question nobody answered. What the provider charged is still unknown, and
dropping it to zero would make every incident look like a refund and understate
exactly the cycles that matter most.

## Decision

### 1. Exactly three durable conclusions

```text
proven accepted     → PROCESSING              + ACCEPTED
proven rejected     → FAILED_RETRYABLE        + DEFINITIVELY_REJECTED
                    | FAILED_TERMINAL         + DEFINITIVELY_REJECTED
window ran out      → RECONCILIATION_EXHAUSTED + SUBMISSION_UNKNOWN
```

There is no fourth. In particular there is no "still unknown" write: the row
already says that, with a deadline, and re-recording it would be a mutation that
changes nothing while claiming progress was made. A reconciliation lookup that
still cannot decide simply does not call the service.

**Nothing re-POSTs the attempt.** A conclusion is a record, not a trigger. No
conclusion admits a replacement attempt, either — spending a second unit of
provider capacity is a decision for the recovery path, made deliberately,
not a side effect of writing down what happened to the first.

### 2. The evidence contract is provider-neutral and closed

```ts
type ReconciliationResolutionObservation =
  | { kind: "ACCEPTED"; providerPredictionId: string }
  | { kind: "DEFINITIVELY_REJECTED"; retryable: boolean;
      diagnosticCode: SubmissionDiagnosticCode | null };
```

No HTTP status, no provider body, no vendor enum, no URL, no credential, no
prompt, no free text. The `diagnosticCode` reuses Phase 2G-1's closed catalog
unchanged and unexpanded — a second vocabulary for one concept would force an
operator querying diagnostics to know which phase wrote each row, and expanding a
closed vocabulary without a concrete requirement is how it becomes free text a
byte at a time.

**This phase contains no way to obtain one of these.** The evidence arrives as an
argument. There is no HTTP client in the dependency graph, no polling loop, and
no transport that can be added without editing the port module. Whatever future
layer polls a provider, receives a webhook, or takes an operator's manual
determination normalizes its findings into one of these two shapes first, and
this layer never learns which provider — or which mechanism — produced them.

### 3. Time authority is post-lock, always

The clock is read once, after the locks are held and the authoritative facts are
loaded. A resolver that judged the deadline on a timestamp taken before it queued
could authorize a resolution for a window that closed while it waited.

The deadline itself is **read from the row, never recomputed**. Phase 2G-1 froze
it from the submission boundary; re-deriving it from current configuration would
let an operator lengthen or shorten, retroactively, a bound that attempts already
in flight were admitted under.

Equality belongs to exhaustion:

```text
now <  deadline  → a resolution may still apply; exhaustion is NOT_DUE
now >= deadline  → resolution is DEADLINE_EXPIRED; exhaustion applies
```

The opposite reading would leave exactly one instant in which both paths believed
they owned the row.

### 4. A replay must first prove a reconciliation actually happened

Phase 2G-1 can land an attempt on `PROCESSING + ACCEPTED` directly, from a
provider response observed at the submission boundary — the same certainty, the
same provider reference, and all three reconciliation timestamps null. Comparing
provider reality alone would call that a replay of a reconciliation that never
occurred: reporting success for an operation never performed, and hiding a caller
routing attempts to the wrong service.

So an already-resolved attempt is classified by its reconciliation history first:

```text
started, deadline and resolved all set  → a real reconciliation; replay rules apply
all three null                          → NOT_RECONCILING / ATTEMPT_NEVER_BECAME_UNCERTAIN
anything in between                     → NOT_RECONCILING / RECONCILIATION_HISTORY_INCOHERENT
```

The partial case is neither. Something *did* start a reconciliation and the record
cannot say what became of it, so it fails closed with a distinct reason and the
missing timestamps are **not silently repaired** — a fabricated start or
resolution instant is exactly the invention this phase refuses everywhere else.

### 4a. Replay is settled before the deadline is consulted

Once the history is proven, a record of a resolution is a true statement about the
past and stays true forever. Answering `DEADLINE_EXPIRED` to a duplicate delivery
a day later would make a success look like a failure and invite the caller to
retry something already done. So the check order is:

```text
malformed observation → refuse, before the row is even inspected
already exhausted     → RECONCILIATION_CLOSED
already resolved      → prove history, then REPLAY or CONFLICT
not reconciling       → NOT_RECONCILING
deadline reached      → DEADLINE_EXPIRED
otherwise             → APPLY
```

Identity is provider reality — the certainty, the provider reference, and for a
rejection the terminal state its `retryable` flag chose — not where the attempt
has since travelled. A truly reconciled acceptance that has reached
`OUTPUT_VERIFIED` still replays. The compatibility table is Phase 2G-1's, imported
rather than copied: two copies would drift and manufacture false conflicts.

Disagreement about `retryable` is a **conflict**, not a detail. It decides whether
another attempt may be admitted and whether the customer's unit was restored or
released; two observers who disagree about it have disagreed about the customer's
remaining entitlement.

### 5. Exhaustion is terminal, and stamps nothing

`RECONCILIATION_EXHAUSTED` has no outgoing transition. Late evidence returns
`RECONCILIATION_CLOSED` and writes nothing — the platform already told the
customer it had stopped waiting, and what late evidence establishes about
internal provider cost belongs to accounting rather than to resurrecting an
attempt.

`reconciliationResolvedAt` **stays null**. That field is what an auditor reads to
find out when certainty was regained; it never was. When the platform gave up is
recorded by the transition event's own timestamp, which is the honest place for
it.

### 6. Only a suspended hold moves — and only when its Job is done being unknown

`GenerationReservation` is **Job-scoped**; an attempt is scene-scoped. One Job has
many scenes, each of which can have its own attempt at the provider boundary, so
several attempts can be durably unknown behind a *single* suspended hold.

The action therefore depends on two persisted facts, not one: the reservation's
own state, and how many *other* attempts in the same Job are still
`RECONCILIATION_PENDING + SUBMISSION_UNKNOWN`.

```text
accepted            + no unknown siblings → RECONCILIATION_HOLD → RESERVED
accepted            + unknown siblings    → KEEP_HOLD
retryable rejection + no unknown siblings → RECONCILIATION_HOLD → RESERVED
retryable rejection + unknown siblings    → KEEP_HOLD
terminal rejection                        → RECONCILIATION_HOLD → RELEASED
exhaustion                                → RECONCILIATION_HOLD → RELEASED
anything not a suspended hold             → NONE
```

An earlier revision keyed this on the reservation's state alone, and restored the
hold the moment the *first* attempt in a Job resolved. That lifts a Job-level
suspension while the Job is still uncertain: the customer's unit reads as usable
while money may still be being spent on a sibling nobody can account for.

**`KEEP_HOLD` is a decision, not the absence of one.** `NONE` means there was
nothing to move — a correct post-delivery `CONSUMED` unit, a missing reservation,
an already `RELEASED` one, or a state this phase did not put there. `KEEP_HOLD`
means the hold is exactly where it belongs and this conclusion, which would
otherwise have restored it, deliberately left it suspended.

Nothing is written for `KEEP_HOLD`: no state change, no version bump, and **no
reservation transition event**, because no transition occurred. Appending one
would put a transition in the log that never happened, and an operator counting
entitlement suspensions would over-count every multi-scene Job. The reason lives
on the *attempt's* event instead, as `remainingPendingUnknownAttempts` — a plain
count, never sibling identifiers, which would drag unrelated rows into an audit
record.

The two releasing conclusions ignore siblings deliberately. Releasing is how the
customer stops being charged for a question nobody could answer, and making that
wait on an unrelated sibling would hold their money hostage to it. The asymmetry
is safe precisely because it is one-way: `RELEASED` is terminal, so a sibling's
later conclusion can never resurrect it.

The count is derived through the persisted `Attempt → Request → Scene → Job`
chain and read **inside the transaction, after the organization+cycle advisory
lock**. That is what makes it authoritative rather than advisory: two sibling
conclusions contend on the same lock, so whichever commits first is either
already visible to the other or still waiting and therefore still counted. No
second lock namespace is introduced for it.

A post-delivery `USER_REGENERATION` reaches none of the moves whatever the
sibling count: its reservation is `CONSUMED`, so the action is `NONE` and the
unit is never restored, released or spent again. **Nothing in this phase consumes
a unit.**

### 7. Entitlement anomalies are recorded, never a refusal

Past the provider boundary, provider reality is persisted whether or not the
bookkeeping adds up. A missing reservation, a released one, a spent `INITIAL`
one, or one somebody restored out of band does not block the conclusion: the
anomaly is classified into Phase 2G-1's `EntitlementAnomaly` vocabulary and
written into the attempt's transition event, so a crash between commit and the
caller reading the return value cannot erase the only record that it existed.

A terminal reservation is never resurrected, and no destructive transition is
guessed at — turning one inconsistency into two is not a repair.

Note that the *expectation* differs from the submission boundary even though the
vocabulary does not: there a healthy reservation is `RESERVED`, while an attempt
in reconciliation has already had its hold suspended, so `RECONCILIATION_HOLD` is
healthy here and `RESERVED` is the surprise.

### 8. Five event types, across two aggregates

```text
ATTEMPT      RECONCILIATION_RESOLVED_ACCEPTED
             RECONCILIATION_RESOLVED_REJECTED
             RECONCILIATION_EXHAUSTED
RESERVATION  RECONCILIATION_HOLD_RESTORED
             RECONCILIATION_HOLD_RELEASED
```

Service-owned, never caller-chosen. The attempt events say what a provider did;
the reservation events say what happened to a customer's entitlement as a result.
An operator asking "which units were handed back, and which were freed because we
gave up?" should not have to know which attempt-side route caused each one.

Attempt metadata carries enough to reconstruct the decision from the database
alone — resolution kind, retryability where relevant, the deadline it was judged
against, the resolution instant when there is one, the entitlement anomaly, the
request kind, and the safe diagnostic — every value a closed-vocabulary member,
an identifier or a number, with the existing allowlist refusing anything else.

The reconciliation diagnostic lives **only** in that metadata. The attempt's own
`normalizedErrorCode` belongs to the original submission observation, and
overwriting it with a later finding would erase why the attempt became uncertain
in the first place.

### 9. One serialization discipline, and it is the database's

The lock order is Phase 2F-1's, unchanged and unextended:

```text
organization + billing-cycle advisory lock
  → the exact GenerationReservation row, FOR UPDATE, when one exists
  → authoritative attempt read
  → post-lock clock
  → pure decision
  → attempt compare-and-set
  → reservation mutation
  → append-only events
  → COMMIT
```

No process-local mutex anywhere. A second in-memory discipline would be correct
on one replica and useless across two, which is the shape of failure that
survives every local test and appears the first time the service is scaled.

Sharing the advisory key with paid authorization is deliberate: a conclusion
moves an organization's cycle exposure in both directions, so an authorization
reading exposure while one lands would decide on a total that is mid-flight.

### 9a. Tenancy is proved at the mutation, not before it

The compare-and-set carries the organization predicate itself. A tenant-scoped
*read* is not a boundary when the write is reachable without it — and
`ReconciliationSession.apply` is: a caller can hold a session and never call
`loadFacts`. Proving tenancy in the same statement as the CAS also closes the
check-then-act window in which a row could change hands between the two.

Two clauses must both hold: the denormalized `videoProjectId` that the standard
orchestration attempt repository scopes on, and the ownership chain
`Attempt → Request → Scene → Job → VideoProject` that every read in this phase
traverses. Requiring both means a row whose column and chain disagree — a bad
backfill, a partial restore, a manual edit — is frozen rather than writable by
whichever tenant the corruption happens to favour. Requiring the chain also
excludes an attempt with no parent request: a legacy row predating the
orchestration chain is not reconcilable, and treating it as anyone's tenant would
be a guess.

The same rule was applied retroactively to Phase 2G-1's outcome persistence,
which had the identical shape.

### 9b. Evidence is validated as unknown data

The observation types are compile-time promises about values this layer does not
construct. What will actually arrive is decoded JSON, a queue payload, an
operator's determination, or a value someone cast on the way in. So both
validators take `unknown` and prove the shape:

- a non-null, non-array object;
- a discriminant matched exhaustively **by name** — an unrecognised `kind` is
  refused, never swept into an arm, because treating "something I do not
  recognise" as "the provider refused it" would resolve a paid attempt and move a
  customer's entitlement on a value nobody wrote a meaning for;
- every required field checked by type. `retryable` is checked with
  `typeof === "boolean"`, not for truthiness: `"false"` is truthy, and the
  difference between believing it and proving it is whether a customer's unit is
  restored or released. Diagnostics are checked for catalog membership, not
  shape. `undefined` is not `null`, because a field a sender omitted has not been
  stated to be absent.

Nothing throws. Malformed evidence is an answer — `OBSERVATION_MALFORMED`, with
the attempt, the reservation and the event log all untouched — not an exception
for every caller to wrap.

### 9c. One decision instant drives every timestamp it produces

The clock is read once, after the locks. Every timestamp that decision writes
comes from that single instant, carried through the write as `decisionAt`:

```text
conclusive resolution → reconciliationResolvedAt = decisionAt
accepted resolution   → providerAcceptedAt      = decisionAt
reservation release   → releasedAt              = decisionAt
exhaustion            → reconciliationResolvedAt stays null, decisionAt still exists
```

Exhaustion carries it precisely because it resolves nothing: the release still
needs a time, and an earlier revision reached for `new Date()` in the persistence
layer to get one. That stamps a customer's release with an instant no lock was
held for, and lets it drift from the resolution the same decision wrote. The
repository now contains no unparameterized wall-clock read at all; converting an
explicit validated instant — `new Date(write.decisionAt)` — is the only permitted
form, and a static guard enforces it.

Note what this does *not* change: `reconciliationResolvedAt` still stays null on
exhaustion. Obtaining a release time is not a reason to claim a certainty that was
never regained.

### 10. Candidate discovery is advisory, bounded, and owns its own clock

`findDueReconciliationCandidates` and `findStaleSubmittingCandidates` return
`{ organizationId, attemptId }` and nothing else, take no locks, hold none, and
are bounded, with a deterministic order (`reconciliationDeadlineAt ASC, id ASC`)
so two workers agree on which rows they take rather than starving the oldest.

Everything needed to *decide* is deliberately absent, so a caller cannot mistake
the list for authority. Every candidate goes back through the single-attempt
service, which re-reads the row under lock and re-reads its own clock. A
non-mutating answer is a normal outcome and is counted, not treated as an error.

**The runner owns discovery time.** An earlier revision took one `cutoff` from the
caller and passed it to both queries, which ask different questions of different
columns — quietly requiring every caller to encode two meanings in one timestamp.
The runner now reads its clock exactly once per pass and derives both:

```text
discoveryNow = clock.now()                                   one read, per pass
dueCutoff    = discoveryNow                                  reconciliationDeadlineAt <= dueCutoff
staleCutoff  = discoveryNow - policy.staleSubmittingAfterMs  submissionBoundaryEnteredAt <= staleCutoff
```

The threshold comes from an opaque, validated `ReconciliationPolicy` — the same
provenance check Phase 2G-1's service makes — never a raw config, and no
production default is invented. That clock read is advisory: it narrows queries
and decides nothing.

**A limit is validated before any query runs**, by one canonical validator used by
both the runner and the repository, because the repository methods are public and
a direct caller must not be able to put `Infinity`, a fraction or 5000 into a SQL
`LIMIT`. `MAX_RECONCILIATION_MAINTENANCE_BATCH_SIZE` is 100. Invalid values are
**refused, never clamped**: substituting 100 for 5000 would let a caller believe
it swept far more than it did, and substituting 1 for 0 would turn "do nothing"
into "do something".

**An attempt may become unknown and be exhausted in the same batch.** Phase 2G-1
freezes the deadline at `submissionBoundaryEnteredAt + reconciliationWindow`, so
an attempt discovered long after it was abandoned enters `SUBMISSION_UNKNOWN` with
a deadline that has *already* elapsed. The due query in the same pass then finds
it and the exhaustion service closes it. That is correct and is not special-cased
away: the platform's bound on that uncertainty ran out before anyone noticed the
attempt, and deferring it to another batch would extend a window that is over. The
stale-before-due ordering exists so the second pass sees the first pass's work,
not to protect fresh rows from it.

The batch runner runs **one** pass. It does not loop, sleep, schedule itself, own
a timer, or contact a provider.

### 11. Cost exposure after each conclusion

```text
PROCESSING               + ACCEPTED              → IN_FLIGHT
FAILED_*                 + DEFINITIVELY_REJECTED → NONE
RECONCILIATION_EXHAUSTED + SUBMISSION_UNKNOWN    → UNCERTAIN
```

The last row is the one that matters. Exhaustion resolves the *customer's*
entitlement and nothing at all about what the provider charged. Dropping it to
`NONE` would let giving up look like a refund and would understate every cycle in
which an incident happened.

Definitive rejection is the only negative fact in the phase strong enough to
remove exposure: the provider refused the submission, so there is nothing to
bill.

## Consequences

**Uncertainty is now bounded in both directions.** Every uncertain attempt either
learns its answer or is closed at a deadline frozen when it crossed the boundary,
and the customer's unit is freed either way.

**A resolution and an exhaustion can never both land.** They contend on the same
locks and each re-checks under them; whichever commits first, the other sees the
result rather than writing over it. No interleaving leaves a resolved attempt
with a released hold, or an exhausted one with a provider reference.

**Uncertain provider cost never disappears silently.** It converts to in-flight,
to zero, or stays uncertain — and only a provider's own refusal produces the
zero.

**Nothing is charged and nothing is generated.** This phase moves no money and
calls no provider. Paid activation remains blocked.

**What this phase does not do**, and deliberately: it does not poll a provider,
ingest a webhook, ingest output, compose, upscale, or admit a recovery attempt.
Those are later phases with different dependency sets. The evidence this service
consumes has, today, no producer — which is the correct order to build it in,
because the shape of the record is the constraint the producers must satisfy
rather than the other way round.

## Alternatives considered

**Write `SUBMISSION_UNKNOWN` again when a lookup is inconclusive.** Rejected: a
mutation that changes nothing, bumping a version and appending an event to record
that nothing was learned. It also invites a caller to treat "I checked" as
progress against a deadline it cannot move.

**Let late evidence reopen an exhausted attempt.** Rejected. The customer has
already been told the platform stopped waiting and their unit has been returned;
reopening would either re-suspend an entitlement they now hold or leave an
attempt running that nobody is accounted for. The cost question that late
evidence answers is real, and belongs to a cost-accounting pass over the audit
record rather than to the lifecycle.

**Key the reservation move on request kind.** Rejected in favour of keying on
reservation state *and* the Job's remaining unknown attempts. Request kind alone
is a matrix to get wrong; reservation state alone was the first revision's error,
and it restored a Job-scoped hold the moment the first of several uncertain
attempts resolved.

**Make releasing wait for siblings too, for symmetry.** Rejected. Releasing is how
the customer stops being charged for a question nobody could answer; making it
wait on an unrelated sibling holds their money hostage to it. The asymmetry is
safe because `RELEASED` is terminal — a sibling's later conclusion cannot
resurrect it — whereas restoring early is not recoverable in the same way.

**Write a reservation event for `KEEP_HOLD` so the decision is visible.**
Rejected: nothing transitioned, and a transition event for a non-transition
corrupts every audit query that counts entitlement suspensions. The count lives on
the attempt's own event instead.

**Clamp an out-of-range maintenance limit instead of refusing it.** Rejected. A
caller that computed a nonsense bound has a defect, and silently substituting a
valid number lets it believe it swept far more — or far less — than it did.

**Recompute the deadline from current configuration.** Rejected. It would let a
configuration change retroactively lengthen or shorten the bound on attempts
already in flight, which is a bound nobody agreed to applied to a customer's
money.

**Stamp `reconciliationResolvedAt` on exhaustion for uniformity.** Rejected. A
uniform schema is worth less than an honest one, and the transition event's
timestamp already records when the platform gave up.
