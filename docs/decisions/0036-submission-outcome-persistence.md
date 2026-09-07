# ADR-0036: A submission outcome is identified by provider reality, not by where the attempt landed

- Status: Accepted
- Date: 2026-09-07
- Phase: 4C-3B-2G-1
- Extends: ADR-0035, which decided that submission *returns* a three-armed
  outcome; this ADR decides how that outcome is **persisted**, and what happens
  when the same outcome arrives twice
- Relates to: ADR-0024 (the row is the queue), and the Phase 4C-3B-2F-1 lock
  order that this persistence joins rather than replaces

## Context

Phase 4C-3B-2F-1 moved an authorized attempt `QUEUED → SUBMITTING` and stopped.
Nothing knew how to write down what happened after that, and the naive answer —
"update the row with whatever the caller reports" — is wrong in three separate
ways, each of which costs money rather than merely being untidy.

**The same news arrives more than once.** A worker retries after a network blip.
A delivery happens twice. A sweeper looking for abandoned attempts finds one that
a worker is finishing at that moment. Every one of them presents an observation
about an attempt that may already have an outcome.

**Two callers can report different news.** Two acceptances naming different
prediction ids means one of them names work nobody ordered. An acceptance racing
a presumption of loss means one of them is about to be overwritten.

**A deadline derived from "now" is a deadline a retry can extend.** An attempt in
`RECONCILIATION_PENDING` holds uncertain provider cost against its organization's
Safety Guard until its deadline. If that deadline is computed from whenever
someone happens to look, then looking again moves it, two entry routes disagree
about it, and the bound on how long the platform carries an unresolved charge
stops being a bound.

## Decision

### 1. Three answers on arrival, never two

```text
the record already says exactly this   → REPLAY    write nothing, return success
the record says something else         → CONFLICT  write nothing, refuse
the record has no outcome yet          → APPLY
```

`REPLAYED` is a success. A caller that treated it as failure and retried would
loop forever on its own earlier success.

`CONFLICTING_OBSERVATION` writes nothing and keeps the outcome already on file. A
second provider reference never overwrites the first: the discarded one may still
name work the platform owes money for, and overwriting it destroys the ability to
ever ask the provider about it.

### 2. Identity is provider reality, not the landing state

Two observations record the same thing when they agree on the **submission
certainty** and the **provider reference**, and the attempt is in a state that
certainty can explain.

It is emphatically *not* required to still be in the state the first application
wrote. Those are different facts, and conflating them produced a false conflict
on an entirely ordinary sequence:

```text
ACCEPTED lands            → PROCESSING
execution proceeds        → PROVIDER_SUCCEEDED → OUTPUT_INGESTING → OUTPUT_VERIFIED
the same ACCEPTED arrives → refused as a "state mismatch"
```

Nothing about that second observation disagrees with the record. The provider
accepted the work, named it, and still has; the execution lifecycle simply moved
on afterwards, which is what it is supposed to do. Refusing there demands a human
adjudicate a duplicate delivery of unchanged news.

The compatible states, exhaustively:

| Recorded certainty | States a replay may find it in |
| --- | --- |
| `ACCEPTED` | `PROCESSING`, `PROVIDER_SUCCEEDED`, `OUTPUT_INGESTING`, `OUTPUT_VERIFIED`, `FAILED_RETRYABLE`, `FAILED_TERMINAL` |
| `SUBMISSION_UNKNOWN` | `RECONCILIATION_PENDING`, `RECONCILIATION_EXHAUSTED` |
| `DEFINITIVELY_REJECTED` | `FAILED_RETRYABLE`, `FAILED_TERMINAL` |

An accepted attempt that later failed *while running* has not been un-accepted,
which is why both failure states appear under `ACCEPTED`.
`RECONCILIATION_EXHAUSTED` means the window closed while provider reality was
still unknown — a later fact about how long nobody found out, not a
contradiction of the original observation — so a replay lands there and must
never drag the row back to `RECONCILIATION_PENDING`.

Three things are **excluded** from identity:

- **the landing state**, per the table above;
- **`normalizedErrorCode`** — the platform's own classification of a failure, and
  two workers describing one rejection slightly differently have not disagreed
  about what the provider did;
- **the reconciliation timestamps** — bookkeeping about when *this process*
  learned something, not provider reality. Requiring a replaying worker's freshly
  computed `reconciliationStartedAt` to equal the stored one would make every
  replay after the first millisecond a conflict.

One exception, where the state *is* provider reality: for
`DEFINITIVELY_REJECTED`, a retryable-versus-terminal disagreement remains a
conflict, because the observation's own `retryable` flag decides which landing
state is correct and two observers disagreeing about whether the same request may
be re-admitted have genuinely disagreed.

### 3. The deadline is boundary-derived; the start is not

Two different facts, and only one of them comes from the boundary:

```text
submissionBoundaryEnteredAt  when the paid provider boundary was crossed
reconciliationStartedAt      when the system first durably concluded it did not know
reconciliationDeadlineAt     submissionBoundaryEnteredAt + reconciliationWindowMs
```

For a stale `SUBMITTING` attempt those first two may be hours apart. Deriving the
*start* from the boundary backdated operational history — it claimed the system
knew it was uncertain at a moment when nobody had looked yet. So on first
application of `SUBMISSION_UNKNOWN`, `reconciliationStartedAt` is the single
post-lock clock instant the decision already reads. A caller cannot supply it.

The *deadline* stays boundary-derived, and that is what carries the properties
worth having:

1. A replay cannot extend a deadline — it computes the same value.
2. A delayed stale worker receives *less* remaining reconciliation time rather
   than granting itself more, so a retry cannot buy time against the bound on an
   unresolved charge.
3. The two entry routes agree on the deadline whichever wins their race, even
   though their clocks differ.

If the derived deadline is already in the past, it is persisted as-is. Whether
that uncertainty is exhausted is Phase 4C-3B-2G-2's decision; extending the
deadline to make it look live would take that decision here, and take it wrongly.

A replay never changes either persisted timestamp.

The window is configurable and capped at **24 hours** — the ceiling being the
Phase 4C-3B-2E default constant itself rather than a second constant that could
drift from it. There is deliberately **no shipped stale-`SUBMITTING` default**:
how long an attempt may sit at the boundary before it is presumed lost depends on
provider latency distributions nobody has measured, and a plausible-looking
constant is how a guess becomes policy. A production caller supplies a validated
policy. Valid means:

```text
0 < reconciliationWindowMs <= 24 hours
0 < staleSubmittingAfterMs < reconciliationWindowMs      (strictly)
```

Strictly, because at equality the attempt becomes stale exactly when its
reconciliation deadline arrives — uncertainty that is already expired the moment
it begins.

### 3b. The acceptance instant is the platform's, not the caller's

`providerAcceptedAt` is stamped from the same post-lock clock instant, and the
normalized `ACCEPTED` observation has no field for it. No currently frozen
provider submission contract establishes an authoritative provider-side
acceptance timestamp, so a caller-supplied one would be an unverified claim about
when money started being spent — backdatable and future-datable at will. A replay
never re-stamps it. A future provider contract exposing a separately verified
provider timestamp is a different decision.

### 3c. A validator is not a boundary — only the validated type may be consumed

Bounds that are checked by a function nobody is forced to call are documentation,
not enforcement. While the consumed policy type was structural, this compiled and
ran:

```ts
{ reconciliationWindowMs: 86_400_001, staleSubmittingAfterMs: 1_000 }
```

A window past the 24-hour ceiling, reaching the service without ever meeting the
validator, because it happened to have the right two fields.

So the raw and the checked shapes are now different types:

```ts
interface ReconciliationPolicyConfig { … }              // what an operator writes
type ReconciliationPolicy = Readonly<{ … }> & ValidatedReconciliationPolicyBrand;
```

The brand is a `unique symbol` property no object literal can produce, so
`validateReconciliationPolicy` is the only construction site. Every consumer in
this phase — `SubmissionOutcomeDeps.policy`, `decideSubmissionOutcome`,
`reconciliationDeadlineFor`, `staleSubmittingBoundary`, `isStaleSubmitting` —
takes the validated type, so a raw object is a compile error at the call site
rather than an out-of-range deadline discovered in production. Tests obtain
policies only through the validator, so no test can exercise the phase against a
policy production would refuse.

Values pass through unchanged. Nothing is clamped and nothing is defaulted:
silently repairing an operator's number would hide the mistake rather than report
it, and would make the persisted deadline disagree with the configuration
somebody believes is in force.

### 3d. Diagnostics are a closed application-owned vocabulary, never text

`normalizedErrorCode` has now failed two boundaries, and the second failure is
the instructive one.

The first accepted a bare `string`, which was plainly a raw-text channel.

The second narrowed the *syntax* — SCREAMING_SNAKE, bounded length — and looked
like a boundary while admitting every one of these unchanged:

```text
SECRET_TOKEN_ABC123
APIKEY1234567890
ACCESS_KEY_123456789
CUSTOMER_PRIVATE_ID_98765
```

**Safe syntax is not trusted provenance.** A shape predicate proves how a value is
spelled and says nothing about where it came from; a secret that happens to be
spelled in capitals is still a secret. This is ADR-0031 §4 again — structural
validation proves a shape and can never prove provenance.

The value is therefore a closed catalog the application owns:

```ts
const SUBMISSION_DIAGNOSTIC_CODES = ["TIMEOUT", "CONNECTION_RESET", "LOCAL_CONFIGURATION"] as const;
```

External input may influence **which** member is chosen; it may never supply the
value. The runtime guard checks *membership*, not shape, so
`UNKNOWN_CODE_NOT_IN_CATALOG` is refused despite being well-formed by every
syntactic measure. No HTTP status and no vendor string is a member: a status is
external data about one exchange rather than an application classification, and
copying `429` in would smuggle the provider's vocabulary through the boundary
that exists to keep it out.

The set is small on purpose, and each member earns its place from this phase's
own semantics: `TIMEOUT` (in flight, no answer — the canonical route into
`SUBMISSION_UNKNOWN`), `CONNECTION_RESET` (the transport died mid-exchange, which
an operator triaging a spike wants distinguished from silence), and
`LOCAL_CONFIGURATION` (the platform could not attempt the call at all — the only
member describing this system rather than the exchange, and the only one
actionable without asking the provider anything). An adapter that cannot honestly
place a failure passes `null`, which is always allowed and always truthful.

An unrecognized code is a closed refusal (`OBSERVATION_MALFORMED`) with no
attempt write, no reservation write and no event, and is deliberately
distinguished from "no diagnosis offered": silently dropping it would persist the
outcome while discarding the evidence that a caller tried to write something of
its own choosing into the audit trail.

### 4. Uncertainty is never resolved by returning to `QUEUED`

A stale `SUBMITTING` attempt becomes `RECONCILIATION_PENDING +
SUBMISSION_UNKNOWN`. It is never re-POSTed and never re-armed, at any threshold,
by any route. The provider may already hold and bill for the request; re-arming
would buy the same work twice, which is precisely the failure ADR-0035 exists to
prevent.

Staleness is judged **at or after** the threshold — the threshold is the first
instant at which an attempt counts as lost — against an **injected clock read
inside the lock**. A judgement made before waiting for the lock could declare an
attempt lost that a worker finished while the transaction queued.

### 5. Provider reality outranks entitlement bookkeeping

Uncertainty moves `RESERVED → RECONCILIATION_HOLD` in the same commit. Nothing
else moves: `CONSUMED` stays consumed, because a post-delivery
`USER_REGENERATION` runs against a consumed reservation by contract and
suspending it would re-open an entitlement the customer already used.

An **absent** reservation does not block the write. It is an anomaly, but losing
the fact that a provider took work — because a bookkeeping row is missing — is
the more expensive mistake by far.

### 5b. An anomaly that blocks nothing must still be said out loud

"Must not block" was being implemented as "must not mention": a missing or
released reservation produced an ordinary `APPLIED` and vanished, so nobody found
out that money had been spent against bookkeeping that did not add up.

Both halves are required. The write proceeds, **and** a closed classification is
recorded:

```text
NONE
RESERVATION_MISSING
RESERVATION_RELEASED
RESERVATION_RESERVING
INITIAL_RESERVATION_ALREADY_CONSUMED
RESERVATION_STATE_INCONSISTENT
```

Distinguishing the valid `CONSUMED` from the anomalous one needs the parent
request's kind, which is loaded through the persisted chain and never supplied by
the caller — a caller able to assert it could relabel an entitlement anomaly as
routine by claiming a regeneration that never happened.

The classification is written into the attempt's transition-event metadata in the
same transaction, not merely returned: a crash between commit and the caller
reading the return value must not erase the only record that an anomaly existed.

### 5c. The reservation's event has its own type

`RESERVED → RECONCILIATION_HOLD` writes `SUBMISSION_UNCERTAINTY_HOLD`, not either
attempt-side label. The two events describe different facts — one says what a
provider did, the other says a customer's entitlement was suspended because
nobody could say what the provider did — and an operator querying for entitlement
suspensions should not have to know which attempt-side route caused each one.
Neither label is caller-selectable. When no reservation transition occurs, no
reservation event is written.

### 6. The Phase 2F-1 lock order is joined, not replaced

```text
pg_advisory_xact_lock(organization, billing cycle)   ← the same key 2F-1 uses
GenerationReservation row lock
Attempt compare-and-set
```

Same three, same order, differing only in taking the reservation `FOR UPDATE`
rather than `FOR SHARE`, because this may suspend the entitlement the gate merely
reads. Same order plus a stronger mode means no deadlock cycle. No process-local
mutex is introduced, and no second lock namespace.

## Consequences

- Recording an outcome is idempotent by construction rather than by a dedupe
  table, and needs no idempotency key from the caller.
- Two workers may safely observe the same submission; neither needs to know the
  other exists.
- A conflicting pair of observations stops and requires a human. That is
  deliberate: the alternative is silently choosing which of two claims about a
  paid provider call to believe.
- Deadlines are reconstructable from the attempt row alone. `RECONCILIATION_HOLD`
  suspends an entitlement; it does not settle one. Settlement and deadline expiry
  belong to Phase 4C-3B-2G-2 and are not decided here.
- Nothing in this ADR authorizes a provider call. Recording an outcome is
  strictly downstream of one that already happened.
