# ADR-0103 — Transaction G refuses a deleted Property's first video and releases its Unit

Status: Accepted (GS-7d-3b, 2026-10-29). Second of the two pull requests of
GS-7d-3, which the product owner approved on 2026-10-29 08:14Z ("承認" on the
decision card, `/mnt/project-files/cto/gs-7d-3-proposal.md`): GS-7d-3a
(ADR-0102) ends a deleted Property's video already sent or waiting to be
assembled; this one makes the publication of a deleted Property's first video
refuse and release its Unit.
Builds on: ADR-0052 Decision 19 (a Unit with no delivered video is released,
never held forever), ADR-0080 and ADR-0081 (what Transaction G requires),
ADR-0082 (a cycle with no usable video settles in the commit that records it),
ADR-0099, ADR-0100 and ADR-0102 (the endings of a deleted Property's video),
and ADR-0101 (a Property's deletion is one conditional write).

## Context

On 2026-10-29 the product owner decided ("すぐ戻す") that a deleted Property's
unfinished videos end at once and return their Units. ADR-0099, ADR-0100 and
ADR-0102 end such a video while it waits, while it is generated and while it
waits to be assembled. A video being assembled or checked (`COMPOSING`,
`DELIVERABLE_VALIDATING`) is not ended: a worker holds that work under a lease,
and nothing after the paid-submission gate reads the Property.

Transaction G (ADR-0051) publishes a validated video and, for the job's first
one, consumes its Unit, the only place a Unit is consumed. So a deleted
Property's video being assembled is still delivered and its Unit consumed. G is
also where the races the endings cannot see end: a deletion saved just after an
ending read the Property, or a job that moved into assembly first.

## Decision 1 — A deleted Property's first video is never published

Transaction G keeps its order of judgement (ADR-0051, ADR-0080, ADR-0081):

1. the job's pointer already names this version: **`ALREADY_PUBLISHED`**,
   whatever the Property. The publication happened;
2. the job is not `DELIVERABLE_VALIDATING`, the verdict is not the `VALID` row
   named, or the version is not newer than the customer's:
   **`NOT_PUBLISHABLE`**;
3. a version with no disclosure drawn, no Clean Master or measurements off its
   plan, or a hold that cannot be spent: the defects as before.

Then, for the job's **first** video, once its hold is shown `RESERVED` or
`RECONCILIATION_HOLD`, the Property is read. **Deleted, nothing is published:**
the job fails and its Unit is released in this commit, and G answers
**`PROPERTY_DELETED`**. The frozen funding is not checked (Phase 6A): nothing is
spent. A standing Property's video is published and its Unit consumed as
before.

Judged after every other refusal, so a target that is not the job's next
(another verdict, an older version, a job that moved on) ends nothing, and a
version this build would never publish still raises its defect.

**A replacement is published whatever its Property.** No Unit is held by one: it
replaces a video the customer already paid for (ADR-0083 Decision 3). Whether a
deleted Property's delivered video may be regenerated at all belongs to the open
item *Decide what a deleted Property's existing video projects allow*
(`docs/decisions/TODO.md`).

## Decision 2 — The settlement of a cycle with no usable video, with its cause

The refusal settles through `settleDeliverableFailure`, the settlement of a
blocked composition and of a terminal verdict (ADR-0082), so a deleted Property
cannot come to bill differently from them (ADR-0052 Decision 19). The decision
is `settleFailedDeliverable`'s: an initial generation fails and its Unit is
released from the state it is in. The settlement gains a `cause`, which names the
events and changes nothing it writes: `NO_USABLE_VIDEO` (the default, for the
block and the verdicts) or `PROPERTY_DELETED`.

**What is written.** The job moves `DELIVERABLE_VALIDATING → FAILED_TERMINAL`
with a `job.ended_property_deleted` event, the type the endings of ADR-0099 and
ADR-0102 record. The reservation moves to `RELEASED` with `releasedAt` set to
the publication's instant and a `reservation.released` event. Both events carry
`PROPERTY_DELETED` as their reason code and the caller's actor and correlation.
`deliverableSettlementRecord(kind, cause)` names them. The pointer is proved
unmoved. No deliverable event: the version stays validated and is never
published, and its `VALID` verdict stays the evidence it was.

**A hold on reconciliation is released too**, as a terminal verdict releases it.
ADR-0102 leaves such a hold to reconciliation, because the job is still being
generated and reconciliation may restore it. Here every scene was delivered and
the video validated, and Transaction G already moves that hold: it would consume
it. The same authority releases it.

## Decision 3 — The cost-admission lock first, the Property between the reservation and the job

```text
cost-admission advisory lock (organization, the reservation's frozen cycle or "unreserved")
  -> GenerationReservation   FOR UPDATE
  -> Property                FOR SHARE
  -> GenerationJob, version  FOR UPDATE
  -> composition, validation
  -> judge
  -> publish and consume, or settle and release, or refuse
  -> commit
```

G now takes the cost-admission lock, as every release does
(`cost-admission-lock.ts`): the paid-submission gate reads the reservation under
it, so nothing is authorized against a Unit G has just released. G takes it on
every call, a standing Property's first video and a replacement included,
because it cannot know before it locks whether it will release. The cost is
that a publication is ordered with the cost decisions of its organization's
cycle; G is one short transaction with no I/O. The billing-cycle key is read
before the lock; it is frozen on the hold.

The Property is held `FOR SHARE` after the reservation and before the job, as the
gate and the endings hold it: a deletion saving is waited for and then seen,
and a deletion waits for G's commit. Every read is tenant-scoped through the
job's project, and the Property's by its own organization too, as ADR-0100 reads
it: another organization's id locks nothing, and a Property of another
organization is not the job's.

**Against the other writers.** A Property's deletion and rename write the
Property row alone (ADR-0101). The launch commit holds a waiting job's Property
`FOR SHARE` before that job's reservation, both shared. The composition claim
and finalize, and the validation claim, `VALID` verdict and deferral, lock the
job first and then wait for neither a Property nor the cost-admission lock. The
composition block and the terminal verdicts take the cost-admission lock and
the reservation before the job, as G does. So no writer holds a row G waits for
while it waits for one G holds, and there is no cycle.

## Decision 4 — The work before it is not cut

A deleted Property's video in `COMPOSING` is still composed and checked, and
discovery still offers it to validation: G is where it ends. That compute is
VTaVision's, never the customer's. The validation runner reports G's answer,
`PROPERTY_DELETED`, unchanged, and counts it as claimed work. Once G has ended
the job, discovery no longer offers the version, the claim answers
`NOT_ELIGIBLE` and a replay of G `NOT_PUBLISHABLE`.

The Unit comes back when the check finishes, normally within minutes, and is
never consumed. The composed video stays in managed storage at its deliverable
key, which no route signs yet (preview and download are GS-12's), and its Clean
Master in the internal key namespace, which every signed URL refuses
(ADR-0074).

## Decision 5 — Nothing runs it yet

Nothing outside tests constructs the validation repository or its runner, and
the static tests keep it so. The pipeline command (GS-9) is what will run them,
on the test provider only.

## Considered and not done

**Stopping composition or validation early for a deleted Property.** It would
save compute only: the Unit's outcome is the same, and G must judge anyway for
the deletion saved after either step. It would add a refusal to four more
transactions.

## Not decided here

- **A regeneration of a deleted Property's delivered video** (Decision 1).
- **Removing a refused video's composed outputs.** They are only in internal
  storage. Removing them belongs to the 30-day trash lifecycle
  (`docs/decisions/TODO.md`, *Build the 30-day trash lifecycle*).
- **How the customer is shown such a video** (GS-10, GS-11). The wording must not
  name a provider or a model.
- **Whether a release the customer did not ask for warrants an audit entry**, as
  for ADR-0102 (`docs/decisions/TODO.md`, *A preflight-failure audit event, if
  wanted, belongs to orchestration*).

## Consequences

- `@app/domain`: `PublishValidatedDeliverableOutcome` and
  `DeliverableValidationRunOutcome` gain `PROPERTY_DELETED`. The
  `deliverable-settlement` module gains `DeliverableFailureCause`,
  `DeliverableSettlementRecord` and `deliverableSettlementRecord`.
- `@app/database`: Transaction G as above. `settleDeliverableFailure` gains a
  last `cause` parameter, `NO_USABLE_VIDEO` by default, so the composition block
  and the terminal verdicts write and record exactly what they did.
- No migration. Nothing outside tests constructs the repository or the runner,
  so no path a customer or a worker reaches changes.
