# Phase 4C-3B-2G-1 — Completion report

Submission outcome persistence and uncertainty entry. Base:
`ce1fed14c1125bf83d26ab8ec0ef4a5d725f34e7`.

> **Revision 2 — CTO review corrections.** The first submission
> (`7c42115df7a257c7626d2dce1c13df625c0d2d36`) was not approved. Six defects are
> corrected here, and several statements in Revision 1 were wrong:
>
> | Superseded claim | Correction |
> | --- | --- |
> | Replay identity includes the landing state | It is **provider reality only**. An accepted attempt that has since reached `OUTPUT_VERIFIED` replays; it does not conflict |
> | "All reconciliation timestamps are boundary-anchored" | Only the **deadline** is. `reconciliationStartedAt` is when the system first durably concluded it did not know, and comes from the post-lock clock |
> | Fifteen minutes is the stale-`SUBMITTING` threshold | **Nothing is frozen.** The invented default is removed; the threshold is a production-activation decision, tracked in `docs/decisions/TODO.md` |
> | The caller supplies `providerAcceptedAt` | The observation has no such field. The instant comes from the same post-lock clock |
> | `normalizedErrorCode` accepts any string | It is a validated short application code. Arbitrary text is refused, closed, with nothing written |
> | An entitlement anomaly needs only to not block the write | It must also be **said out loud** — classified from the persisted request kind and written durably into the outcome event |
> | A rate limit illustrates `DEFINITIVELY_REJECTED` | It does not. WaveSpeed 429 and a fal status with no provider reference both map to `SUBMISSION_UNKNOWN` today |
>
> Also corrected: the reservation's own transition now writes
> `SUBMISSION_UNCERTAINTY_HOLD` rather than reusing an attempt-side label, and
> the stale threshold must be **strictly** less than the reconciliation window.

> **Revision 3 — final corrections.** Revision 2
> (`c21f10f2cc5d258d6efcbb8fdded6d9823d1bd9c`) was not approved. Two of its
> boundaries were guards in name only:
>
> | Superseded claim | Correction |
> | --- | --- |
> | A validated reconciliation policy is enforced | It was *validatable*, not enforced. `{ reconciliationWindowMs: 86_400_001, staleSubmittingAfterMs: 1_000 }` satisfied the consumed type and reached the service without ever meeting the validator. Raw and validated are now different types, and only the branded one is consumed |
> | `normalizedErrorCode` is safely narrowed | Syntactic narrowing is not a boundary. `SECRET_TOKEN_ABC123`, `APIKEY1234567890` and `ACCESS_KEY_123456789` all satisfied `^[A-Z][A-Z0-9_]*$`. It is now a closed application-owned catalog, checked by membership |
>
> The lesson both share: **a validator existing is not enforcement, and safe
> syntax is not trusted provenance.**

Phase 4C-3B-2F-1 ended at the paid boundary: it decided whether an attempt was
allowed to cross, moved it `QUEUED → SUBMITTING`, and stopped. Nothing then knew
how to write down what happened next. This phase supplies exactly that, and
nothing more.

**No provider is contacted anywhere in this phase.** There is no HTTP client, no
polling, no reconciliation request, no adapter. This phase records reality a
caller has *already observed*; it never goes and asks. That is a later phase with
a different dependency set.

## What crosses the boundary, and what comes back

```text
              Phase 2F-1                     Phase 2G-1
   QUEUED ──────────────────► SUBMITTING ──────────────────► PROCESSING
   PRE_SUBMISSION             PRE_SUBMISSION                 ACCEPTED

                                          ──────────────────► FAILED_RETRYABLE
                                                               DEFINITIVELY_REJECTED
                                          ──────────────────► FAILED_TERMINAL
                                                               DEFINITIVELY_REJECTED
                                          ──────────────────► RECONCILIATION_PENDING
                                                               SUBMISSION_UNKNOWN
```

Three destinations, because the question "what did the provider do with this
submission?" has exactly three honest answers. The third is not a failure mode of
the other two — it is what must be recorded whenever the platform cannot *prove*
which of them happened, and rounding it to either of the others is how a
provider gets paid for work the platform believes it never ordered.

## The observation is provider-neutral by construction

```ts
type ProviderSubmissionObservation =
  | { kind: "ACCEPTED"; providerPredictionId: string }
  | {
      kind: "DEFINITIVELY_REJECTED";
      retryable: boolean;
      normalizedErrorCode: SubmissionDiagnosticCode | null;
    }
  | { kind: "SUBMISSION_UNKNOWN"; normalizedErrorCode: SubmissionDiagnosticCode | null };

// where SubmissionDiagnosticCode is a member of a closed application catalog,
// not a string that merely looks like one.
```

No HTTP status, no provider error body, no vendor enum, no provider name. An
adapter translates its own vocabulary into one of these three shapes and this
layer never learns which provider it was talking to. That is what lets the
persistence rules be written once and exercised in full without a provider
existing.

There is no timestamp, and no field a caller may fill with a value of its own
choosing. A caller able to name the acceptance instant could backdate paid
submission history; a caller able to supply the diagnostic value — even one
shaped like a code — could put a credential or a customer identifier into the
most widely read table in an incident, so it may only *select* from a closed
application-owned vocabulary.

`retryable` says only whether a *new* attempt row may be admitted for the same
request. It never means this row may be re-POSTed. Nothing in this phase ever
re-POSTs anything.

**No current adapter reaches `DEFINITIVELY_REJECTED` for a remote rate limit.**
WaveSpeed maps 429 to `SUBMISSION_UNKNOWN`, and so does a fal HTTP status with no
provider reference, because neither establishes that the provider did not begin
billable work. The arm exists for a future contract that can prove
non-acceptance; it is not a description of what today's adapters do.

An `ACCEPTED` whose `providerPredictionId` is blank is rejected as
`OBSERVATION_MALFORMED` rather than persisted. An acceptance that cannot name
what was accepted has not established acceptance; it is uncertainty, and it
belongs on the third arm.

## Replay identity is provider reality, not the landing state

This is the correction that mattered most. Revision 1 compared the persisted
attempt state against the state the *first* application wrote, which made an
entirely ordinary sequence look like a disagreement:

```text
ACCEPTED lands            → PROCESSING
execution proceeds        → PROVIDER_SUCCEEDED → OUTPUT_INGESTING → OUTPUT_VERIFIED
the same ACCEPTED arrives → refused, "TERMINAL_STATE_MISMATCH"
```

Nothing there contradicts the record. The provider accepted the work, named it,
and still has; the lifecycle simply moved on. Refusing demanded a human
adjudicate a duplicate delivery of unchanged news.

A replay now requires the recorded **certainty** to match, the **provider
reference** to match, and the attempt to be somewhere that certainty can explain:

| Recorded certainty | States a replay may find it in |
| --- | --- |
| `ACCEPTED` | `PROCESSING`, `PROVIDER_SUCCEEDED`, `OUTPUT_INGESTING`, `OUTPUT_VERIFIED`, `FAILED_RETRYABLE`, `FAILED_TERMINAL` |
| `SUBMISSION_UNKNOWN` | `RECONCILIATION_PENDING`, `RECONCILIATION_EXHAUSTED` |
| `DEFINITIVELY_REJECTED` | `FAILED_RETRYABLE`, `FAILED_TERMINAL` |

An accepted attempt that later failed *while running* has not been un-accepted.
`RECONCILIATION_EXHAUSTED` says the window closed while provider reality was
still unknown — a later fact about how long nobody found out, not a
contradiction — so another `SUBMISSION_UNKNOWN` replays there, and the row is
never dragged back to `RECONCILIATION_PENDING`.

A different provider reference remains a conflict at every one of those states.
For `DEFINITIVELY_REJECTED` the landing state *is* provider reality, so a
retryable-versus-terminal disagreement also remains a conflict: the observation's
own `retryable` flag decides which state is correct.

A state that certainty cannot explain — `ACCEPTED` on a row sitting in
`RECONCILIATION_PENDING` — is `RECORDED_STATE_INCOHERENT`: a corrupt record
rather than two disagreeing observers, and not this phase's to repair.

## Three answers on arrival, never two

The hard part of this phase is not writing the row. It is deciding, on the second
and third arrival of the same news, whether to write it again — a worker that
retries after a blip, a delivery that happens twice, a stale sweeper racing a
worker that was never actually stuck.

```text
the record already says exactly this   → REPLAY    write nothing, return success
the record says something else         → CONFLICT  write nothing, refuse
the record has no outcome yet          → APPLY
```

Conflating any two of those loses money or invents history. `REPLAYED` is a
success, not a soft failure: the caller's news is durably recorded, it simply was
already. A caller that retried on any non-`APPLIED` answer would otherwise loop
forever on its own earlier success.

### What "exactly this" compares

Certainty, then the provider reference, then whether the recorded state is one
that certainty can explain — never the state the first application wrote.
`normalizedErrorCode` is deliberately **excluded**: it is diagnostic text about
how the platform classified a failure, and two workers describing the same
rejection slightly differently have not disagreed about what the provider did.

| Recorded vs observed | Answer |
| --- | --- |
| Same certainty, same reference, compatible state | `REPLAYED` |
| Different certainty (`ACCEPTED` vs `SUBMISSION_UNKNOWN`) | `CONFLICTING_OBSERVATION` / `CERTAINTY_MISMATCH` |
| Same certainty, different provider reference | `CONFLICTING_OBSERVATION` / `PROVIDER_REFERENCE_MISMATCH` |
| `DEFINITIVELY_REJECTED`, retryable vs terminal | `CONFLICTING_OBSERVATION` / `TERMINAL_STATE_MISMATCH` |
| Same certainty, a state that certainty cannot explain | `CONFLICTING_OBSERVATION` / `RECORDED_STATE_INCOHERENT` |

A second, different provider reference is refused rather than overwritten.
Overwriting would discard the ability to ask the provider about the reference
that was replaced — a reference the platform may still owe money against.

## Two reconciliation instants, only one from the boundary

Revision 1 derived both from `submissionBoundaryEnteredAt`, which backdated
operational history: it claimed the system knew an attempt was uncertain at a
moment when nobody had looked yet. For a stale attempt swept hours later, those
are different facts by hours.

```text
submissionBoundaryEnteredAt  when the paid provider boundary was crossed
reconciliationStartedAt      when the system first durably concluded it did not know
                             → the post-lock clock instant, never the boundary
reconciliationDeadlineAt     submissionBoundaryEnteredAt + reconciliationWindowMs
                             → unchanged, still boundary-derived
```

Keeping the *deadline* boundary-derived is what carries the properties worth
having:

1. **Replay cannot extend a deadline.** The same observation ten hours later
   computes the same value and writes nothing.
2. **A delayed sweeper gets less time, never more.** It inherits whatever remains
   of the window rather than restarting it.
3. **The two entry routes agree on it** whichever wins their race, even though
   their clocks differ — which is what keeps that race benign.

If the derived deadline is already in the past it is persisted as-is. Whether
that uncertainty is exhausted is Phase 2G-2's decision; extending the deadline to
make it look live would take that decision here, and take it wrongly.

A replay never moves either persisted timestamp, and the evaluator deliberately
does **not** compare a replaying worker's freshly computed
`reconciliationStartedAt` against the stored one — that would make every replay
after the first millisecond a conflict.

## The acceptance instant is the platform's

`providerAcceptedAt` is stamped from the same single post-lock clock instant, and
the normalized `ACCEPTED` observation has no field for it at all:

```ts
{ readonly kind: "ACCEPTED"; readonly providerPredictionId: string }
```

No currently frozen provider submission contract establishes an authoritative
provider-side acceptance timestamp, so a caller-supplied one would be an
unverified claim about when money started being spent — backdatable and
future-datable at will. The clock is read once per decision, not once per field.
A replay never re-stamps it.

## Validation authority must not be copyable

Revision 2 shipped a correct validator that callers could bypass, because the
consumed type was structural. Revision 3 added a phantom `unique symbol` brand,
which fixed the literal and missed the copy:

```ts
const validated = validateReconciliationPolicy({ … });
if (!validated.ok) throw new Error();

const corrupted = { ...validated.policy, reconciliationWindowMs: 86_400_001 };
const accepted: ReconciliationPolicy = corrupted;   // compiled. no cast.
```

A phantom brand is only a type-level property, and TypeScript's spread type
copies it with everything else. So the brand proved that *some* value had once
passed the validator — not that the numbers being consumed were still the
validated ones. **A ceiling a spread can raise is not a ceiling.**

### The representation

```ts
export class ReconciliationPolicy {
  readonly #validated: true;                 // real private state, not a phantom
  readonly #reconciliationWindowMs: number;
  readonly #staleSubmittingAfterMs: number;

  private constructor(…) { … }               // the only construction site is validate()

  get reconciliationWindowMs(): number { return this.#reconciliationWindowMs; }
  get staleSubmittingAfterMs(): number { return this.#staleSubmittingAfterMs; }

  static isPolicy(value: unknown): value is ReconciliationPolicy {
    return typeof value === "object" && value !== null && #validated in value;
  }

  static validate(input: ReconciliationPolicyConfig): ReconciliationPolicyResult { … }
}
```

**Why a spread cannot preserve authority.** `#validated` is a real private field,
not a declared property type. It is not an own enumerable property, so
`{ ...policy }` does not copy it — at runtime the spread copies *nothing at all*,
because the accessors live on the prototype — and TypeScript's spread type omits
private state as well. The reconstructed object is therefore not a
`ReconciliationPolicy`, at compile time or at run time, and no cast was needed to
discover that.

The numbers are getters over private fields, so they are readable, unwritable and
impossible to edit in place. The constructor is `private`, so there is no second
way in; `validateReconciliationPolicy` delegates to `validate` and remains the
one entry point callers use.

### What no longer compiles

Each case in `policy-nominality.test.ts` starts from a *genuinely validated*
policy — not a literal — and is guarded by `@ts-expect-error`, so the suite fails
to compile if any of them ever type-checks again:

| Reconstruction | Result |
| --- | --- |
| `{ ...policy, reconciliationWindowMs: MAX + 1 }` | not assignable |
| `{ ...policy, staleSubmittingAfterMs: policy.reconciliationWindowMs }` | not assignable |
| `{ ...policy, staleSubmittingAfterMs: -1 }` | not assignable |
| `{ ...policy, reconciliationWindowMs: 1.5 }` and `MAX_SAFE_INTEGER + 2` | not assignable |
| `{ ...policy }` — a faithful copy | not assignable |
| `new ReconciliationPolicy(60_000, 10_000)` | constructor is private |
| `policy.reconciliationWindowMs = …` | no setter; throws under ESM strict mode |

Verified discriminating: type-checked against Revision 3's implementation, six of
these `@ts-expect-error` directives report **unused** — meaning those exact lines
compiled there. That is the bug, reproduced.

### The one honest gap, and the runtime defence

`Object.assign` is typed as returning an *intersection* of its sources, so
`Object.assign({}, policy, { … })` keeps the policy type by construction of the
lib signature. No compile-time boundary catches it, and the test says so plainly
rather than claiming otherwise. Spread — what ordinary code actually writes —
does not behave this way.

For that case, and for any explicit `as unknown as ReconciliationPolicy`, the
runtime check refuses the value. `createSubmissionOutcomeService` asks
`isReconciliationPolicy(deps.policy)` once at construction and throws
`INTERNAL_ERROR` otherwise — a forged policy is a programming defect, not a
business outcome.

The check is `#validated in value`, the ergonomic-brand idiom: true only for
objects this class constructed, unfakeable by any structural copy, and — unlike
`instanceof` — not defeated when two realms each load their own copy of the
module. It is **defence in depth, not the validation**: it proves provenance
rather than re-deriving the bounds, because a second copy of the bounds is a
second thing to drift from the first.

## Window policy — and the threshold that is deliberately absent

| Setting | Shipped default | Bound |
| --- | --- | --- |
| `reconciliationWindowMs` | 24 h (the Phase 2E constant) | `> 0`, and **≤ 24 h** |
| `staleSubmittingAfterMs` | **none** | `> 0`, and **strictly** `<` the window |

Revision 1 introduced a fifteen-minute stale-`SUBMITTING` default. It was never
frozen by anyone, and it is removed. How long an attempt may sit at the boundary
before it is presumed lost depends on provider latency distributions nobody has
measured, and a plausible-looking constant is how a guess becomes policy: the
number gets quoted, relied on, and never revisited. Too short and an ordinary
slow response converts a live paid submission into permanent uncertainty; too
long and a crashed submission holds its reservation hostage. **Fifteen minutes is
not the product policy**, and no production value is frozen by this phase — it is
recorded as unresolved in `docs/decisions/TODO.md`. Tests use fixtures.

The inequality is strict: at equality an attempt becomes stale exactly when its
reconciliation deadline arrives, so the uncertainty it enters is already expired.
That is refused as `STALE_THRESHOLD_NOT_BEFORE_RECONCILIATION_DEADLINE`.

The 24-hour ceiling is retained, and *is* the Phase 2E default rather than a
second constant that could drift from it. An attempt in `RECONCILIATION_PENDING`
holds uncertain provider cost against its organization's Safety Guard for the
whole window, so a window measured in days would let one incident suppress a
tenant's throughput long after anyone could still find out what happened.

`validateReconciliationPolicy` returns a result rather than throwing.
Configuration arrives from outside the process and a bad value is an operator
mistake, not a programming defect, so it is answerable and the caller decides
whether to refuse startup or fall back. It never silently falls back to a
hard-coded threshold. Production wiring is out of scope: the phase is dormant and
has no caller.

## Diagnostics are a closed vocabulary, because safe syntax is not provenance

This boundary has now failed twice, and the second failure is the instructive one.

Revision 1 accepted `normalizedErrorCode: string | null` and persisted it
directly — plainly a raw-text channel, and exactly what ADR-0031 closed.

Revision 2 narrowed the *syntax* — SCREAMING_SNAKE ASCII, at most 48 characters —
and that looked like a boundary while admitting every one of these unchanged:

```text
SECRET_TOKEN_ABC123
APIKEY1234567890
ACCESS_KEY_123456789
CUSTOMER_PRIVATE_ID_98765
```

A shape predicate proves how a value is *spelled*. It can say nothing about where
the value came from, and a credential that happens to be spelled in capitals is
still a credential. ADR-0031 §4 recorded this same lesson when structural
validation of `ProviderError` let a hostile object choose both public diagnostic
strings outright: **structural validation proves a shape; it can never prove
provenance.**

The value is now a closed catalog the application owns:

```ts
const SUBMISSION_DIAGNOSTIC_CODES = [
  "TIMEOUT",
  "CONNECTION_RESET",
  "LOCAL_CONFIGURATION",
] as const;
```

External input may influence **which** member is chosen; it may never supply the
value. Each member earns its place from this phase's own semantics, not from any
vendor's error list:

| Code | Why this phase needs it |
| --- | --- |
| `TIMEOUT` | In flight, no answer in time — the canonical route into `SUBMISSION_UNKNOWN`. The provider may hold the request, may be executing it, may already have billed it |
| `CONNECTION_RESET` | The transport died mid-exchange. Distinguished from a timeout because an operator triaging a spike wants to know which, though it establishes just as little |
| `LOCAL_CONFIGURATION` | The platform could not attempt the call at all — a missing credential, an unroutable base URL, a disabled provider. The only member describing *this system*, and the only one actionable without asking the provider anything |

No HTTP status is a member and no vendor string is. A status is external data
about one exchange rather than an application classification, and copying `429`
in would smuggle the provider's vocabulary through the boundary that exists to
keep it out. A test asserts no member contains a digit or a vendor name.

The runtime guard checks **membership, not shape** — the union type stops a bare
string being assigned, and a cast is exactly what a caller in a hurry writes. So
`UNKNOWN_CODE_NOT_IN_CATALOG` is refused despite being well-formed by every
syntactic measure, and so is `SECRET_TOKEN_ABC123`.

An unrecognized code is a closed refusal — `OBSERVATION_MALFORMED`, no attempt
write, no reservation write, no event, `normalizedErrorCode` untouched — and is
deliberately distinguished from "no diagnosis offered". Silently dropping it
would persist the outcome while discarding the evidence that a caller tried to
write something of its own choosing into the audit trail. `null` is always
acceptable and always honest. The same contract applies to the stale-recovery
route.

An adapter that cannot honestly place a failure in this vocabulary passes `null`.
Growing the catalog on contact with providers would stop it being
application-owned, so adding a member is a deliberate act with a reason — which
is the property a closed set has and a regex does not.

## Staleness is at-or-after, on an injected clock

```ts
isStaleSubmitting = now >= submissionBoundaryEnteredAt + staleSubmittingAfterMs
```

At-or-after, not strictly after: the threshold is the first instant at which the
attempt counts as lost, and the opposite reading leaves one instant in which
nothing may act.

The clock is a `SubmissionClock` port, and the service reads it **once, inside
the lock** — that single instant is the staleness judgement, the acceptance
timestamp and the uncertainty-start timestamp. A staleness judgement made before
waiting for the lock could declare an attempt lost that a worker finished while
this transaction queued.

The staleness guard applies only to the sweeper, and only to an attempt that
would otherwise be *applied*. An attempt that already has an outcome is a replay
or a conflict regardless of how long it sat there.

### Stale recovery never returns to `QUEUED`

The provider may already hold — and bill for — this request. The only honest
thing to record is that nobody knows, and the only safe thing to do about it is
wait for reconciliation. Returning the row to `QUEUED` would make it eligible for
a *second* paid submission for work that may already be running.

The two routes are distinguishable in the audit trail without being different
writes:

| Route | Event type |
| --- | --- |
| `recordObservation` | `SUBMISSION_OUTCOME_RECORDED` |
| `enterUncertaintyForStaleSubmitting` | `STALE_SUBMISSION_UNCERTAINTY_ENTERED` |

Both labels are owned by the service. A caller's `eventType` is overwritten: the
label on the record of what a provider did is what an audit query and a future
reconciliation worker select on, and a caller able to write something else could
make a provider outcome indistinguishable from any other transition.

## The reservation, in the same commit

Uncertainty suspends the customer's hold; certainty does not.

| Reservation state on arrival | `SUBMISSION_UNKNOWN` | `ACCEPTED` / `DEFINITIVELY_REJECTED` |
| --- | --- | --- |
| `RESERVED` | → `RECONCILIATION_HOLD`, same transaction, with its own event | unchanged |
| `CONSUMED` | **unchanged** | unchanged |
| `RELEASED` | unchanged | unchanged |
| `RECONCILIATION_HOLD` | unchanged (already there) | unchanged |
| *absent* | unchanged — outcome still recorded | unchanged — outcome still recorded |

### An anomaly that blocks nothing is still said out loud

Revision 1 got the first half right and the second half wrong: a missing or
released reservation produced an ordinary `APPLIED` and vanished, so nobody found
out that money had been spent against bookkeeping that did not add up.

The write still proceeds. It is now also classified, from a closed vocabulary:

```text
NONE
RESERVATION_MISSING
RESERVATION_RELEASED
RESERVATION_RESERVING
INITIAL_RESERVATION_ALREADY_CONSUMED
RESERVATION_STATE_INCONSISTENT
```

Separating the valid `CONSUMED` from the anomalous one needs the parent request's
kind, which is joined through the persisted chain and **never** caller-supplied —
a caller able to assert it could relabel an anomaly as routine by claiming a
regeneration that never happened.

| Request kind | Reservation | Anomaly |
| --- | --- | --- |
| `USER_REGENERATION` | `CONSUMED` | `NONE` — correct by contract |
| `INITIAL` | `CONSUMED` | `INITIAL_RESERVATION_ALREADY_CONSUMED` |
| either | absent | `RESERVATION_MISSING` |
| either | `RELEASED` | `RESERVATION_RELEASED` |
| either | `RESERVING` | `RESERVATION_RESERVING` |
| either | `RESERVED` / `RECONCILIATION_HOLD` | `NONE` |

`RESERVATION_STATE_INCONSISTENT` is currently **unreachable** and kept
deliberately: the classifier switches exhaustively over
`GenerationReservationState`, so a new state fails to compile there rather than
falling through to a label — which is the better failure. The member exists so
whoever adds that state has somewhere honest to put it while they decide.

The classification is written into the attempt's transition-event metadata in the
same transaction, not merely returned on `APPLIED`. A crash between commit and
the caller reading the return value must not erase the only record that an
anomaly existed, and a database test cold-reads it back to prove it.

### The reservation event has its own type

`RESERVED → RECONCILIATION_HOLD` writes `SUBMISSION_UNCERTAINTY_HOLD`, not either
attempt-side label. The two events describe different facts, and an operator
querying for entitlement suspensions should not have to know which attempt-side
route caused each one. Neither label is caller-selectable. When no reservation
transition occurs, no reservation event is written.

`CONSUMED` stays consumed. A post-delivery `USER_REGENERATION` runs against a
`CONSUMED` reservation by contract; suspending it would re-open an entitlement
the customer has already used.

An **absent** reservation is an anomaly, and it is explicitly not a reason to
refuse. Provider reality after the paid boundary must be recorded whether or not
the entitlement bookkeeping is intact — losing the fact that a provider took work
because a reservation row is missing would be the more expensive mistake by far.

No customer quota is consumed on any path. No reservation is minted. No
regeneration right is spent. No `SYSTEM_RECOVERY` attempt is created: recovery
admission is a separate decision, made separately.

## Concurrency and lock order

The lock order fixed by Phase 4C-3B-2F-1 is preserved exactly:

```text
1. pg_advisory_xact_lock(organization, billing cycle)   ← same key as 2F-1
2. GenerationReservation row lock
3. Attempt compare-and-set
```

Same three, same order. The only difference is mode: 2F-1 takes the reservation
`FOR SHARE` because it reads an entitlement; this takes it `FOR UPDATE` because
it may suspend one. Same order, stronger mode, no cycle — and therefore no
deadlock between paid authorization and outcome recording.

There is **no process-local mutex** and no new lock namespace. The advisory key
is the 2F-1 key because the two operations genuinely contend: an attempt entering
`RECONCILIATION_PENDING` starts counting against the Safety Guard, so an
authorization reading exposure while an outcome lands would decide on a total
that is mid-flight.

The billing cycle is read before the lock — it decides only *which* lock to take,
and a reservation's cycle is immutable once written. An attempt with no
reservation locks on `"unreserved"` within its own organization.

The compare-and-set predicate is the whole boundary:

```ts
{ id, orchestrationState: "SUBMITTING", submissionCertainty: "PRE_SUBMISSION", stateVersion }
```

Zero rows updated means another writer resolved this attempt first, and the
caller gets `LOST_CONCURRENCY` — a closed outcome, not a rejected promise.

### Verified races (live PostgreSQL)

| Race | Outcome |
| --- | --- |
| Two identical `ACCEPTED` observations | one `APPLIED`, one `REPLAYED`; exactly one event |
| Two `ACCEPTED` naming different references | one `APPLIED`, one `CONFLICTING_OBSERVATION`; exactly one reference on file |
| `ACCEPTED` versus `SUBMISSION_UNKNOWN` | one `APPLIED`, one `CONFLICTING_OBSERVATION`; the row holds one coherent outcome, never a blend |
| Direct `SUBMISSION_UNKNOWN` versus stale sweep, **on two different clocks** | one `APPLIED`, one `REPLAYED`; the winner's `reconciliationStartedAt` stands whole, and the deadline is identical either way |
| Reservation `RELEASED` versus uncertainty entry | uncertainty entry blocks on the row lock, then records the outcome; the released hold is not revived |
| A Phase 2F-1 cost admission holding the same locks | uncertainty entry blocks until the gate's transaction commits |

The stale race deserves the sharper statement it now gets. Revision 1 tested it
with one clock, so both routes computed byte-identical rows and the loser
replayed trivially. Now that `reconciliationStartedAt` comes from each worker's
own clock the rows are *not* identical — and the loser must still replay, because
replay identity is provider reality and not bookkeeping about when each worker
happened to learn it. The persisted start belongs to whichever route committed
first, whole, never blended and never overwritten by the loser; the deadline is
the same either way because it is boundary-derived.

Provider reality is never lost because a concurrent entitlement transition won
first. In the `RELEASED` race the reservation ends `RELEASED` and the attempt
still ends `RECONCILIATION_PENDING`.

### On the reservation lock mode

`FOR UPDATE` is kept because it takes the mode this transaction will need at the
single ordered point where it takes it. The write would be serialized either way
— the later `UPDATE` acquires an exclusive row lock and waits for any shared
holder — so a `FOR SHARE` acquisition does not lose the reservation transition,
and Revision 1's ledger recorded exactly that as a survivor. What `FOR UPDATE`
avoids is the *upgrade*: acquiring shared and later escalating to exclusive is
the classic shape in which two transactions holding the same shared lock
deadlock. That is a reason from the lock discipline, not a claim the suite
proves, and the code comment says so.

## Critical sequence — recording one outcome

```mermaid
sequenceDiagram
    autonumber
    participant C as Caller (already observed)
    participant S as SubmissionOutcomeService
    participant K as SubmissionClock
    participant R as SubmissionOutcomeRepository
    participant DB as PostgreSQL

    C->>S: recordObservation({org, attemptId, observation, context})
    S->>R: withAttemptOutcome(...)
    R->>DB: BEGIN
    R->>DB: read billingCycleKey (immutable; picks the lock, is not the lock)
    R->>DB: pg_advisory_xact_lock(org, cycle)  %% same key as Phase 2F-1
    R->>DB: SELECT reservation ... FOR UPDATE
    S->>R: loadFacts()
    R-->>S: {attempt, reservation | null}
    S->>K: now()  %% read once, inside the lock
    K-->>S: instant
    S->>S: decideSubmissionOutcome(facts, observation, policy, now)
    alt REPLAY
        S-->>C: REPLAYED (no write, no event, no timestamp moved)
    else CONFLICT / NOT_AT_BOUNDARY / MALFORMED
        S-->>C: closed refusal (nothing written)
    else APPLY
        S->>R: apply({expectedVersion, write, context})
        R->>DB: UPDATE scene_generations WHERE id + SUBMITTING + PRE_SUBMISSION + version
        opt write.holdReservation and reservation is RESERVED
            R->>DB: UPDATE generation_reservations RESERVED → RECONCILIATION_HOLD
            R->>DB: INSERT event (RESERVATION)
        end
        R->>DB: INSERT event (ATTEMPT, SUBMITTING → outcome state)
        R->>DB: COMMIT
        R-->>S: APPLIED | LOST
        S-->>C: APPLIED | LOST_CONCURRENCY
    end
```

Nothing in that diagram is an outbound call. The provider appears only as the
source of a fact the caller already holds.

## Required phase documentation

| Artefact | Status |
| --- | --- |
| Architecture diagram | Not applicable — no new module boundary or process; `docs/architecture.md` is unchanged, and the new module sits inside `packages/domain` alongside `authorization/` |
| Entity-relationship diagram | Not applicable — no schema change; `docs/er-diagram.md` already carries every column this phase writes |
| Critical sequence diagram | Above |
| OpenAPI / API change summary | Not applicable — no HTTP surface. Both entry points are dormant domain services with no route and no caller |
| Change log | `CHANGELOG.md`, this phase's entry |
| Release notes | Not applicable — nothing user-visible ships; the phase is dormant persistence with no caller |
| Database migration notes | No migration. `prisma migrate diff` reports no difference in both directions; `docs/migration-notes.md` is unchanged |
| Phase completion report | This document |
| ADR | `docs/decisions/0036-submission-outcome-persistence.md` — extends ADR-0035 from "submission *returns* a three-armed outcome" to how that outcome is persisted, identified on replay, and timestamped. Revised alongside this document |
| Unresolved decisions | `docs/decisions/TODO.md` — the production stale-`SUBMITTING` threshold |

## Structure

```text
packages/domain/src/submission/
├── diagnostic-code.ts        the closed application-owned diagnostic vocabulary
├── entitlement-anomaly.ts    the closed anomaly vocabulary and its classifier
├── observation.ts            provider-neutral normalized observation
├── reconciliation-window.ts  the validated policy type, its validator, deadline derivation
├── outcome.ts                the pure evaluator (APPLY / REPLAY / CONFLICT / …)
├── ports.ts                  clock, repository, closed result union
└── service.ts                two entry points, one rule set

packages/database/src/
└── submission-outcome-repository.ts   locks, CAS, reservation hold, events
```

The evaluator is pure: no database handle, no clock, no provider. The instant
arrives as a value and every branch is reachable from a plain object, which is
what makes the rules that decide whether a paid submission is remembered testable
without submitting anything.

A static test asserts that no file under `submission/` imports a provider
package or a transport, and that none of them calls `Date.now()` directly.
`policy-nominality.test.ts` adds a compile-time layer to the same idea: it fails
to compile if a raw policy object ever becomes assignable where a validated one
is required.

## Schema

**No migration.** Every column this phase writes already exists from Phase
4C-3B-2E: `orchestrationState`, `submissionCertainty`, `providerPredictionId`,
`providerAcceptedAt`, `reconciliationStartedAt`, `reconciliationDeadlineAt`,
`normalizedErrorCode`, `stateVersion`. `prisma migrate diff` reports no drift.

Two non-schema adjustments were required:

| Change | Why |
| --- | --- |
| `isCoherentAttemptRecord` accepts `DEFINITIVELY_REJECTED + FAILED_RETRYABLE` | Phase 2E's helper allowed only `FAILED_TERMINAL`; both are definitive rejections and the database CHECK never constrained the pairing |
| `submissionCertainty` added to the transition-metadata allowlist | so the outcome event can carry the certainty it recorded |
| `entitlementAnomaly` added to the transition-metadata allowlist | so an anomaly survives the process that noticed it. A closed vocabulary value, never provider or customer text |

`appendEvent` in `orchestration-repositories.ts` was exported as
`appendGenerationEvent` so this phase reuses one event-append implementation
rather than growing a second.

## What this phase does not do

- No provider call, no polling, no reconciliation network request, no webhook.
- No live provider enabled; no fal production activation; no Veo production
  activation.
- No output ingestion, no composition, no upscale.
- No payment integration, no Stripe.
- No `SYSTEM_RECOVERY` attempt created; no regeneration right consumed; no
  customer quota consumed.
- No credit settlement — `RECONCILIATION_HOLD` suspends, it does not settle.
- No API route, no worker loop, no scheduler. Both entry points are dormant
  domain services with no caller.
- No Phase 4C-3B-2G-2 work (reconciliation resolution, deadline expiry, the
  `RECONCILIATION_EXHAUSTED` worker, a global stale scanner). This phase *reads*
  `RECONCILIATION_EXHAUSTED` as a replay-compatible state; it never writes it.
- No Phase 4C-3B-2F-2 paid provider activation.
- No production configuration wiring for `staleSubmittingAfterMs`. The phase is
  dormant and has no caller; a production caller must supply a validated policy,
  and the value itself is unresolved (`docs/decisions/TODO.md`).

## Mutation ledger — 52/52 killed

Every mutation removes exactly one rule this phase is supposed to enforce, from
an artefact that actually executes. A mutation is *killed* when the suites fail,
and each is restored byte-identically before the next runs.

The `C7` series is re-aimed at the opaque class, replacing the phantom-brand
mutations that no longer describe anything the code does. The count fell from 61
to 52 because several Revision 3 mutations targeted validator statements that
moved into the class and are now covered by fewer, sharper anchors — not because
coverage was dropped.

| ID | Mutation | Result | Detected by |
| --- | --- | --- | --- |
| C1a | same ACCEPTED after PROVIDER_SUCCEEDED becomes a conflict | KILLED | 3 failing unit tests |
| C1b | same ACCEPTED after OUTPUT_VERIFIED becomes a conflict | KILLED | 3 failing unit tests |
| C1c | same UNKNOWN after RECONCILIATION_EXHAUSTED becomes a conflict | KILLED | 3 failing unit tests |
| C1d | replay reverts to comparing the landing state | KILLED | 9 failing unit tests |
| C1e | a different provider reference stops being a conflict | KILLED | 11 failing unit tests |
| C1f | retryable-vs-terminal rejection stops being a conflict | KILLED | 3 failing unit tests |
| C1g | a certainty mismatch stops being a conflict | KILLED | 8 failing unit tests |
| C1h | ACCEPTED becomes compatible with RECONCILIATION_PENDING | KILLED | 3 failing unit tests |
| C2a | reconciliationStartedAt is restored to the boundary | KILLED | 5 failing unit tests |
| C2b | the deadline becomes now-based instead of boundary-based | KILLED | 6 failing unit tests |
| C2c | a replay rewrites reconciliationStartedAt | KILLED | 10 failing unit tests |
| C4a | the acceptance instant is taken from the boundary, not the clock | KILLED | 4 failing unit tests |
| C4b | caller-controlled providerAcceptedAt is restored | KILLED | 3 failing unit tests |
| C3a | a fifteen-minute production stale default is reintroduced | KILLED | 6 failing unit tests |
| C3b | a stale threshold equal to the window is accepted | KILLED | 6 failing unit tests |
| C3c | the 24-hour reconciliation ceiling is removed | KILLED | 7 failing unit tests |
| C3d | the ceiling drifts to 48 hours | KILLED | 6 failing unit tests |
| C3e | the stale threshold becomes strictly-after instead of at-or-after | KILLED | 10 failing unit tests |
| C3f | a non-positive reconciliation window is accepted | KILLED | 9 failing unit tests |
| C3g | a non-positive stale threshold is accepted | KILLED | 9 failing unit tests |
| C3h | the deadline is computed from the stale threshold | KILLED | 8 failing unit tests |
| C5a | closed membership is replaced by the old regex shape test | KILLED | 19 failing unit tests |
| C5b | an unknown well-shaped code is admitted to the catalog | KILLED | 7 failing unit tests |
| C5c | a code-shaped secret is admitted to the catalog | KILLED | 8 failing unit tests |
| C5g | the runtime membership check is removed entirely | KILLED | 61 failing unit tests |
| C7a | the private nominal identity is removed | KILLED | 10 failing unit tests |
| C7b | the numbers become public own properties, so a spread copies them | KILLED | 6 failing unit tests |
| C7c | an unchecked public factory is introduced | KILLED | 3 failing unit tests |
| C7d | the constructor becomes public | KILLED | 1 package(s) fail typecheck |
| C7e | an out-of-range window is clamped instead of refused | KILLED | 7 failing unit tests |
| C7f | the runtime nominal check at the service boundary is removed | KILLED | 4 failing unit tests |
| C7g | the runtime nominal check accepts anything object-shaped | KILLED | 11 failing unit tests |
| P1 | an exact replay re-applies instead of replaying | KILLED | 5 failing unit tests |
| P2 | SUBMISSION_UNKNOWN returns the attempt to QUEUED | KILLED | 5 failing unit tests |
| P3 | uncertainty stops suspending the reservation | KILLED | 3 failing unit tests |
| P4 | an acceptance does not persist the provider reference | KILLED | 16 failing unit tests |
| P5 | the clock is read before the lock is taken | KILLED | 3 failing unit tests |
| P6 | the sweeper stops requiring staleness | KILLED | 3 failing unit tests |
| P7 | the caller regains authority over the attempt event label | KILLED | 6 failing unit tests |
| P8 | stale recovery is labelled as a direct observation | KILLED | 5 failing unit tests |
| P9 | a lost CAS is reported as a replay | KILLED | 3 failing unit tests |
| P10 | a cross-tenant attempt is distinguishable from a missing one | KILLED | 3 failing unit tests |
| P11 | the reservation row lock is removed | KILLED | 4 failing db tests |
| P12 | the attempt lookup drops its tenant predicate | KILLED | 5 failing db tests |
| P13 | a CONSUMED reservation is suspended too | KILLED | 11 failing db tests |
| P14 | a missing reservation blocks persistence of provider reality | KILLED | 9 failing db tests |
| P15 | the reservation hold is never applied | KILLED | 12 failing db tests |
| P16 | the attempt outcome event is never appended | KILLED | 16 failing db tests |
| P17 | a QUEUED attempt may receive an outcome | KILLED | 3 failing unit tests |
| P18 | a half-written certainty on a SUBMITTING row is applied over | KILLED | 4 failing unit tests |
| P19 | the retryable flag stops selecting the failure state | KILLED | 7 failing unit tests |
| P20 | an attempt with no boundary instant is treated as stale | KILLED | 3 failing unit tests |

Two of these survived their first aiming and were fixed rather than excused:

- **`C7b`** first added an unused public field, which removes no guard — the
  identity is `#validated`, not the storage — so nothing could see it. Re-aimed
  at making `reconciliationWindowMs` a public own property, which genuinely lets
  a spread copy a validated number, it kills 6 tests.
- **`C7c`** adds an unchecked `static unchecked(w, s)` factory. Nothing calls it,
  so no behavioural test could ever see it appear. That is a real gap, closed by
  an API-surface test asserting the class's statics are exactly
  `{validate, isPolicy}` and its prototype exactly two getters with no setters. A
  new construction path now fails at the moment it is added.

`C7a`, `C7d` and `C7f`/`C7g` cover the rest of the boundary: removing the private
nominal identity, making the constructor public, and removing or defeating the
runtime check.

## Verification

All gates run against the live PostgreSQL instance at `revt_verify`. No live
provider was contacted; no provider client exists in this phase's dependency
graph.

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | Pass (all packages and apps) |
| `pnpm lint` | Pass (0 problems) |
| `pnpm test` | Pass — 88 files, **2315 tests** |
| `pnpm build` | Pass (Next.js production build) |
| `pnpm test:db` | Pass — 18 files, **481 tests** |
| `prisma migrate diff` schema ↔ live database | `No difference detected` |
| `prisma migrate diff` migrations ↔ schema | `No difference detected` |
| Mutation ledger | **52/52 killed, 0 survivors** |

The Prisma checks are run against `packages/database/prisma/schema.prisma`, which
is where the schema actually lives; the root `prisma/` directory holds only a
README pointing there.

### One CI failure, investigated

The duplicate **push** run on this exact SHA failed its `database` job once
(attempt 1), while the **pull-request** run on the same SHA passed. The failing
assertions were all in `tests/integration/paid-submission-authorization.db.test.ts`
— the Phase 4C-3B-2F-1 suite, untouched by this revision — and one of them was
`PrismaClientInitializationError: Environment variable not found: DATABASE_URL`,
which no application change can cause.

It was infrastructural, and re-running the failed job on the same commit passed
every step. Four independent pieces of evidence:

| Check | Result |
| --- | --- |
| Same SHA, PR run's `database` job | Success |
| Same SHA, push run re-run (attempt 2) | Success, all steps |
| Locally, `paid-submission-authorization.db.test.ts` × 3 | 64/64 each time |
| Locally, full `pnpm test:db` | 481/481 |

**The underlying fragility is real and worth naming**, even though it is not this
phase's defect. Those 2F-1 tests assert "still blocked" by sleeping on a wall
clock (`breathe()`) and then checking that a promise has not settled. Under a
loaded runner — two CI runs for one commit, each with its own Postgres service
container — the sleep can elapse before the blocked transaction has even reached
the lock. That is a latent flake in an already-merged suite, recorded here rather
than quietly re-run into green.

### Suite breakdown

| Suite | Tests |
| --- | --- |
| `packages/domain/src/submission/outcome.test.ts` | 58 |
| `packages/domain/src/submission/service.test.ts` | 33 |
| `packages/domain/src/submission/diagnostic-code.test.ts` | 58 |
| `packages/domain/src/submission/policy-nominality.test.ts` | 40 |
| `packages/domain/src/submission/entitlement-anomaly.test.ts` | 9 |
| `tests/integration/submission-outcome.db.test.ts` | 59 |

The database suite covers the three outcomes; replay exactness (no second event,
no timestamp moved, no `providerAcceptedAt` re-stamped); same-reference
`ACCEPTED` replay at `PROCESSING`, `PROVIDER_SUCCEEDED`, `OUTPUT_INGESTING` and
`OUTPUT_VERIFIED`, with a differing reference still conflicting at each;
`SUBMISSION_UNKNOWN` replay after `RECONCILIATION_EXHAUSTED`; the two
reconciliation instants and an already-past deadline; every conflict reason;
stale recovery at and one millisecond before its threshold; the full reservation
matrix including an absent reservation; the entitlement-anomaly matrix
cold-read back from transition-event metadata; the reservation hold's own event
type; hostile diagnostic codes refused with nothing written — thirteen of them,
including five that the previous syntactic rule admitted, each asserting the
attempt, the reservation, the event count and `normalizedErrorCode` all
unchanged; no-quota /
no-recovery-attempt / no-regeneration-consumed; cross-tenant isolation in both
directions; and six concurrency races — including the direct-versus-stale race
run on **two different clocks**.

Phase 4C-3B-2F-1's own suites are unchanged and still pass; the only shared code
touched is `appendEvent`'s rename to `appendGenerationEvent` and the widening of
`isCoherentAttemptRecord`.
