# ADR-0081 — A deliverable must measure its planned size and length

Status: Accepted (DS-6b, 2026-10-24). Part of the AI-generated disclosure
plan the product owner approved on 2026-10-20
(`/mnt/project-files/cto/disclosure-proposal.md`).
Implements: the second half of DS-6, the last disclosure milestone.
Builds on: ADR-0050 (the composer holds or trims each scene to its planned
length, and refuses a plan whose scenes do not sum to the admitted one),
ADR-0051 (deliverable validation and Transaction G), ADR-0078 (profile v2's
frozen raster and rate), ADR-0080 (the first half of DS-6).

## Context

Deliverable validation proves that the composed bytes are a usable MP4-family
video, and reports their measurements: duration, width, height and stream
counts. It compared those measurements with nothing. A deliverable of another
frame size, or one missing a scene, would have been validated and published
like any other.

Scene outputs are compared with nothing on purpose: a provider's native
resolution is not the customer's target. A deliverable is different. This
platform's own composer made it, padding every scene into the frozen raster and
holding or trimming each to its planned length, and the composition runner
blocks, before composing, a plan whose scenes do not sum to the length the job
was admitted for (`DURATION_INVARIANT_MISMATCH`, ADR-0050 Decision 6). So a
deliverable of another size or length is one the composer got wrong. It is not
the video the customer was promised, and the disclosure image, one per frame
size (ADR-0071 Decision 1), was not made for it.

## Decision 1 — The plan

A deliverable version's plan is derived, never stored:

- **frame size**: its composition's frozen `targetWidthPx` × `targetHeightPx`;
- **length**: its job's `requestedDurationSeconds` × 1000 ms;
- **tolerance**: one frame period of the composition's frozen rate, rounded up
  to whole milliseconds: `ceil(1000 × denominator / numerator)`, 34 ms at
  30 fps.

`plannedDeliverableMedia` derives it, and refuses any value that is not a
positive safe integer with `PERSISTED_RECORD_MALFORMED`. All four composition
columns and the job's column are `NOT NULL` and checked positive, so no row
this build writes can fail it.

## Decision 2 — The comparison

`deliverableOffPlanReason(facts, plan)` answers:

1. `VIDEO_DIMENSIONS_INVALID` when the width or height differs from the plan's,
   compared exactly;
2. otherwise `DURATION_INVALID` when the measured length differs from the
   plan's by more than the tolerance;
3. otherwise `null`.

The size is judged first, so a video wrong in both is refused with the same
reason on every worker and every attempt. Nothing else is judged here: the
container and stream counts stay the media policy's.

**Why one frame.** The container's duration is rounded to the millisecond on
the way in (`Math.round(format.duration × 1000)`), and a frame is the smallest
step the composer takes. On real FFmpeg the composer's output measures exactly
the planned length (the media suite asserts it). A missing or extra scene is at
least a second, far outside the tolerance.

**Why these two reasons.** Both already exist in the closed media vocabulary
and in the database's enum, and both say what is wrong with the video. A new
reason would need a migration and would tell the customer nothing more. The
cost: an `INVALID_MEDIA` row does not record whether the probe found the size
unusable or merely not the planned one. An operator can tell by measuring the
immutable bytes against the composition's frozen columns.

## Decision 3 — A verdict, not a defect

The composer can produce an off-plan video, so this is a verdict about the
bytes, unlike ADR-0080's refusals:

1. **The claim carries the plan.** `claimDeliverableValidation` derives it
   from the composition and the job under the chain's locks and returns it as
   `claim.plannedMedia`.
2. **The runner judges.** When the validator answers `VALID`, the runner
   compares the facts with the claim's plan. An off-plan video is finalized
   `INVALID_MEDIA` with the reason, and neither `finalizeValid` nor Transaction
   G is called. Within the plan, nothing changes.
3. **`finalizeValid` refuses an off-plan verdict.** It derives the plan again
   from its own locked read, not from the claim's copy, and throws the defect
   `VALID_FACTS_OFF_PLAN` for facts outside it, writing nothing. The runner
   never sends it one, so only a caller that skipped the comparison can reach
   it.
4. **Transaction G re-proves the stored facts.** After ADR-0080's gate and
   before the publication's kind is decided, it compares the `VALID` row's
   stored facts with the plan derived from its own locked read, and throws
   `VALID_FACTS_OFF_PLAN`, rolling back, when they differ. Both arms, initial
   and replacement. A replay is answered `ALREADY_PUBLISHED` before it, unjudged.
   Only a row altered by hand can fail it.
5. **Discovery mirrors it.** A `VALID` verdict awaiting publication is offered
   only while its stored facts are on plan, so a row Transaction G would refuse
   never takes a place in a bounded batch (ADR-0080 Decision 5). The tolerance
   is written in SQL as the same integer ceiling, and the database suite proves
   the two agree on both sides of the boundary at four rates. Such a row is
   left as ADR-0080's refusals are: its job `DELIVERABLE_VALIDATING`, its
   reservation `RESERVED`, until an operator acts.

## Decision 4 — What an off-plan verdict leaves

It is an ordinary terminal `INVALID_MEDIA` verdict (ADR-0051): terminal, never
re-validated, no event, no pointer move, no Unit consumed. The customer keeps
any video they already hold.

**The hold is not released yet.** The job stays `DELIVERABLE_VALIDATING` and an
initial generation's reservation stays `RESERVED`. ADR-0052 Decision 19 requires
an `INVALID_MEDIA` verdict to terminally settle and release it, identically to
`BLOCKED` and `INTEGRITY_MISMATCH`, and that terminal settlement is unbuilt for
every `INVALID_MEDIA` verdict, not only this one (`docs/decisions/TODO.md`).
This milestone adds one more way to reach that state; it does not widen the gap
in kind. It must close before validation is activated.

## Decision 5 — Dormant, no migration

Nothing in production constructs the validation runner or calls Transaction G.
No schema, enum or row changes: the reasons exist and the defect is a code.
Rolling back to DS-6a's build is safe: it publishes everything this build
publishes, and also off-plan videos, which this build's composer does not make.

---

## Consequences

- No video reaches a customer's workspace unless it measures its composition's
  frozen frame size exactly and its job's admitted length within one frame,
  besides carrying its version's disclosure and having its Clean Master
  recorded (ADR-0080).
- An off-plan deliverable is recorded `INVALID_MEDIA`, and its reservation stays
  `RESERVED` until the terminal settlement of ADR-0052 Decision 19 is built.
- The disclosure plan's six milestones are built. Activation is not part of
  it: paid Provider Activation, production Provider credentials, production
  paid AI calls, production scheduler activation and live Stripe charges remain
  BLOCKED. Nothing here touches them.
