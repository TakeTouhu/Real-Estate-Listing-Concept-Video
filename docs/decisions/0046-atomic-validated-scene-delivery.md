# ADR-0046 — Atomic validated Scene delivery (Transaction F)

- Status: Accepted (Phase 4C-3B-2H-3B-6A)
- Supersedes: nothing. Consumes ADR-0045 (durable media-validation lifecycle)
  and keeps ADR-0038 (managed-output integrity) exactly as it is.

## Context

ADR-0045 made a media verdict durable and deliberately meaningless: a `VALID`
row said the managed bytes were a usable video, and nothing acted on it. No
Scene became ready, no Job advanced, nothing was shown to a customer.

This phase gives `VALID` its one consequence — the customer-visible delivery of
a Scene — and gives it as a single atomic business fact. It gives it *only*
that consequence: `INVALID_MEDIA` and `INTEGRITY_MISMATCH` remain durable
terminal verdicts with no downstream action, no recovery attempt is admitted, no
provider is called, no quota moves, and nothing advances past `SCENES_READY`.

Production delivery is **not** active. Nothing constructs the runner, schedules
it, or calls it.

## Decision 1 — Delivery is one transaction, not three writes

Transaction F performs, in one short database transaction:

```text
SceneGenerationRequest   GENERATING -> DELIVERED   (+ deliveredAt)
GenerationScene          GENERATING|REVISING -> READY
GenerationScene.currentDeliveredRequestId = the delivered request
GenerationJob            GENERATING -> SCENES_READY, iff every Scene is READY
```

Splitting these re-creates the crash boundary the transaction exists to remove,
and the states left behind are not repairable afterwards because nothing records
which half was intended:

- A request marked `DELIVERED` whose Scene never reached `READY` is a Scene the
  customer has spent a regeneration right on and cannot see.
- A Scene marked `READY` pointing at a request the ledger says never delivered
  is a customer-visible video with no delivery in its history.

So the boundary offers exactly **one** operation, `deliverValidatedScene`, and
it owns the locks, the authority re-reads, every write and every event. There is
deliberately no `markRequestDelivered`, `markSceneReady` or `maybeMarkJobReady`.

A corollary that is easy to get wrong: inside an interactive transaction,
*returning* is committing. The two compare-and-set guards that run after the
first write therefore raise a defect rather than returning an outcome — a
should-never-happen at that point must roll the whole thing back, not commit
half of it.

## Decision 2 — `VALID` is the only media authority, and it is re-proved

Transaction F performs no S3 read and runs no `ffprobe`. The durable `VALID`
verdict established by ADR-0045 is the media authority, and a candidate sweep
offers nothing else. `PENDING`, `RUNNING`, `INVALID_MEDIA`, `INTEGRITY_MISMATCH`
and a missing record all mean "not eligible", and the gate is written as a
positive test for `VALID` rather than a list of statuses to exclude — a denylist
silently admits whatever status is added next.

`OUTPUT_VERIFIED` keeps its exact meaning and is not redefined. It remains the
attempt's byte-integrity terminal state; media validity is an orthogonal durable
fact that delivery additionally *requires*.

The listing is a hint, never permission. Between the sweep and the call the
verdict can be superseded, the Scene can move, or another worker can deliver, so
`deliverValidatedScene` re-reads and re-checks every condition under its own
locks. The candidate type carries identifiers and nothing else, so a caller
cannot mistake it for authority.

## Decision 3 — The verdict must be about the bytes being delivered

Before anything moves, the validation's frozen receipt is compared to the
attempt's verified digest and size. A verdict bound to different bytes is a
`RECEIPT_BINDING_CONFLICT` defect: never repaired, never re-validated, and never
delivered anyway. Repairing it would answer a different question from the one
the record claims to answer, and delivering past it would show a customer bytes
nothing inspected.

## Decision 4 — Latest-attempt authority is the ordinal, not a timestamp

A delayed verdict from a superseded attempt must not deliver after the request
moved on to a newer one. The comparison is against
`MAX("attemptOrdinal")` over the request's attempts.

`createdAt` is not used. Two attempts admitted in the same millisecond have no
order under a timestamp, and rows can be written with any `createdAt` at all;
the ordinal is the durable, unique, monotonic fact the schema already enforces.

## Decision 5 — The Job lock is taken first, and is what makes readiness safe

The lock order is fixed for every caller:

```text
GenerationJob → GenerationScene → SceneGenerationRequest → attempt → validation
```

A fixed order is what stops two concurrent deliveries deadlocking by approaching
the same rows from opposite ends. Taking the **Job** first is what makes the
readiness decision correct: two Scenes of one Job finishing at the same instant
must serialize on the Job row, so exactly one transaction can observe itself as
the last Scene. Without that lock both would count "one Scene still generating"
from the same snapshot and neither would advance the Job.

Readiness is counted as "no Scene of this Job is in a state other than `READY`",
not "no Scene is generating": a `PENDING`, `REVISING`, failed or cancelled Scene
is not a ready Scene.

## Decision 6 — `GENERATING -> DELIVERED` belongs exclusively to Transaction F

The generic request-transition API continues to refuse that edge as a reserved
transition. One edge, one owner: a second writer would be a second place where
the pointer, the Scene state and the delivery instant could disagree.

Symmetrically, Transaction F does **not** own `READY -> REVISING`. A
`USER_REGENERATION` delivery expects its Scene in `REVISING` and an `INITIAL`
delivery expects `GENERATING`; anything else is a `SCENE_STATE_CONFLICT` defect
rather than something to move into place.

## Decision 7 — The regeneration right is consumed by `deliveredAt`, not a counter

Entitlement stays derived: the number of used regenerations is the number of
`DELIVERED` `USER_REGENERATION` requests on the Scene. Transaction F introduces
no counter and no second source of truth. The pointer switches to the new
request and the superseded request row is left exactly as it is — `DELIVERED`,
with its own delivery instant — because it is history, not garbage.

A pointer to another Scene's request is unstorable: the composite foreign key
`(currentDeliveredRequestId, id) -> (id, generationSceneId)` rejects it at the
database. The remaining case, a pointer to a request of this Scene that never
delivered, is checked and reported as a defect.

## Decision 8 — Half-applied states fail closed and are never repaired

A replay of the exact same delivery is `ALREADY_APPLIED`: nothing is written
again, no version moves, no `deliveredAt` is rewritten, no event is appended.
Only the complete shape counts as applied — request `DELIVERED`, Scene `READY`,
pointer naming this request.

Anything in between is `PARTIAL_DELIVERY_STATE` and raises. Silently completing
a half-applied delivery would destroy the evidence of whatever produced it, and
the application believes it cannot produce one at all.

## Decision 9 — No schema change

None was needed, which is the point. `deliveredAt`, `currentDeliveredRequestId`,
its composite foreign key and `stateVersion` on all three aggregates already
existed. This phase adds no migration, no column, no second delivery status, no
duplicated media fact and no second pointer table; migration 12 remains the
newest.

## Decision 10 — Dormant, and structurally unable to reach the next phase

`ValidatedSceneDeliveryRunner` exists and is proven, and nothing in production
constructs it, schedules it or calls it. A `VALID` verdict does not deliver by
itself; turning that on is a separate reviewed decision with its own operational
questions.

The module names none of the vocabulary of what comes next — recovery,
submission, composition, the deliverable, the reservation, quota, settlement or
upscale — and a static test enforces that, so the boundary is a fact about the
code rather than a promise in a document.

## Consequences

- A `VALID` verdict now has exactly one possible consequence, and it is atomic.
- `INVALID_MEDIA` and `INTEGRITY_MISMATCH` still do nothing. Recovery admission
  is Phase 6B's decision, because it chooses a provider, a model, a pricing
  identity and a possible future paid call.
- Quota `CONSUME` still belongs to Transaction G at
  `DELIVERABLE_VALIDATING -> DELIVERABLE_READY`: a ready Scene is not a
  delivered video.
- `SCENES_READY -> COMPOSITION_PENDING` and everything past it remain unbuilt.
