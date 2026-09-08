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

### 4. Replay is settled before the deadline is consulted

A record of a resolution is a true statement about the past and stays true
forever. Answering `DEADLINE_EXPIRED` to a duplicate delivery a day later would
make a success look like a failure and invite the caller to retry something
already done. So the check order is:

```text
malformed observation → refuse, before the row is even inspected
already exhausted     → RECONCILIATION_CLOSED
already resolved      → REPLAY or CONFLICT
not reconciling       → NOT_RECONCILING
deadline reached      → DEADLINE_EXPIRED
otherwise             → APPLY
```

Identity is provider reality — the certainty, the provider reference, and for a
rejection the terminal state its `retryable` flag chose — not where the attempt
has since travelled. An accepted attempt that has reached `OUTPUT_VERIFIED` has
not contradicted its own acceptance. The compatibility table is Phase 2G-1's,
imported rather than copied: two copies would drift and manufacture false
conflicts.

Disagreement about `retryable` is a **conflict**, not a detail. It decides
whether another attempt may be admitted and whether the customer's unit was
restored or released; two observers who disagree about it have disagreed about
the customer's remaining entitlement.

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

### 6. Only a suspended hold moves

The reservation action is keyed on the reservation's own **state**, not on the
request kind:

```text
accepted            → RECONCILIATION_HOLD → RESERVED   the work is running
retryable rejection → RECONCILIATION_HOLD → RESERVED   a recovery attempt may use it
terminal rejection  → RECONCILIATION_HOLD → RELEASED   this path cannot continue
exhaustion          → RECONCILIATION_HOLD → RELEASED   the customer is made whole
anything else       → untouched
```

One rule, rather than a matrix of request kinds to get wrong. A post-delivery
`USER_REGENERATION` reaches none of the moves because its reservation is
`CONSUMED`: the regeneration right is sold with the original video and exercised
after the unit is spent, so restoring it would hand back a unit already used.

Restoring on a *retryable* rejection rather than releasing is what keeps such a
rejection actually retryable. Releasing would hand the unit back and leave a
future recovery attempt with nothing to stand on — the customer's request would
become quietly unfinishable while looking healthy.

**Nothing in this phase consumes a unit.** Charging happens when a video is
delivered, and nothing here delivers one.

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

### 10. Candidate discovery is advisory, and says so by what it returns

`findDueReconciliationCandidates` and `findStaleSubmittingCandidates` return
`{ organizationId, attemptId }` and nothing else, take no locks, hold none, and
are bounded by a caller-supplied limit with a deterministic order
(`reconciliationDeadlineAt ASC, id ASC`) so two workers agree on which rows they
take rather than starving the oldest.

Everything needed to *decide* is deliberately absent, so a caller cannot mistake
the list for authority. Every candidate goes back through the single-attempt
service, which re-reads the row under lock and re-reads its own clock. A
non-mutating answer is a normal outcome and is counted, not treated as an error:
between the query and the act, another worker may legitimately have got there
first.

The batch runner runs **one** pass. It does not loop, sleep, schedule itself, own
a timer, or contact a provider. A daemon is a different thing with different
failure modes, and nothing in this phase is authorized to become one.

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
reservation state: it covers every enumerated case with one rule instead of a
matrix, and it fails safe — an unrecognised state moves nothing rather than
guessing.

**Recompute the deadline from current configuration.** Rejected. It would let a
configuration change retroactively lengthen or shorten the bound on attempts
already in flight, which is a bound nobody agreed to applied to a customer's
money.

**Stamp `reconciliationResolvedAt` on exhaustion for uniformity.** Rejected. A
uniform schema is worth less than an honest one, and the transition event's
timestamp already records when the platform gave up.
