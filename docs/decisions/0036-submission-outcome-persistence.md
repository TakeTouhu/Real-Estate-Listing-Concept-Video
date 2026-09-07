# ADR-0036: A submission outcome is identified by provider reality, and its deadlines are anchored to the boundary

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

### 2. Identity is provider reality, not diagnosis

Two observations are the same when they agree on the **submission certainty**,
the **provider reference**, and the **execution state** that certainty implies.

`normalizedErrorCode` is deliberately excluded. It is the platform's own
classification of a failure, and two workers describing one rejection slightly
differently have not disagreed about what the provider did. Including it would
turn a cosmetic difference into a refusal that needs a human.

### 3. Every reconciliation timestamp is anchored to `submissionBoundaryEnteredAt`

```text
reconciliationStartedAt  = submissionBoundaryEnteredAt
reconciliationDeadlineAt = submissionBoundaryEnteredAt + reconciliationWindowMs
```

Never `now`, never a caller-supplied instant. Three properties follow from this
single choice and are not separately enforced anywhere:

1. A replay cannot extend a deadline — it computes the same value and matches.
2. A direct `SUBMISSION_UNKNOWN` and a stale sweep hours later produce
   byte-identical rows, so their race is benign: the loser replays rather than
   conflicting, and the two routes cannot disagree about when uncertainty ends.
3. A retry cannot buy time against the bound on an unresolved charge.

The window is configurable and capped at **24 hours**. The ceiling is the Phase
4C-3B-2E default constant itself rather than a second constant that could drift
from it.

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
