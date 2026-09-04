# Phase 4C-3B-2E — Completion report

Generation orchestration and audit state. Base: `743ad9cef2165578dfbb676fe73cc10452295ae3`.

Persistence and pure domain only. No provider call, no polling, no reconciliation
worker, no output ingestion, no composition, no entitlement ledger, no payment,
and no change to what the paid gate permits.

## The accounting rule this phase exists to make structural

> A customer video unit is not a provider attempt.

Before this phase there was one row for both. One entitlement can produce an
initial generation, up to two user regenerations, and any number of system
recovery attempts, so "how many times did we pay for this scene, and how many of
those were the customer's choice?" had no answer that survived the fact.

Six tables and a certainty axis separate them:

| Concept | Table | Answers |
| --- | --- | --- |
| `GenerationJob` | `generation_jobs` | one customer video lifecycle |
| `GenerationReservation` | `generation_reservations` | one entitlement hold |
| `GenerationScene` | `generation_scenes` | one logical scene |
| `SceneGenerationRequest` | `scene_generation_requests` | one customer-visible rendition request |
| `SceneGeneration` *(evolved)* | `scene_generations` | exactly one provider invocation |
| `GenerationPricingSnapshot` | `generation_pricing_snapshots` | what one attempt was expected to cost |
| `FxRateSnapshot` | `fx_rate_snapshots` | the audited rate a cost was converted through |
| `GenerationTransitionEvent` | `generation_transition_events` | append-only machine history |

`SceneGeneration` was **evolved, not replaced**. The row already carried the
immutable request snapshot, the request hash and the provider identity; this
phase adds the orchestration linkage and the certainty axis beside them.

## State machines

**Job.** `CREATED → RESERVING → RESERVED → GENERATING → SCENES_READY →
COMPOSITION_PENDING → COMPOSING → DELIVERABLE_VALIDATING → DELIVERABLE_READY`,
then `DELIVERABLE_READY → REVISING → GENERATING` for post-delivery
regeneration. `DELIVERABLE_READY` is not terminal and is not failable: a
delivered video does not become a failed one because a later revision went
wrong. Cancellation stops at `COMPOSITION_PENDING` — past there the platform is
spending its own compute on work already paid for.

**Reservation.** `RESERVING → RESERVED`, `RESERVED ⇄ RECONCILIATION_HOLD`, and
either into `CONSUMED` or `RELEASED`, both terminal. The hold state exists
because submission certainty can be lost: while it is lost the platform must not
spend the customer's unit or give it back.

**Scene.** `PENDING → GENERATING → READY`, and `READY ⇄ REVISING` — a failed
revision returns the scene to `READY`, because the customer keeps the rendition
they already had.

**Request.** `PENDING → GENERATING → DELIVERED`, with `FAILED_TERMINAL` and
`CANCELLED`. There is deliberately **no `FAILED_RETRYABLE`** and no edge back to
`PENDING`: a system recovery attempt does not restart the customer's request,
which stays `GENERATING` while the platform tries again underneath it.

**Attempt.** `QUEUED → SUBMITTING → {PROCESSING | RECONCILIATION_PENDING |
FAILED_RETRYABLE | FAILED_TERMINAL}`, then `PROCESSING → PROVIDER_SUCCEEDED →
OUTPUT_INGESTING → OUTPUT_VERIFIED`.

Three absences define it, and each is a duplicate charge if permitted:

- **`SUBMITTING` has no edge to `QUEUED`.** An attempt that entered the boundary
  may have reached the provider before the process died.
- **`RECONCILIATION_PENDING` has none either** — that is precisely the case
  where a second POST is most likely to be a duplicate charge.
- **`FAILED_RETRYABLE` is terminal for the row.** It means the parent *request*
  may open another attempt, not that this attempt revives. The legacy machine
  allows `FAILED_RETRYABLE → QUEUED`; this one does not, and the legacy machine
  is untouched for legacy rows.

A test asserts over the whole vocabulary that exactly one state can reach
`SUBMITTING`, so adding a state cannot quietly add a second entry point.

## Certainty is not execution state

`PRE_SUBMISSION | ACCEPTED | DEFINITIVELY_REJECTED | SUBMISSION_UNKNOWN`, stored
in its own column, mirroring `ProviderSubmissionOutcome` exactly. The hard rule
is stated in the only direction that is true, and enforced by a database CHECK:

    providerPredictionId != null  ⟹  submissionCertainty == ACCEPTED

The converse is false. An accepted submission whose response could not be parsed
has no reference to record, and inventing one so the column looks populated
would put an unusable id into a paid attempt's permanent record.

`SUBMISSION_UNKNOWN` freezes `reconciliationStartedAt` and
`reconciliationDeadlineAt` onto the row. The 24-hour window is a default in one
place; the deadline is snapshotted, so changing the default later cannot move a
deadline already written.

## The provider boundary

    attempt persisted → pricing snapshot persisted
      → transaction { verify snapshot; CAS QUEUED→SUBMITTING; +1 version;
                      set submissionBoundaryEnteredAt; append event }
      → commit  ← this is the authorization
      → provider call

`armProviderBoundary` returns `ARMED | LOST | MISSING_PRICING_SNAPSHOT`, and
only `ARMED` permits an outbound call. The pricing snapshot is checked **inside**
the transaction rather than before it: checking outside is a
time-of-check-to-time-of-use window in which the two facts need never have been
true simultaneously.

`LOST` carries no attempt at all, so there is nothing for a careless caller to
submit. It is a discriminated union rather than a boolean because
`if (!ok) retry()` is the natural wrong handler.

## Compare-and-set

Every mutation names the state and version it believes it is replacing:

```sql
UPDATE ... SET state = $next, state_version = state_version + 1
 WHERE id = $id AND state = $expected AND state_version = $expectedVersion
```

Implemented as Prisma `updateMany` — `update` requires a unique selector and
cannot carry the predicates that make it a CAS. Zero rows updated is `LOST`.

There is **no open write** anywhere in the repository layer: no
`update(id, fields)`, no `setState`. The domain decides which transitions are
legal; the database decides which one won. Both are required — legality without
CAS loses races, CAS without legality writes nonsense atomically.

## Transition history

Append-only, and structurally so: `GenerationTransitionEventRepository` exposes
`listForAggregate` and `listForCorrelation` and nothing else. A test asserts the
interface has exactly those two keys, because the guarantee is worth exactly as
much as the narrowest method on it.

State change and event commit in one transaction. Sequence is `MAX + 1` per
aggregate under a unique index — two writers reading the same maximum means one
of them fails, which is correct: they were competing for the same CAS anyway.

**Metadata is an allowlist**, not a denylist. Machine history is the most widely
read table during an incident — pasted into tickets, exported to whoever is
debugging — so a prompt landing there travels further than the generation row
ever would. An unknown key is dropped; a *forbidden* key throws, because
dropping it silently would hide a bug at its source. The exception names the
offending keys and never their values.

A surviving mutation improved this: allowlisting `requestCompiledPrompt` changed
nothing observable, because the forbidden check fires first — so the allowlist
had no test of its own. The dangerous version is the key nobody thought to
forbid. The allowlist is now asserted to contain nothing matching
`/prompt|secret|token|credential|password|authorization|url|body|payload|response/i`,
and to be disjoint from the forbidden list.

## Entitlement, derived rather than counted

`usedUserRegenerationCount` counts `USER_REGENERATION` requests in state
`DELIVERED`. There is no stored counter, deliberately: one incremented at
request time drifts the first time a provider fails — the customer asked once,
the platform failed twice, and afterwards a counter cannot tell those apart.

- `INITIAL` never counts.
- `PENDING`, `GENERATING`, `FAILED_TERMINAL`, `CANCELLED` never count.
- `SYSTEM_RECOVERY` is counted on a separate axis over attempt kinds.

The ceiling is enforced by the database, not by policy: a CHECK constrains
`userRegenerationOrdinal` to `NULL` for `INITIAL` and to `1` or `2` for
`USER_REGENERATION`, and a unique index on `(scene, kind, ordinal)` caps a scene
at one initial request and two regenerations, permanently.

**High-quality units sit inside the total.** 60 seconds at high quality is 2
total and 2 high-quality — never 2 + 2. A CHECK requires
`highQualityUnits <= totalVideoUnits`, so additive arithmetic cannot be stored.

**Billing cycle is frozen at reservation.** A job reserved on 30 September and
delivered on 1 October consumes September: the allowance was committed when the
platform began spending on the customer's behalf. A test drives a reservation
through `RESERVED → RECONCILIATION_HOLD → RESERVED → CONSUMED` and asserts the
cycle key never moves.

## Pricing snapshot persistence

One per attempt, `UNIQUE` on `sceneGenerationId`, taking the domain's
`PricingSnapshot` value rather than loose fields. **No pricing arithmetic exists
in the repository layer** — a second implementation is always the one that
drifts. Monetary values are `BIGINT`; no floating-point money column exists.

A test asserts the stored row does not move when the in-memory catalog would
price the same request differently, and that the integers round-trip exactly
(400,000 and 520,000 micro-USD for a 5-second H3 Max attempt at the normal
buffer).

`FxRateSnapshot` is `RESTRICT` from pricing snapshots, so a rate that priced a
paid attempt cannot be deleted out from under it, and a CHECK requires a
strictly positive fraction — the same rule the pricing domain applies, repeated
here because this table outlives any single code path.

## Deletion and retention

Every link above a paid attempt is `RESTRICT`: project → job → scene → request →
attempt → pricing snapshot. A test deletes at each level and asserts `P2003` at
all five.

`sourceStoryboardSceneId` and `sourceAssetId` carry **no foreign key**, matching
the existing `SceneGeneration` reasoning (ADR-0016): recomposition deletes and
recreates storyboard scenes, and retention removes assets. A cascade from either
would erase paid history on an ordinary user action; a restrict would block
recomposition. The recovery fixture proves the point by naming a storyboard
scene that does not exist.

## Legacy migration — nothing was fabricated

**No existing row was updated.** Every column added to `scene_generations` is
nullable and stays NULL for rows admitted before this phase.

That is a refusal, not a convenience. A legacy row sitting in `SUBMITTING` might
have been accepted by the provider or might never have been sent, and there is
no way to find out now. Backfilling `submissionCertainty` would make the data
tidy and would be a fabricated claim about money.

| Legacy fact | Decision |
| --- | --- |
| `state` vocabulary | Kept. `SUCCEEDED` is **not** relabelled `PROVIDER_SUCCEEDED`; `SUBMISSION_UNKNOWN` is **not** split into a certainty plus `RECONCILIATION_PENDING`. Both rewrites would be unverifiable claims. |
| `submissionCertainty` | NULL. Exempted from the provider-reference CHECK, so a legacy prediction id does not invalidate history. |
| `generationSceneRequestId`, `attemptOrdinal`, `attemptKind` | NULL. No parent request is invented. |
| reconciliation timestamps | NULL. No deadline is invented. |
| request snapshots | Untouched. |

A separate `orchestrationState` column carries the new vocabulary rather than
rewriting `state`, and an all-or-none CHECK means a row is either fully legacy
or fully orchestrated — never half of each, which is the state in which every
later query has to guess which vocabulary applies.

The attempt repository **fails closed** on a legacy row: projecting one as an
orchestration attempt throws rather than inventing a kind and a certainty.

The Phase 4A-2a partial unique index on active requests is untouched.

## Verification

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass |
| `pnpm test` | Pass — 76 files, 1,950 tests (141 new orchestration) |
| `pnpm build` | Pass |
| `pnpm test:db` | Pass — 12 files, 262 tests (43 new) |
| Migration on an empty database | Pass |
| Migration with legacy rows present | Pass — 6 tests |
| Prisma drift check | `No difference detected.` |

### Concurrency test

Two workers call `armProviderBoundary` on the same attempt concurrently.
Exactly one returns `ARMED`, one returns `LOST`, exactly one transition event
exists, and `stateVersion` is 1. Run concurrently rather than sequentially,
because a sequential test passes against an implementation with no CAS at all.

### Recovery reconstruction test

A fixture is written through one Prisma client, which is then **disconnected**,
and read through a second cold client — so nothing in-process can satisfy an
assertion. It reconstructs job identity, billing cycle, reserved units, logical
scene, logical request, attempt kind and ordinal, provider and model, request
hash, contract fingerprint, estimated cost, submission certainty, absence of a
provider reference, reconciliation deadline, and the last transition sequence.
It also asserts that re-arming the uncertain attempt returns `LOST`.

## Mutation ledger — 23/23 killed

| ID | Mutation | Detected by |
| --- | --- | --- |
| M1 | CAS drops the state predicate | 2 db tests |
| M2 | CAS drops the version predicate | 1 db test |
| M3 | pricing snapshot requirement removed | 1 db test |
| M4 | `SUBMITTING → QUEUED` allowed | 1 unit test |
| M5 | `RECONCILIATION_PENDING → QUEUED` allowed | 1 unit test |
| M6 | `FAILED_RETRYABLE` revives the row | 3 unit tests |
| M7 | provider reference without ACCEPTED | 1 unit test |
| M8 | regeneration counted at request creation | 5 unit tests |
| M9 | recovery counted as user regeneration | 2 unit tests |
| M10 | third user regeneration admitted | 2 unit tests |
| M11 | transition event insert removed | 3 db tests |
| M12 | state change and event no longer atomic | 8 db tests |
| M13 | high-quality units not reserved | 2 unit tests |
| M14 | prompt key allowlisted | 2 unit tests |
| M15 | forbidden keys dropped silently | 14 unit tests |
| M16 | attempt→request FK becomes cascade | 1 db test |
| M17 | regeneration ordinal CHECK removed | 5 db tests |
| M18 | provider-reference CHECK removed | 1 db test |
| M19 | high-quality-within-total CHECK removed | 1 db test |
| M20 | orchestration all-or-none CHECK removed | 1 db test |
| M21 | reconciliation-metadata CHECK removed | 1 db test |
| M22 | billing cycle taken from completion | 1 db test |
| M23 | delivery no longer timestamped | 1 db test |

Two survived on their first run, and both exposed real gaps.

**M14** survived because the forbidden-key check fires before the allowlist is
consulted, so the allowlist had no test at all. Closed by asserting the
allowlist's own contents.

**M16** survived because it was **mis-aimed by me**: it edited `schema.prisma`,
but the database is built by applying migration files, so a schema-only edit
never reached PostgreSQL and the mutation proved nothing. Re-aimed at the
migration's `ALTER TABLE`, it dies immediately. Recorded rather than quietly
fixed, because a mutation that cannot reach the thing it targets is worthless
evidence — the same lesson as M11 in the fal round.

**M23** survived because the entitlement is derived from `state`, so removing the
`deliveredAt` write broke nothing observable while silently emptying the column
that records *when* a customer's right was spent. Closed with a direct
assertion.

## Paid gate — still blocked

`VIDEO_PROVIDER` remains `z.enum(["fake", "wavespeed"])`. No `FAL_API_KEY` or
`FAL_KEY`, no fal factory branch, no Veo provider or execution path, no payment
gateway, no Stripe, no pricing-driven live submission gate, no automatic charge,
no add-on purchase, no reconciliation worker, and no real paid provider call.

**Nothing calls this orchestration.** No API route, service or worker constructs
these repositories. The existing WaveSpeed runtime is untouched and is not
attached to reservations or pricing — the foundation is dormant with respect to
live generation, by design.

## Known limitations and open items

- **Nothing consumes the orchestration yet.** It is enforced by the compiler,
  its tests and the database, and by no runtime path.
- **`GenerationDeliverableVersion` is not implemented.** `GenerationJob`
  carries a nullable `currentDeliverableVersionId` with no foreign key, which is
  honest about the table not existing yet.
- **Transaction F (scene delivered) is not implemented as a single primitive.**
  Its parts exist — request `GENERATING → DELIVERED` under CAS, and
  `GenerationScene.currentDeliveredRequestId` — but composing them into one
  atomic winner-selection belongs with output ingestion, which is deferred. The
  constraints for it are in place.
- **`GenerationScene.currentDeliveredRequestId` carries no foreign key**, to
  avoid a circular required reference that would make insertion order
  load-bearing.
- **The job state machine's cancellation and failure edges are the one place I
  extended beyond the brief's explicit list.** §9 froze the forward path;
  which non-terminal states may reach `CANCELLED` and `FAILED_TERMINAL` was not
  specified. I chose the narrowest reading — no cancellation once composition
  has begun, and no failure edge out of `DELIVERABLE_READY` — and flag it here
  rather than presenting it as given.
