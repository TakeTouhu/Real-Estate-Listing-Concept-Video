# ADR-0082 — A failed deliverable settles its job in the same commit

Status: Accepted (GS-1, 2026-10-26). First milestone of the generation-to-preview
plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`).
Implements: ADR-0052 Decision 19 for the two deliverable failure points, a
composition `BLOCKED` and a terminal non-`VALID` validation verdict.
Builds on: ADR-0050 (durable composition execution and `BLOCKED`), ADR-0051
(deliverable validation and Transaction G), ADR-0048 (the media failure
settlement this mirrors for scenes), ADR-0081 (off-plan verdicts).

## Context

Two transactions record that a deliverable cycle will never produce a usable
video:

- `blockComposition` writes `BLOCKED` with a closed code, for a plan the
  composer refuses or a composition that cannot be made (ADR-0050);
- `finalizeInvalidMedia`, `finalizeOffPlan` and `finalizeIntegrityMismatch`
  write `INVALID_MEDIA` or `INTEGRITY_MISMATCH` for composed bytes that are not
  the planned usable video (ADR-0051, ADR-0081).

Neither ever reopens. Until now both left the job where it was, `COMPOSING` or
`DELIVERABLE_VALIDATING`, and an initial generation's reservation `RESERVED`,
waiting for a settlement nobody had built. ADR-0052 Decision 19 forbids exactly
that: when no technically valid deliverable was delivered, the reservation is
**released**, never consumed, and never left pending; a failed replacement keeps
the customer's earlier video current; and the three failure classes must not
bill differently.

Before generation can be started at all (the next milestones of this plan), a
failed cycle has to stop holding the customer's Unit.

## Decision 1 — Settle in the commit that records the failure

The settlement runs inside the transaction that writes the terminal row, after
that write and before the commit. The failure and its settlement are one fact:
both commit, or neither does. There is no sweep, no second transaction and no
window in which a terminal row exists beside an unsettled job.

## Decision 2 — Two arms, chosen by the deliverable pointer

`settleFailedDeliverable` (domain, pure) decides from the job's deliverable
pointer and its reservation's state, both read under their locks:

| Job | Reservation | Settles into |
| --- | --- | --- |
| no deliverable yet (initial generation) | `RESERVED` or `RECONCILIATION_HOLD` | job → `FAILED_TERMINAL`, reservation → `RELEASED` (`releasedAt` = the block or verdict instant) |
| holds a deliverable (replacement) | `CONSUMED` | job → `DELIVERABLE_READY`, pointer unchanged, reservation untouched |
| anything else | | refused, `RESERVATION_NOT_SETTLEABLE`, nothing written |

**The failure class never enters the decision.** A block and every verdict
settle through the one function, so they cannot come to bill differently.

**A replacement releases nothing because it holds nothing.** In this model a
job has one reservation, consumed by its first delivery; a scene regeneration
or recomposition cycle reserves no further Unit. So there is no replacement
reservation to release, and the consumed one paid for the video the customer
keeps. When a paid regeneration or a charged disclosure change reserves a Unit
of its own, its failure must release that reservation too; that is built with
them (`docs/decisions/TODO.md`).

**The job's scenes are left as they are.** Each was delivered valid, and
nothing reads the scenes of a `FAILED_TERMINAL` job.

**A reservation still `RECONCILIATION_HOLD` is released.** A deliverable that
was composed but never delivered is a cycle that provided nothing, whatever the
submission's certainty. Releasing from the hold is the same choice Transaction G
makes in the other direction when it consumes from it (ADR-0051).

**A contradicting reservation is a defect, not a settlement.** An initial
generation whose Unit is already consumed, released or never reserved, or a
replacement whose earlier delivery was never paid for, cannot be settled
honestly. The defect is thrown before any settlement write, and the caller's
transaction rolls its terminal row back with it, so the work row stays
`RUNNING` and the job where it was. Transaction G refuses the same reservations
for a valid video, as `RESERVATION_NOT_CONSUMABLE` and
`PARTIAL_PUBLICATION_STATE`.

That is not a resting place. Once its lease expires, the work is offered again,
and each pass repeats it: a composition re-encodes, a validation re-probes, and
both fail the same way. ADR-0078 accepted the same cost for a stored video
without its master. The validation sweep reports the defect's code; the
composition sweep counts it as failed. Nothing in production can produce any
of them today: every workflow that moves a reservation, the generic reservation
API (which can still release a held Unit) and reconciliation included, is
constructed by no production code. Making
such work findable, and stopping the repetition, is part of the operator
tooling recorded in `docs/decisions/TODO.md`; nothing runs these sweeps before
then.

## Decision 3 — Lock order: the cost-admission lock, then Reservation, then Job

```text
cost-admission advisory lock -> reservation -> job -> version -> work rows
```

Both writers now take, **first**, the organization and billing-cycle
cost-admission lock, as every entitlement release does
(`cost-admission-lock.ts`) and the media failure settlement (Transaction H)
does. They then lock the job's reservation, reached tenant-scoped through the
deliverable version (whose job never changes), and only then their own chain:
job, version, work rows. The reservation's cycle key is read before the lock
without one: it is frozen on the reservation when the hold is taken.

**Reservation before Job** is the order Transactions G, H and I take. Locking
the job first would deadlock with a writer that holds the reservation and then
needs the job. The database suite proves that the settlement waits behind such
a writer instead, for both writers, and that it waits for the cost-admission
lock. That the inverted order deadlocks was checked by hand, by locking the job
first in `blockComposition`: the lock-order test then fails with PostgreSQL's
deadlock error.

The other lifecycle transactions (the claims, `finalizeComposition`,
`finalizeValid`, the deferrals) still lock no reservation: they move no
entitlement.

## Decision 4 — Only the cycle the job is running settles

A block or a verdict now also answers `LEASE_LOST`, writing nothing, when the
job is not in that cycle's state (`COMPOSING`, `DELIVERABLE_VALIDATING`) or the
version is not the job's newest. `blockComposition` already asked the first;
`finalizeTerminalVerdict` now asks it as `finalizeValid` does. Settling a cycle
the job has left would fail or roll back a job for work nobody is running.

`blockComposition` also answers `LEASE_LOST` when the claim's work row is not
the version's own, as `finalizeComposition` asks. Its write names the row by
id, so a claim pairing one version with another version's work would otherwise
block work the transaction never locked, and settle a job whose own work is
still running. The verdicts already ask it, through the claim's validation
row.

## Decision 5 — A replay must find its settlement

A replay of a recorded block or verdict (`ALREADY_BLOCKED`,
`ALREADY_FINALIZED`) is answered only when the settlement is durable too:

- an initial generation: job `FAILED_TERMINAL` and reservation `RELEASED`;
- a replacement: the job no longer sits in the failed cycle's state with that
  version as its newest, and its reservation is still `CONSUMED`. It may have
  started a later revision since.

Otherwise the replay throws `SETTLEMENT_INCOMPLETE` and writes nothing. Such a
row was recorded before this build, or altered by hand; it is never settled late
by a replay, so the only settlement a terminal row ever gets is its own
commit's. Only development data can be in that state: delivery has never been
activated. `docs/migration-notes.md` gives the query that finds such rows.

## Decision 6 — Events

The terminal row itself still appends no deliverable event. The settlement
appends, with reason code `DELIVERABLE_FAILURE_SETTLEMENT`:

- on the job: `job.deliverable_failed` (to `FAILED_TERMINAL`) or
  `job.deliverable_rolled_back` (to `DELIVERABLE_READY`);
- on the reservation, initial arm only: `reservation.released`.

## Decision 7 — The generic API cannot end a Unit-holding job

The generic job transition now refuses, as `TRANSITION_RESERVED`, every edge
that would end a job holding the customer's Unit without its settlement:
`RESERVED → CANCELLED`, and `→ FAILED_TERMINAL` from `RESERVED`, `GENERATING`,
`SCENES_READY`, `COMPOSITION_PENDING`, `COMPOSING` and
`DELIVERABLE_VALIDATING`. It also refuses `COMPOSING → DELIVERABLE_READY`, the
rollback edge this settlement owns. `GENERATING`'s failure edge is the media
failure settlement's (ADR-0048); `COMPOSING`'s and `DELIVERABLE_VALIDATING`'s
are this one's; the rest have no owner yet and so cannot be taken at all. No
production code took any of them through the generic API.

The state machine gains `COMPOSING → DELIVERABLE_READY`. `DELIVERABLE_VALIDATING
→ DELIVERABLE_READY` already existed for Transaction G and now also serves the
rollback.

## Decision 8 — Dormant, no migration

No schema, enum or constraint changes: every state and column already exists.
Nothing in production constructs the composition or validation runner. Rolling
back to the previous build is safe: it settles nothing, and rows this build
settled are terminal or delivered states that build already handles.

## Not decided here

- **Transaction G's defects** (`DISCLOSURE_NOT_DRAWN`,
  `CLEAN_MASTER_NOT_RECORDED`, `VALID_FACTS_OFF_PLAN`, `RESERVATION_NOT_CONSUMABLE`)
  are refusals about rows this build cannot write. They still leave the job
  `DELIVERABLE_VALIDATING` for an operator.
- **A claim refused as `UNSUPPORTED_TARGET`**, and work under a profile or mode
  this build lacks, write no terminal row, so nothing settles them yet.
- **Provider-side failures before composition** (refusal, failure, an
  unresolved submission) are GS-2's.
- **A failed replacement after a delivered scene regeneration.** Transaction F
  moved that scene's delivered pointer to the new rendition and counted the
  customer's regeneration right when the scene was delivered. The rollback
  leaves both: the customer keeps the earlier video, the right stays counted,
  and the new rendition reaches a video only through a later revision. If the
  block came from that rendition's own bytes (`SOURCE_INTEGRITY_MISMATCH`,
  `SOURCE_BYTES_LIMIT_EXCEEDED`), every later revision plans it again and fails
  the same way, until that scene is regenerated once more. A scene regeneration
  that fails before its scene is delivered spends no right, so today whether
  the right comes back depends on which stage failed. Whether it should come
  back, and the pointer return, is an open decision (`docs/decisions/TODO.md`).
- **Operator recovery** (ADR-0052 Decision 20) of a settled initial generation:
  its job is `FAILED_TERMINAL`, which has no outgoing edge, so a recovery is a
  new job. Whether a recovered video delivered to the customer consumes a Unit is
  not decided anywhere (`docs/decisions/TODO.md`).

---

## Consequences

- A deliverable cycle that ends without a usable video never leaves the
  customer's Unit held: an initial generation fails and its Unit is released in
  the same commit, and a failed replacement returns the customer to the video
  they already had, charging no Unit. A scene regeneration right it used stays
  counted (*Not decided here*).
- `BLOCKED`, `INVALID_MEDIA` (on-plan or off-plan) and `INTEGRITY_MISMATCH`
  settle identically.
- The generic transition API can no longer end a Unit-holding job.
- Activation is untouched: paid Provider Activation, production Provider
  credentials, production paid AI calls, production scheduler activation and
  live Stripe charges remain BLOCKED.
