# Phase 4C-3B-2G-1 — Completion report

Submission outcome persistence and uncertainty entry. Base:
`ce1fed14c1125bf83d26ab8ec0ef4a5d725f34e7`.

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
  | { kind: "ACCEPTED"; providerPredictionId: string; providerAcceptedAt: EpochMillis }
  | { kind: "DEFINITIVELY_REJECTED"; retryable: boolean; normalizedErrorCode: string | null }
  | { kind: "SUBMISSION_UNKNOWN"; normalizedErrorCode: string | null };
```

No HTTP status, no provider error body, no vendor enum, no provider name. An
adapter translates its own vocabulary into one of these three shapes and this
layer never learns which provider it was talking to. That is what lets the
persistence rules be written once and exercised in full without a provider
existing.

`retryable` says only whether a *new* attempt row may be admitted for the same
request. It never means this row may be re-POSTed. Nothing in this phase ever
re-POSTs anything.

An `ACCEPTED` whose `providerPredictionId` is blank is rejected as
`OBSERVATION_MALFORMED` rather than persisted. An acceptance that cannot name
what was accepted has not established acceptance; it is uncertainty, and it
belongs on the third arm.

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

Certainty, then the provider reference, then the state it implies.
`normalizedErrorCode` is deliberately **excluded**: it is diagnostic text about
how the platform classified a failure, and two workers describing the same
rejection slightly differently have not disagreed about what the provider did.

| Recorded vs observed | Answer |
| --- | --- |
| Same certainty, same reference, same state | `REPLAYED` |
| Different certainty (`ACCEPTED` vs `SUBMISSION_UNKNOWN`) | `CONFLICTING_OBSERVATION` / `CERTAINTY_MISMATCH` |
| Same certainty, different provider reference | `CONFLICTING_OBSERVATION` / `PROVIDER_REFERENCE_MISMATCH` |
| Same certainty, different terminal state | `CONFLICTING_OBSERVATION` / `TERMINAL_STATE_MISMATCH` |

A second, different provider reference is refused rather than overwritten.
Overwriting would discard the ability to ask the provider about the reference
that was replaced — a reference the platform may still owe money against.

## Every deadline is anchored to the boundary

```ts
reconciliationStartedAt  = submissionBoundaryEnteredAt
reconciliationDeadlineAt = submissionBoundaryEnteredAt + reconciliationWindowMs
```

Never `now`, never the current time plus a window, never a value a caller
supplies. Three properties fall out of that single choice, and none of them are
separately enforced:

1. **Replay cannot extend a deadline.** The same observation ten hours later
   computes the same durable shape, matches the record, and writes nothing.
2. **The two entry routes agree.** A direct `SUBMISSION_UNKNOWN` and a stale
   sweep hours later produce byte-identical rows, so their race is benign — the
   loser replays rather than conflicting.
3. **A retry cannot buy time.** The window bounds how long the platform carries
   an unresolved charge, and deriving it from when someone happened to look would
   let repeated retries push that bound indefinitely.

### Window policy

| Setting | Default | Bound |
| --- | --- | --- |
| `reconciliationWindowMs` | 24 h (the Phase 2E constant) | `> 0`, and **≤ 24 h** |
| `staleSubmittingAfterMs` | 15 min | `> 0`, and ≤ the reconciliation window |

The ceiling *is* the Phase 2E default rather than a second constant that could
drift from it. An attempt in `RECONCILIATION_PENDING` holds uncertain provider
cost against its organization's Safety Guard for the whole window, so a window
measured in days would let one incident suppress a tenant's throughput long after
anyone could still find out what happened.

The stale threshold is deliberately far shorter than the window: becoming
*uncertain* should happen quickly, while *resolving* that uncertainty gets the
long budget. A threshold beyond the window is refused — it would declare an
attempt lost after the deadline it is supposed to be given.

`validateReconciliationPolicy` returns a result rather than throwing.
Configuration arrives from outside the process and a bad value is an operator
mistake, not a programming defect, so it is answerable and the caller decides
whether to refuse startup or fall back.

## Staleness is at-or-after, on an injected clock

```ts
isStaleSubmitting = now >= submissionBoundaryEnteredAt + staleSubmittingAfterMs
```

At-or-after, not strictly after: the threshold is the first instant at which the
attempt counts as lost, and the opposite reading leaves one instant in which
nothing may act.

The clock is a `SubmissionClock` port, and the service reads it **once, inside
the lock**. A staleness judgement made before waiting for the lock could declare
an attempt lost that a worker finished while this transaction queued.

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
| Direct `SUBMISSION_UNKNOWN` versus stale sweep | one `APPLIED`, one `REPLAYED`; both routes computed identical state |
| Reservation `RELEASED` versus uncertainty entry | uncertainty entry blocks on the row lock, then records the outcome; the released hold is not revived |

Provider reality is never lost because a concurrent entitlement transition won
first. In the last race the reservation ends `RELEASED` and the attempt still
ends `RECONCILIATION_PENDING`.

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
| ADR | `docs/decisions/0036-submission-outcome-persistence.md` — extends ADR-0035 from "submission *returns* a three-armed outcome" to how that outcome is persisted, identified on replay, and anchored in time |

## Structure

```text
packages/domain/src/submission/
├── observation.ts            provider-neutral normalized observation
├── reconciliation-window.ts  window + stale policy, validation, anchoring
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
- No Phase 4C-3B-2G-2 work (reconciliation resolution, deadline expiry,
  `RECONCILIATION_EXHAUSTED`).

## Mutation ledger — 44/51 killed

Every mutation removes exactly one rule this phase is supposed to enforce, from
an artefact that actually executes. A mutation is *killed* when the suites fail,
and each is restored byte-identically before the next runs.

| ID | Mutation | Result | Detected by |
| --- | --- | --- | --- |
| O1 | an exact replay re-applies instead of replaying | KILLED | 11 failing unit tests |
| O2 | a certainty mismatch stops being a conflict | KILLED | 8 failing unit tests |
| O3 | a different provider reference stops being a conflict | KILLED | 6 failing unit tests |
| O4 | a terminal-state mismatch stops being a conflict | KILLED | 4 failing unit tests |
| O5 | `RECONCILIATION_PENDING` stops counting as post-submission | KILLED | 7 failing unit tests |
| O6 | `PROCESSING` stops counting as post-submission | KILLED | 9 failing unit tests |
| O7 | `FAILED_TERMINAL` stops counting as post-submission | KILLED | 5 failing unit tests |
| O8 | both reconciliation timestamps are anchored to now | KILLED | 3 failing unit tests |
| O9 | the deadline is anchored to now while the start stays at the boundary | KILLED | 6 failing unit tests |
| O10 | an acceptance does not persist the provider reference | KILLED | 10 failing unit tests |
| O11 | a blank provider reference is accepted as an acceptance | KILLED | 3 failing unit tests |
| O12 | `SUBMISSION_UNKNOWN` returns the attempt to `QUEUED` | KILLED | 11 failing unit tests |
| O13 | uncertainty stops suspending the reservation | KILLED | 3 failing unit tests |
| O14 | an acceptance suspends the reservation too | KILLED | 3 failing unit tests |
| O15 | the retryable flag stops selecting the failure state | KILLED | 7 failing unit tests |
| O16 | a `QUEUED` attempt may receive an outcome | KILLED | 3 failing unit tests |
| O17 | a cancelled attempt may receive an outcome | KILLED | 3 failing unit tests |
| O18 | a half-written certainty on a `SUBMITTING` row is applied over | KILLED | 4 failing unit tests |
| O19 | a malformed observation is persisted | KILLED | 3 failing unit tests |
| O20 | an attempt with no boundary instant is treated as stale | KILLED | 3 failing unit tests |
| W1 | the stale threshold becomes strictly-after instead of at-or-after | KILLED | 8 failing unit tests |
| W2 | the 24-hour reconciliation ceiling is removed | KILLED | 3 failing unit tests |
| W3 | the ceiling drifts to 48 hours | KILLED | 3 failing unit tests |
| W4 | a non-positive reconciliation window is accepted | KILLED | 6 failing unit tests |
| W5 | a non-positive stale threshold is accepted | KILLED | 3 failing unit tests |
| W6 | a stale threshold beyond the window is accepted | KILLED | 3 failing unit tests |
| W7 | the deadline is computed from the stale threshold instead of the window | KILLED | 3 failing unit tests |
| S1 | the clock is read before the lock is taken | KILLED | 3 failing unit tests |
| S2 | the sweeper stops requiring staleness | KILLED | 3 failing unit tests |
| S3 | a replay is reported as a fresh application | KILLED | 5 failing unit tests |
| S4 | the caller regains authority over the event label | KILLED | 4 failing unit tests |
| S5 | stale recovery is labelled as a direct observation | KILLED | 3 failing unit tests |
| S6 | a lost CAS is reported as a replay | KILLED | 3 failing unit tests |
| S7 | a cross-tenant attempt is distinguishable from a missing one | KILLED | 3 failing unit tests |
| R1 | the reservation row lock is removed | KILLED | 4 failing db tests |
| R2 | the reservation is locked `FOR SHARE` instead of `FOR UPDATE` | **SURVIVED** | 0 failing tests |
| R3 | the cost-admission advisory lock is removed | KILLED (compile only) | 1 package fails typecheck |
| R3b | the advisory lock is keyed on the attempt instead of the cycle | **SURVIVED** | 0 failing tests |
| R4 | the CAS drops the version predicate | KILLED (compile only) | 1 package fails typecheck |
| R4b | the CAS accepts any version at or above the expected one | **SURVIVED** | 0 failing tests |
| R5 | the CAS drops the `SUBMITTING` predicate | **SURVIVED** | 0 failing tests |
| R6 | the CAS drops the `PRE_SUBMISSION` predicate | **SURVIVED** | 0 failing tests |
| R7 | the attempt lookup drops its tenant predicate | KILLED | 5 failing db tests |
| R8 | a `CONSUMED` reservation is suspended too | KILLED | 7 failing db tests |
| R9 | a missing reservation blocks persistence of provider reality | KILLED | 7 failing db tests |
| R10 | the reservation hold is never applied | KILLED | 8 failing db tests |
| R11 | the attempt outcome event is never appended | KILLED | 9 failing db tests |
| R12 | the reservation hold event is never appended | KILLED | 4 failing db tests |
| R13 | the incoherent-write guard is removed | KILLED (compile only) | 1 package fails typecheck |
| R13b | the incoherent-write guard is made unconditionally true | **SURVIVED** | 0 failing tests |
| R14 | both reservation defences are weakened at once | **SURVIVED** | 0 failing tests |

R3, R4 and R13 stop compiling because the mutation orphans a variable or an
import, which is a real but uninformative kill. Each was re-aimed as `R3b`,
`R4b` and `R13b` so the *rule* is measured rather than the compiler, and all
three of those survive.

### The survivors, and why they are reported rather than papered over

All seven live in the persistence layer, and all seven are the same finding:
**the write is already serialized by something else, so a second defence removes
nothing observable.**

- **R5, R6, R4b — the CAS predicates.** `loadFacts` and `apply` run inside one
  transaction that already holds both locks, and the evaluator refuses every
  non-boundary state before `apply` is reached. Nothing can change the row in
  between, so `orchestrationState`, `submissionCertainty` and strict version
  equality in the `where` clause cannot currently be the thing that stops a bad
  write. They stay because they are what makes the write correct *without*
  relying on that reasoning holding for every future caller — the compare-and-set
  should be safe read in isolation.
- **R2, R3b, R14 — the lock mode and the lock key.** The reservation `UPDATE`
  takes an exclusive row lock of its own and waits for any shared holder, so a
  `FOR SHARE` acquisition still serializes the transition; and the reservation
  row lock still serializes two writers even when the advisory lock is keyed
  wrongly. `FOR UPDATE` is kept because it takes the mode it will need at a
  single ordered point instead of upgrading shared→exclusive mid-transaction,
  which is the classic deadlock shape; the advisory key is kept aligned with
  Phase 2F-1 because that is what makes the two phases contend on the cycle they
  share rather than by accident. Neither claim is that the suite proves them, and
  the code comment says so.
- **R13b — the incoherent-write guard.** It is defence in depth over a database
  CHECK constraint. No test writes an incoherent shape, because the evaluator
  cannot produce one; the guard exists so that a future writer that could would
  fail loudly here rather than as an opaque constraint error.

`R1` — removing the reservation row lock outright — kills four database tests,
which is what establishes that the serialization these survivors are redundant
*with* actually exists and is load-bearing.

## Verification

All gates run against the live PostgreSQL instance at `revt_verify`. No live
provider was contacted; no provider client exists in this phase's dependency
graph.

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | Pass (all packages and apps) |
| `pnpm lint` | Pass (0 problems) |
| `pnpm test` | Pass — 85 files, **2175 tests** |
| `pnpm build` | Pass (Next.js production build) |
| `pnpm test:db` | Pass — 18 files, **448 tests** |
| `prisma migrate diff` schema ↔ live database | `No difference detected` |
| `prisma migrate diff` migrations ↔ schema | `No difference detected` |
| Mutation ledger | 44/51 killed, 7 documented survivors |

### Suite breakdown

| Suite | Tests |
| --- | --- |
| `packages/domain/src/submission/outcome.test.ts` | 38 |
| `packages/domain/src/submission/service.test.ts` | 20 |
| `tests/integration/submission-outcome.db.test.ts` | 26 |

The database suite covers the three outcomes, replay exactness (no second event,
no timestamp moved, no `providerAcceptedAt` re-stamped), all three conflict
reasons, stale recovery at and one millisecond before its threshold, deadline
parity between the two entry routes, the full reservation matrix including an
absent reservation, no-quota / no-recovery-attempt / no-regeneration-consumed,
cross-tenant isolation in both directions, and six concurrency races.

Phase 4C-3B-2F-1's own suites are unchanged and still pass; the only shared code
touched is `appendEvent`'s rename to `appendGenerationEvent` and the widening of
`isCoherentAttemptRecord`.
