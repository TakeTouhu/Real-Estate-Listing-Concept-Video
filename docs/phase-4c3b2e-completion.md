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
wrong. Cancellation stops at `RESERVED`: past there an attempt may already be
at a provider, and that decision cannot be read from the job's own state.

**Reservation.** `RESERVING → RESERVED`, `RESERVED ⇄ RECONCILIATION_HOLD`, and
either into `CONSUMED` or `RELEASED`, both terminal. The hold state exists
because submission certainty can be lost: while it is lost the platform must not
spend the customer's unit or give it back.

**Scene.** `PENDING → GENERATING → READY`, and `READY ⇄ REVISING` — a failed
revision returns the scene to `READY`, because the customer keeps the rendition
they already had. `CANCELLED` is reachable only from `PENDING`.

**Request.** `PENDING → GENERATING → DELIVERED`, with `FAILED_TERMINAL`, and
`CANCELLED` reachable only from `PENDING`. There is deliberately **no
`FAILED_RETRYABLE`** and no edge back to `PENDING`: a system recovery attempt does not restart the customer's request,
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
is an equivalence for orchestrated rows, enforced in both directions by two
database CHECKs:

    providerPredictionId != null  ⟺  submissionCertainty == ACCEPTED

Both directions matter. A reference without acceptance is a fabricated id; an
acceptance without a reference is an outcome that never established what the
provider took — uncertainty wearing the wrong label, and `SUBMISSION_UNKNOWN`
exists precisely for it. Legacy rows are exempt: they carry NULL certainty, and
some hold references recorded under the older contract.

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

`armProviderBoundary` returns
`ARMED | LOST | MISSING_PRICING_SNAPSHOT | PRICING_BINDING_INVALID`, and only
`ARMED` permits an outbound call. The pricing snapshot is loaded **with** the
attempt and **inside** the transaction: checking outside is a
time-of-check-to-time-of-use window in which the facts need never have been true
simultaneously, and checking only for existence would authorize this attempt
against another provider's price.

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

## Corrections applied after CTO review

Fifteen blocking defects. Each is stated as the failure it caused, not as the
change that fixed it.

**The active-request index could not see orchestrated attempts.** The Phase
4A-2a partial index tested `state`, the legacy column, which an orchestrated
attempt never advances — so a terminal orchestrated attempt still looked active
and the SYSTEM_RECOVERY row meant to replace it could not be inserted. The
frozen rule that *a retry uses a new attempt row* was unreachable in practice.
The index now carries one predicate with two branches, keyed on which
vocabulary the row speaks; the legacy branch is copied character for character,
because rewriting it would re-judge rows admitted under a contract that no
longer exists. Every test in that suite reuses **one request hash** — the
provider request facts really are the same, and perturbing the hash would have
hidden the defect rather than tested it.

**`INITIAL` uniqueness was not enforced at all.** Every initial row carries a
NULL ordinal, PostgreSQL treats NULLs as distinct, and the unconditional index
over `(scene, kind, ordinal)` therefore permitted any number of them.

**A failed regeneration destroyed the customer's entitlement.** The derivation
correctly said no right had been spent, while the same index kept the failed
row's ordinal occupied forever — so the replacement could not be stored and the
customer could never ask again. Three partial indexes replace the one: at most
one `INITIAL` per scene, at most one *delivered* request per entitlement
ordinal, and at most one *active* regeneration per scene. Failed and cancelled
requests stay in history and release the slot they never consumed.

**The ordinal was caller authority.** Nominating `1` or `2` is asserting how
much of the entitlement is already spent, which no caller knows.
`admitUserRegeneration` derives it inside its transaction from delivered
siblings; the active-regeneration index settles a concurrent race.

**Every repository took bare ids.** An id is not an authorization: any caller
holding one — from a log, a ticket, a URL — could read or move another tenant's
generation history. Every method now takes `organizationId` and resolves
ownership through the `VideoProject` boundary, in the same predicate as the CAS.
A cross-tenant id behaves exactly like a missing one; a distinguishable denial
would itself disclose that the row exists. `GenerationTransitionEvent` carries
an immutable `organizationId`, indexed, set from the scoped operation and never
read out of `safeMetadata`.

**Transaction B was two commits.** A crash between them left a reservation whose
job never moved, or a moved job with no hold behind it, and neither row could
say which. `reserve()` now creates the hold, moves the job and writes both
events in one commit — and **copies the unit counts from the job** rather than
accepting them, because a reservation covering fewer units than its job is an
under-charge nothing could later detect.

**Transaction C did not exist.** Tests created attempts with raw Prisma and
priced them afterwards — precisely the crash window the boundary was meant to
close, since an admitted attempt with no cost decision is refused forever.
`admit()` creates the attempt, its pricing snapshot and its first event
together, and resolves `videoProjectId` from the request chain rather than
trusting a caller.

**A WaveSpeed attempt could be priced with a fal contract.** The boundary
checked only that *a* snapshot existed. Attempts now carry `pricingContractKey`,
copied from the snapshot at admission, and both admission and the boundary
require provider, contract key and V2 model key to agree — returning
`PRICING_BINDING_INVALID` rather than throwing, because an unarmable attempt is
an outcome a worker must handle. The old fixture that paired the two could not
be admitted today; it is gone.

**Video units were reimplemented.** `requiredUnitsFor` carried its own
`Math.ceil(seconds / 30)` and turned 91 seconds into four units — a tier the
product does not sell. It now delegates to `videoUnitsForSeconds`, and the
counts are derived at the admission boundary rather than accepted, so a
90-second job holding one unit, a `NORMAL` job with high-quality units and a
`HIGH_QUALITY` job with none are all unconstructible. Database CHECKs state the
tiers exactly rather than as an inequality.

**Cancellation was decided from the wrong aggregate.** A job in `GENERATING`
may hold attempts in `SUBMITTING` or `RECONCILIATION_PENDING`, so cancellation
safety cannot be read from the job's own state. `GENERATING -> CANCELLED` is
removed from the job, scene and request machines; cancellation stops where no
provider can yet have been paid. A conditional workflow that proves no attempt
crossed the boundary is a composite decision over attempt rows, not a
transition, and is not authorized in this phase — so the tables fail closed.

**A scene could point at another scene's request.** `currentDeliveredRequestId`
had no foreign key, so it could name a nonexistent request or one belonging to a
different scene — which breaks recovery reconstruction and future winner
selection. A composite foreign key to `(id, generationSceneId)` makes both
impossible, and deletion stays `RESTRICT`.

**The certainty documentation contradicted the provider contract.** It claimed
an accepted submission whose response could not be parsed would be `ACCEPTED`
with no reference. A response that cannot establish a reference has not
established acceptance either; that outcome belongs on the uncertainty path.
The relationship is an equivalence for orchestrated rows, enforced in both
directions by the domain and by a database CHECK, with legacy rows exempt.

## Verification

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass |
| `pnpm test` | Pass — 76 files, 1,967 tests (158 orchestration) |
| `pnpm build` | Pass |
| `pnpm test:db` | Pass — 14 files, 317 tests (98 new) |
| Migration on an empty database | Pass |
| Migration with legacy rows present | Pass — 6 tests |
| Migration on `revt_empty` | Pass |
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

## Mutation ledger — 48/49 killed

Forty-nine mutations: the first round's set, re-run, plus thirty aimed at the
correction round. **Every one targets an executed artefact** — the migration SQL
that builds the database, or the TypeScript that runs. A mutation editing only
`schema.prisma` is inert, because the database is built by applying migrations;
that error was made once in the first round and is not repeated.

| ID | Mutation | Detected by |
| --- | --- | --- |
| M1 | CAS drops the state predicate | 7 db tests |
| M2 | CAS drops the version predicate | 4 db tests |
| M4 | `SUBMITTING → QUEUED` allowed | 1 unit test |
| M5 | `RECONCILIATION_PENDING → QUEUED` allowed | 1 unit test |
| M6 | `FAILED_RETRYABLE` revives the row | 3 unit tests |
| M7 | provider reference without ACCEPTED | 1 unit test |
| M8 | regeneration counted at request creation | 5 unit tests |
| M9 | recovery counted as user regeneration | 2 unit tests |
| M10 | third user regeneration admitted | 2 unit tests |
| M11 | transition event insert removed | 5 db tests |
| M14 | prompt key allowlisted | 2 unit tests |
| M15 | forbidden keys dropped silently | 14 unit tests |
| M16 | attempt→request FK becomes cascade | 3 db tests |
| M17 | regeneration ordinal CHECK removed | 3 db tests |
| M18 | provider-reference CHECK removed | 4 db tests |
| M19 | reservation unit CHECK removed | 4 db tests |
| M21 | reconciliation-metadata CHECK removed | 4 db tests |
| M22 | billing cycle taken from completion | 4 db tests |
| M23 | delivery no longer timestamped | 1 db test |
| N1 | active index reverts to legacy-only predicate | 7 db tests |
| N2 | orchestration active set includes terminal states | 11 db tests |
| N3 | INITIAL partial unique index removed | 3 db tests |
| N4 | failed regeneration ordinal permanently unique again | 3 db tests |
| N5 | active user-regeneration uniqueness removed | 1 db test |
| N6 | `organizationId` dropped from the job CAS | 4 db tests |
| N7 | tenant predicate dropped from the boundary CAS | **SURVIVED** |
| N8 | tenant predicate dropped from attempt reads | 4 db tests |
| N9 | event reads stop filtering by organization | 4 db tests |
| N10 | Transaction B split into two commits | 4 db tests |
| N11 | Transaction C split into two commits | 36 db tests |
| N12 | pricing provider-binding check removed | 6 db tests |
| N13 | pricing contract-key binding check removed | 4 db tests |
| N14 | pricing model-key binding check removed | 4 db tests |
| N15 | boundary stops re-checking the binding | 5 db tests |
| N16 | 90-second product ceiling removed | 1 db test |
| N17 | unit-tier CHECK becomes an inequality | 4 db tests |
| N18 | NORMAL/HQ derivation CHECK removed | 5 db tests |
| N19 | admission stops deriving units | 99 db tests |
| N20 | `requiredUnitsFor` reimplements ceil | 7 unit tests |
| N21 | `GENERATING → CANCELLED` re-enabled (job) | 2 unit tests |
| N22 | `GENERATING → CANCELLED` re-enabled (request) | 2 unit tests |
| N23 | `GENERATING → CANCELLED` re-enabled (scene) | 2 unit tests |
| N24 | same-scene delivered-request FK removed | 6 db tests |
| N25 | ACCEPTED without a reference, at the database | 4 db tests |
| N26 | ACCEPTED without a reference, in the domain | 1 unit test |
| N27 | contract key taken from the caller | 25 db tests |
| N28 | event organization read from metadata | 4 db tests |
| N29 | admission stops requiring V2 identity | typecheck |
| N30 | reservation copies caller units | 7 db tests |

### The five that survived a first run

Four were real test gaps and are now closed. **M23** — the entitlement derives
from `state`, so removing the `deliveredAt` write broke nothing observable while
silently emptying the column that records *when* a right was spent. **N5** — the
repository also checks for an active sibling inside its transaction, which is
what a sequential caller hits, so the index had no test of its own; one now
bypasses the repository entirely. **N16** — the earlier test paired 91 seconds
with four units, so the *tier* constraint rejected it and the ceiling was never
exercised; the new case uses three units, which only the ceiling can refuse.
**N28** — `billingCycleKey` was absent from test metadata, so the mutation's
fallback yielded the right organization; a test now puts a plausible value there.

### N7 survives, and is reported rather than papered over

`armProviderBoundary` loads the attempt with a tenant-scoped `findFirst`
**inside its transaction** and returns `LOST` when it finds nothing. The tenant
predicate in the CAS `where` is therefore a second, redundant copy of a check
that has already decided the outcome — removing it changes no behaviour any test
can observe, and **N8**, which removes the scoped read itself, dies immediately.

The requirement that tenant scope share the CAS's transactional decision is met
by that read. The redundant predicate is kept as defence in depth: it costs one
join and would matter if the load were ever refactored out of the transaction.
Manufacturing a test for a mutation that corresponds to no reachable failure
would be evidence about nothing, which is the same error M16 taught in the first
round.

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
