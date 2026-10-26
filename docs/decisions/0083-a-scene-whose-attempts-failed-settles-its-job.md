# ADR-0083 — A scene whose attempts ended without a video settles its job

Status: Accepted (GS-2a, 2026-10-26). Second milestone of the
generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`).
Implements: ADR-0052 Decision 19 for the provider-side failure points: a
refused submission, a provider failure and an unresolved submission.
Builds on: ADR-0036 (submission outcomes), ADR-0037 (reconciliation and its
release on exhaustion), ADR-0038 (completion),
ADR-0048 (the media failure settlement, Transaction H, this mirrors), ADR-0082
(the deliverable failure settlement).

## Context

A scene request generates through attempts. Three writers end an attempt
without a video, each in its own transaction and under its own locks:

| Writer | Ends the attempt as |
| --- | --- |
| submission outcome (ADR-0036) | `FAILED_RETRYABLE` or `FAILED_TERMINAL` when the provider refused it |
| completion (ADR-0038) | `FAILED_RETRYABLE` or `FAILED_TERMINAL` when the provider gave up |
| reconciliation (ADR-0037) | `FAILED_*` when it proves a rejection, `RECONCILIATION_EXHAUSTED` when its window ran out |

The state machine also has `QUEUED → FAILED_*` and
`QUEUED → CANCELLED_PRE_SUBMISSION`, for an attempt that fails or is cancelled
before it is sent, but no writer takes either edge yet: the execution
preflight records its failures in the legacy `state` column, not in the
orchestration state (see "Not decided here").

None of these end states has an outgoing edge, and nothing creates another attempt
for such a request: the only automatic retry is the media recovery of ADR-0047,
which answers a video that failed its media check, not an attempt with no video
(ADR-0037 Decision 1: no conclusion admits a replacement). So the scene can never
be delivered and its job can never deliver a video.

Until now each writer left the request and the scene `GENERATING`, the job
`GENERATING` and an initial generation's reservation `RESERVED`. Reconciliation
releases a held Unit on a terminal rejection or on exhaustion (ADR-0037
Decision 6) but leaves the job `GENERATING`; on a retryable rejection it restores
the hold to `RESERVED`. ADR-0052 Decision 19 forbids every one of these
shapes: when no technically valid deliverable was delivered, the reservation is
**released** and the job never left pending. The product owner confirmed the
rule on 2026-10-26: a Unit is consumed only when a technically valid video is
delivered, and every failure before delivery, on the AI side or VTaVision's,
consumes none.

## Decision 1 — A sweep over durable facts, not another writer

The settlement is **Transaction K**, its own short transaction, offered requests
by a bounded candidate query. It is not added to the writers that end
attempts, for three reasons:

- **The failure is already durable.** An ended attempt never moves again, so
  the request's fate is fixed the moment its newest attempt ends. A settlement a
  moment later decides from the same facts the writer had; there is nothing a
  separate commit can miss.
- **Several lock footprints.** Settling inside each writer means teaching each
  of their transactions to take the cost-admission lock and the reservation
  before its own rows, and proving every new order against every other writer.
  One transaction with one order is reviewable; one per writer is
  not.
- **It reaches rows no writer will see again.** A request whose attempt ended
  before this build is settled by the same query; a writer change would never
  reach it.

The sweep has no work row and no lease, as for Transaction F: a settled request
is no longer a candidate, and the candidate query mirrors every condition the
decision refuses on, so a request the settlement would refuse is never offered
and cannot hold the head of a batch. A candidate whose settlement throws (a
defect, a lost connection) is reported as failed and the pass goes on to the
next, so one bad row never stops the others from settling.

The cost is the interval between the attempt ending and the next pass. During
it the Unit is still held, and the paid-submission gate can still send another
scene of the same job, a provider cost that buys nothing once the job fails. That
cost is VTaVision's, never the customer's, and it is bounded by how often the
sweep runs. Nothing runs it yet (Decision 7).

## Decision 2 — Which requests settle

A request settles when, under its locks:

1. it is `GENERATING` and has delivered nothing;
2. it has at least one attempt, **every** attempt has ended, and the **newest**
   ended without a video (`FAILED_RETRYABLE`, `FAILED_TERMINAL`,
   `RECONCILIATION_EXHAUSTED` or `CANCELLED_PRE_SUBMISSION`);
3. its job is `GENERATING`.

**How the attempt ended never enters the decision**, so a refusal, a provider
failure and an unresolved submission cannot come to bill differently, from each
other or from a media failure (ADR-0048) or a failed deliverable (ADR-0082).

**`FAILED_RETRYABLE` settles too.** "Retryable" classifies the provider's
answer; nothing in the system retries it. The internal service-recovery budget
(`docs/decisions/TODO.md`) is what will decide whether a retryable failure gets
another attempt first. Until it exists, a retryable failure ends the scene like
any other, rather than holding the customer's Unit for a retry nobody makes.

**A failed recovery settles.** A request whose earlier attempt produced a video
that failed its media check, and whose media recovery attempt then ended without
one, is this settlement's, not Transaction H's: Transaction H answers an attempt
that produced a video and failed its media check, and this only a request whose
newest attempt produced none. Both take the cost-admission lock, the
reservation and the job, scene and request in that order; Transaction H then
also locks the attempt, its validation and its work row, which this does not
need (Decision 4). Each refuses a request the other has failed.

## Decision 3 — Two arms, chosen by the request's kind

| Request | Required shape | Reservation | Settles into |
| --- | --- | --- | --- |
| `INITIAL` | scene `GENERATING` with no delivered pointer; job holds no deliverable | `RESERVED` or `RECONCILIATION_HOLD` | request, scene and job → `FAILED_TERMINAL`; reservation → `RELEASED` |
| `INITIAL` | the same | `RELEASED` (reconciliation released it, ADR-0037 Decision 6) | request, scene and job → `FAILED_TERMINAL`; reservation not written |
| `USER_REGENERATION` | scene `REVISING`, its pointer naming an earlier `DELIVERED` request of the same scene; job holds a deliverable; every other scene `READY`; no other regeneration open | `CONSUMED` | request → `FAILED_TERMINAL`; scene → `READY` and job → `DELIVERABLE_READY`, both pointers unchanged; reservation not written |
| anything else | | | refused, nothing written |

The request's `failedAt` and, when this commit releases it, the reservation's
`releasedAt` are the one settlement instant. The attempts are never written:
they are the evidence.

**A regeneration releases nothing because it holds nothing**, as in ADR-0082:
the job's one reservation was consumed by the video the customer keeps. Its
regeneration right is not spent either: a right is spent on delivery, and this
request delivered nothing.

**One revision at a time** (ADR-0048 Decision 10) is what makes the rollback
unambiguous. With another scene not `READY`, or another regeneration open, the
earlier deliverable could discard that work; the settlement refuses rather than
choose.

**A refusal is an answer, not a retry.** `SHAPE_CONFLICT`,
`RESERVATION_NOT_SETTLEABLE` and `JOB_NOT_GENERATING` name rows this
settlement cannot settle honestly, and none of them is offered again. Nothing in
production can produce the first two: every workflow that moves these rows is
constructed by no production code. Finding and acting on such rows is part of the
operator tooling in `docs/decisions/TODO.md`. A replay of a settled request
answers `REQUEST_NOT_GENERATING`, writing nothing.

## Decision 4 — Lock order: the cost-admission lock, then Reservation, then the chain

```text
cost-admission advisory lock -> reservation -> job -> scene -> request
```

The order Transaction H takes, and every entitlement release: the
paid-submission gate reads the reservation under the same advisory lock, so no
attempt crosses the provider boundary against a Unit this has just released
(it then answers `RESERVATION_RELEASED`). The billing-cycle key is read before
the lock, which is safe because it is frozen when the hold is taken; a job with
no reservation takes the organization's `unreserved` lock.

The attempts are read, not locked. Admission takes the request lock before it
adds one, so none can appear while this holds it, and every attempt it settles on
has ended, so none can move.

The database suite proves the settlement waits for the cost-admission lock;
waits behind a writer that holds the reservation and then needs the job, instead
of deadlocking with it; waits behind a writer holding the job and decides from
what that writer committed; that two settlements of one request settle it once;
and that two failed scenes of one job, settled together, release its Unit once
and fail the job once.

## Decision 5 — Events

With reason code `ATTEMPT_FAILURE_SETTLEMENT`, under the caller's correlation:

- on the request: `scene_request.failed`;
- initial arm: `scene.failed`, `job.scene_failed`, and, when this commit
  releases it, `reservation.released` on the reservation;
- regeneration arm: `scene.revision_rolled_back`, `job.revision_rolled_back`.

## Decision 6 — The generic API cannot fail a generating request or scene

The generic transitions now refuse, as `TRANSITION_RESERVED`, request
`GENERATING → FAILED_TERMINAL` and scene `GENERATING → FAILED_TERMINAL`. A
generating request fails only with its scene, and its scene only with its job and
the release of its Unit; failing one alone would leave a job that can neither
deliver nor be settled. Transactions H and K own both edges. No production code
constructs either generic repository.

## Decision 7 — Dormant, no migration

No schema, enum or constraint changes: every state and column already exists.
Nothing in production constructs `AttemptFailureSettlementRunner` or the
repository; a static test fails the build if anything does. The development-only
pipeline command (GS-9) will run it beside the other steps. Rolling back to the
previous build is safe: it settles nothing, and every row this build settled is
`FAILED_TERMINAL`, which has no outgoing edge, or `READY` and
`DELIVERABLE_READY` with the customer's video, which that build handles as any
delivered job.

## Not decided here

- **The failed job's other scenes.** An initial job fails with the first scene
  that settles; its other scenes and their requests stay where they are, and a
  later scene's settlement answers `JOB_NOT_GENERATING`. Nothing can deliver
  them: delivery (Transaction F) requires the job `GENERATING`, and the
  paid-submission gate refuses a released Unit, so a queued sibling is never
  sent. One already accepted by the provider still runs there. Ending those
  scenes, and cancelling their queued attempts, is GS-2b, for this settlement
  and Transaction H alike, which leaves the same shape (ADR-0048 Decision 6).
  *Built in GS-2b: ADR-0084.*
- **An attempt that fails preflight.** The execution preflight fails an attempt
  it cannot send (the request cannot be reconstructed, storage is unreachable)
  by writing the legacy `state` column, and leaves the orchestration state
  `QUEUED`. Such an attempt has not ended in the orchestration vocabulary, so
  its request is never a candidate here. Moving that writer onto the
  orchestration state is recorded in `docs/decisions/TODO.md`; nothing in
  production runs the preflight against an orchestrated attempt yet.
- **The side effects on the failed job's siblings**, until GS-2b ends them: the
  paid-submission gate answers `RESERVATION_RELEASED` for a sibling's queued
  attempt, which reads as an anomaly though it is expected; and a sibling's
  Transaction H work row answers `NOT_EXHAUSTED` once the job has failed (H
  requires the job `GENERATING` and the reservation held), so it is offered
  again on every pass.
- **An attempt that never ends.** One left `PROCESSING` by a provider that
  never answers, or `OUTPUT_INGESTING` by an output copy that keeps failing
  (that state is resumable on purpose, so a storage fault is never
  recorded as the provider's), has not ended, so its request
  is never a candidate. Bounding how long an accepted attempt may run is not
  decided (`docs/decisions/TODO.md`).
- **A job still `RESERVED`.** The settlement requires the job `GENERATING` and
  its scene `GENERATING`, the shape the whole-video start step (GS-4) produces
  when it admits the first attempts. Nothing produces any other today.
- **The internal service-recovery budget** may later retry a failed attempt
  before this settles it (`docs/decisions/TODO.md`).
- **Operator recovery** of a settled initial generation is a new job, as after
  ADR-0082, and whether its delivered video consumes a Unit is still open
  (`docs/decisions/TODO.md`).

---

## Consequences

- A scene whose attempts ended without a video no longer leaves its job
  `GENERATING` or the customer's Unit held: an initial generation fails and its
  Unit is released, and a failed scene regeneration returns the customer to the
  video they already had, charging nothing and spending no regeneration right.
- A refused submission, a provider failure and an unresolved submission settle
  identically, and identically to ADR-0048's and ADR-0082's failures. A failed
  output copy does not end its attempt, which stays `OUTPUT_INGESTING` and
  resumes, so it settles nothing.
- The generic transition API can no longer fail a generating request or scene.
- Activation is untouched: paid Provider Activation, production Provider
  credentials, production paid AI calls, production scheduler activation and
  live Stripe charges remain BLOCKED.
