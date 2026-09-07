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

## Corrections applied after the final admission review

One theme runs through all of them: **attempt admission must not believe
anything a persisted row already knows.** Every fact a caller could supply was
a fact that could disagree with the scene it claimed to render.

**The request hash was caller authority.** `AdmitGenerationAttemptInput`
carried a `requestHash`, and admission checked only that it began with
`sha256:v2:`. A caller offering its own V2-prefixed digest for identical work
walked straight past the `(videoProjectId, requestHash)` active-request index —
the one protection that stops the platform paying twice for the same
generation. The field is gone. Admission now assembles `GenerationRequestFacts`
from the scene and the job and calls the existing
`computeGenerationRequestHash`; nothing in this phase reimplements the tuple. A
test reloads the stored row through the pre-existing `SceneGeneration`
repository, rebuilds the facts with the pre-existing
`generationRequestFactsFrom`, recomputes, and requires the two to be equal — so
a row that could not re-derive its own identity fails the build.

**Asset, prompt, duration, camera motion, aspect ratio and target resolution
were caller authority too.** All six now come from the `GenerationScene` and
the `GenerationJob` inside the transaction. A scene with no compiled prompt is
refused as `SCENE_FACTS_INCOMPLETE` rather than stored as a row that can never
be executed or re-derived.

**A job had no aspect ratio and did not snapshot the project.** The job now
carries `targetAspectRatio` beside `targetOutputResolution`, both copied from
the `VideoProject` at admission and never read from it again — project settings
are mutable, and an attempt admitted three days later must render what the
customer started. A `CHECK` repeats the project's closed `('720p','1080p')`
vocabulary rather than opening a second one that could drift; the repository
refuses a project whose stored value is outside it rather than widening the
product vocabulary in a second place.

**Attempt kind was caller authority, and nothing stopped two of them.** The
kind is now derived — the first attempt is `PRIMARY`, every later one is
`SYSTEM_RECOVERY` — and two partial unique indexes hold the line underneath the
derivation: one `PRIMARY` per request, and one *live* attempt per request. The
second is distinct from the identity index and both are needed: identity
protects the project from submitting the same work twice, and this protects one
request from parallel provider work. Admission returns `ATTEMPT_ALREADY_ACTIVE`
rather than filing a second paid attempt beside a live one, and a finished
attempt releases the slot so real recovery still works. Both indexes have tests
that bypass the repository entirely, because the rule has to survive a caller
that never met it.

**The first attempt did not start its request.** `PRIMARY` admission now moves
the request `PENDING → GENERATING` in the same commit. Split apart, the database
claimed the customer's request had not begun while a provider attempt for it
already existed. A recovery attempt deliberately does *not* move it again: the
request has been generating all along.

**The pricing binding did not cover what it priced.** Provider, contract key
and model key agreeing is not enough — a snapshot priced for five seconds
attached to a fifteen-second scene understates the cost by two thirds with
every other field internally consistent. The binding now also requires the
snapshot's `requestedSeconds` to equal the scene's duration, its native tier to
equal the attempt's generation resolution, and its risk profile to equal the one
the job's quality tier plans against — a `HIGH_QUALITY` job priced at the 30%
`NORMAL_AI` buffer under-plans every attempt by twenty points, invisibly,
because both halves look right on their own. `riskProfileKeyForQualityTier` is
the single mapping between the two vocabularies. Execution modes fail closed:
the product sells no audio-enabled contract, so a snapshot describing one is
refused (`GENERATION_MODE_UNSUPPORTED`, `AUDIO_MODE_UNSUPPORTED`) rather than
priced. Every comparison is opaque equality — nothing parses `768P` or `1080p`,
so a renamed tier becomes a mismatch rather than a silent reinterpretation.

**`providerModelId` is preserved without a forbidden dependency.** It is
persisted and hashed as an opaque string. `@app/domain` does not import
`@app/video-providers` to validate a catalog value; the model *key* is bound to
the pricing contract instead, which is the fact that decides money.

**Atomic primitives were bypassable.** The generic `transition` methods could
reproduce, one CAS at a time, exactly what an atomic transaction exists to make
indivisible — a `RESERVED` job with no reservation, or a `DELIVERED` request
with no verified output. Four edges are now refused with
`TRANSITION_RESERVED`: `RESERVING → RESERVED` (Transaction B),
`PENDING → GENERATING` (attempt admission), and `GENERATING → DELIVERED` plus
both edges into `CONSUMED` (Transactions F and G, deferred). The pure state
machines still contain these edges, because they are legal transitions; what is
missing is a *persistence route* for them, and the refusal names that.

**Transaction B wrote history that had not happened.** The reservation was
inserted directly as `RESERVED` while the event stream claimed a
`RESERVING → RESERVED` transition. The final row was right and the history was
fiction — the "event without an aggregate change" this phase forbids. It is now
created `RESERVING` and genuinely moved inside the same commit, which the tests
check by asserting `stateVersion` is 1 rather than 0.

**A regeneration race leaked a database error.** The losing transaction's
unique violation is a business outcome — the customer asked for something
already in flight — and is translated to `REGENERATION_ALREADY_ACTIVE`. Only
that exact index is translated: reporting every `P2002` that way would turn an
unrelated collision into a cheerful "someone else is already doing this", which
is the kind of mistranslation that hides a real defect for months. Both halves
have tests.

**FX persistence was incomplete.** A snapshot naming an FX id nobody could
produce is an audit record that cannot be re-derived. The rate is now required
whenever the snapshot names one, validated through the pricing domain's own
`validateFxSnapshot`, and written inside the admission transaction. A row that
already exists is compared field by field; a same-id rate with different content
is `FX_SNAPSHOT_CONFLICT`, not a cache hit. Nothing updates an existing rate.

## Corrections applied after the final concurrency review

Three defects, one shape: **a decision read before it was serialized.** Each
site read some state, concluded it could proceed, and only then wrote — so two
callers could both read the same pre-write state and both conclude the same
thing. The unique indexes did hold, every time. What did not hold was the
*contract*: the loser learned the truth as a raw `P2002` its caller has no case
for, or, in the job's case, learned nothing at all and stored a stale fact.

### Transaction C now serializes on the parent `SceneGenerationRequest`

```text
begin
→ lock the tenant-scoped request row          (SELECT … FOR UPDATE OF r)
→ re-read request / scene / job authoritatively
→ inspect sibling attempts
→ derive kind, ordinal and canonical requestHash
→ validate pricing and FX
→ create attempt + pricing snapshot
→ PENDING → GENERATING when PRIMARY
→ append events
→ commit
```

The lock is taken **before** the first read, not after. Tenancy is proved in
the same statement by joining scene → job → project, so a cross-tenant id locks
nothing and returns no row — indistinguishable from a missing one, as
everywhere else. `FOR UPDATE OF r` names the alias so only the request row is
locked; the joins exist to prove ownership, not to lock the chain.

The second caller now waits, re-reads, sees the attempt the first one
committed, and returns `ATTEMPT_ALREADY_ACTIVE`. Both partial unique indexes
are untouched: this makes the contract correct, and they remain the database's
own defence against a writer that never took the lock.

### User regeneration serializes on the parent `GenerationScene`, and the error
classifier is gone

The classifier asked whether a `P2002` came from
`scene_generation_requests_active_key`. Live PostgreSQL was consulted rather
than memory, and it settles the question twice over:

| Violation | class | code | `meta.modelName` | `meta.target` |
| --- | --- | --- | --- | --- |
| `…_active_key` | `PrismaClientKnownRequestError` | `P2002` | `SceneGenerationRequest` | `["generationSceneId"]` |
| `…_initial_key` | `PrismaClientKnownRequestError` | `P2002` | `SceneGenerationRequest` | `["generationSceneId"]` |
| primary key | `PrismaClientKnownRequestError` | `P2002` | `SceneGenerationRequest` | `["id"]` |

Prisma reports the **covered fields, never the index name** — the same lesson
`generation-persistence.db.test.ts` already pinned for
`scene_generations_active_request_key`, which is why the previous classifier
could never fire at all. And the two partial indexes cover the *same column*,
so their violations are byte-identical: a classifier narrow enough to be honest
is not constructible, and a broad one would announce "a regeneration is already
in flight" for a duplicate INITIAL request.

So the ordering is fixed instead of the error interpreted. The scene row is
locked first, the sibling set is read after it, and the loser returns
`REGENERATION_ALREADY_ACTIVE` from the ordinary path. The catch arm is
therefore unreachable by the production method and was **removed** rather than
retained as unverified defence. An unrelated collision now reaches the caller
as the `P2002` it is, which a test asserts directly.

### `GenerationJob.create` snapshots the project inside its own transaction

The project's `targetOutputResolution` and `aspectRatio` were read *before* the
transaction opened, leaving the ordering:

```text
read project settings A
→ another transaction commits settings B
→ create immutable job carrying A, durably, after B
```

Nothing downstream could ever notice, because the job looks internally
consistent. The read moved inside the transaction and takes `SELECT … FOR
SHARE` on the project row. Shared rather than exclusive because two jobs
admitted against one project are not in conflict, but a concurrent settings
*update* is: it blocks until the job commits. Either order is now a real
serialization — A wins and the job snapshots A, or B wins and the job snapshots
B — and the forbidden third case cannot occur.

`targetOutputResolution` and `targetAspectRatio` remain immutable job facts,
and Transaction C still never re-reads the project.

### How these are tested

Not by launching two calls and hoping. Measured directly, they do not overlap:
eight simultaneous admissions and two independent client pools each completed
strictly one after another, so a naive race test passes against an
implementation with no locking at all and proves nothing.

The overlap is therefore **constructed**. A second client opens a transaction,
takes the same lock the repository takes, and holds it. The repository call is
started and asserted to be *still blocked* after a real interval. The holder
then mutates the row the repository is about to decide from, and commits. An
implementation that read before locking is now working from a state that no
longer exists — which is the defect, made deterministic.

Each of the eight mutations in the Q-series removes or reorders exactly one of
these serialization points, and all eight die. **Q8** is the one worth naming:
it keeps the project read inside the transaction but drops the lock, and still
fails — so the tests measure the serialization, not merely the read's location.

## Verification

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass |
| `pnpm test` | Pass — 76 files, 1,967 tests (158 orchestration) |
| `pnpm build` | Pass |
| `pnpm test:db` | Pass — 16 files, 358 tests |
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

## Mutation ledger — 81/82 killed

Eighty-two mutations: every earlier round re-run against this head, plus eight
aimed at the concurrency corrections. **Every one targets an executed
artefact** — the migration SQL that builds the database, or the TypeScript that
runs. A mutation editing only `schema.prisma` is inert, because the database is
built by applying migrations; that error was made once in the first round and
is not repeated.

Entries with a `b` suffix are re-aimed replacements for mutations that did not
measure what they claimed to. Both the original miss and the correction are
described below rather than quietly dropped. Two mutations from the previous
round — `P20` and `P21` — no longer exist: they targeted the error classifier,
and the classifier is gone. `Q5` and `Q6` replace them by *reinstating* the two
classifier shapes and proving the suite refuses both.

| ID | Mutation | Result | Detected by |
| --- | --- | --- | --- |
| M1 | QUEUED -> SUBMITTING CAS drops the state predicate | KILLED | 7 failing db tests |
| M2 | the stateVersion check is removed from the provider boundary | KILLED | 4 failing db tests |
| M4 | SUBMITTING -> QUEUED becomes allowed | KILLED | 3 failing unit tests |
| M5 | RECONCILIATION_PENDING -> QUEUED becomes allowed | KILLED | 3 failing unit tests |
| M6 | FAILED_RETRYABLE revives the same attempt row | KILLED | 5 failing unit tests |
| M7 | a provider reference is accepted without ACCEPTED certainty | KILLED | 3 failing unit tests |
| M8 | user regeneration is counted at request creation instead of delivery | KILLED | 7 failing unit tests |
| M9 | SYSTEM_RECOVERY attempts count as user regenerations | KILLED | 4 failing unit tests |
| M10 | a third user regeneration becomes admissible | KILLED | 4 failing unit tests |
| M11 | the transition event insert is removed from the provider boundary | KILLED | 5 failing db tests |
| M14 | the prompt allowlist admits a compiled prompt | KILLED | 4 failing unit tests |
| M15 | forbidden metadata keys are dropped silently instead of refused | KILLED | 16 failing unit tests |
| M16 | the attempt-to-request foreign key becomes a cascade | KILLED | 3 failing db tests |
| M17 | the regeneration ordinal CHECK is removed | KILLED | 3 failing db tests |
| M18 | the provider-reference CHECK is removed | KILLED | 4 failing db tests |
| M19 | the high-quality-within-total reservation CHECK is removed | KILLED | 4 failing db tests |
| M21 | the reconciliation-metadata CHECK is removed | KILLED | 4 failing db tests |
| M22b | the release of a hold is no longer timestamped | KILLED | 4 failing db tests |
| M23b | the failure of a request is no longer timestamped | KILLED | 3 failing db tests |
| N1 | the active-request index reverts to the legacy-only predicate | KILLED | 7 failing db tests |
| N2 | the orchestration active set wrongly includes terminal states | KILLED | 17 failing db tests |
| N3 | the INITIAL partial unique index is removed | KILLED | 4 failing db tests |
| N4 | a failed regeneration ordinal becomes permanently unique again | KILLED | 3 failing db tests |
| N5 | the active user-regeneration uniqueness is removed | KILLED | 4 failing db tests |
| N6 | organizationId is dropped from the job transition CAS | KILLED | 4 failing db tests |
| N7 | the tenant predicate is dropped from the provider boundary CAS | **SURVIVED** | 0 failing tests |
| N8 | the tenant predicate is dropped from attempt reads | KILLED | 4 failing db tests |
| N9 | transition-event reads stop filtering by organization | KILLED | 4 failing db tests |
| N10 | Transaction B splits: the job moves outside the reservation commit | KILLED | 4 failing db tests |
| N11 | Transaction C splits: the pricing snapshot is written outside the commit | KILLED | 36 failing db tests |
| N12 | the pricing provider-binding check is removed | KILLED | 11 failing db tests |
| N13 | the pricing contract-key binding check is removed | KILLED | 4 failing db tests |
| N14 | the pricing model-key binding check is removed | KILLED | 8 failing db tests |
| N15 | the provider boundary stops re-checking the pricing binding | KILLED | 5 failing db tests |
| N16 | the 90-second product ceiling is removed | KILLED | 4 failing db tests |
| N17 | the job unit-tier CHECK becomes a mere inequality | KILLED | 5 failing db tests |
| N18 | the NORMAL/HIGH_QUALITY derivation CHECK is removed | KILLED | 5 failing db tests |
| N19 | job admission stops deriving units from the pricing contract | KILLED | 149 failing db tests |
| N20 | requiredUnitsFor reimplements ceil instead of delegating | KILLED | 9 failing unit tests |
| N21 | GENERATING -> CANCELLED is re-enabled on the job | KILLED | 4 failing unit tests |
| N22 | GENERATING -> CANCELLED is re-enabled on the scene request | KILLED | 4 failing unit tests |
| N23 | GENERATING -> CANCELLED is re-enabled on the scene | KILLED | 4 failing unit tests |
| N24 | the same-scene delivered-request foreign key is removed | KILLED | 6 failing db tests |
| N25 | ACCEPTED no longer requires a provider reference at the database | KILLED | 4 failing db tests |
| N26 | ACCEPTED no longer requires a provider reference in the domain | KILLED | 3 failing unit tests |
| N27 | the pricing contract key is taken from the caller, not the snapshot | KILLED | 25 failing db tests |
| N28 | the event's organization is read from caller metadata | KILLED | 4 failing db tests |
| N30 | the reservation copies caller units instead of the job's | KILLED | 7 failing db tests |
| P1 | the request hash is driven by caller prompt text instead of the scene's | KILLED | 5 failing db tests |
| P2 | the request hash is a V2-shaped constant rather than a derivation | KILLED | 5 failing db tests |
| P3 | the persisted asset stops coming from the GenerationScene | KILLED | 5 failing db tests |
| P4b | the attempt duration stops coming from the GenerationScene | KILLED | 29 failing db tests |
| P5 | the attempt target resolution stops coming from the GenerationJob | KILLED | 5 failing db tests |
| P6 | the attempt aspect ratio stops coming from the GenerationJob | KILLED | 5 failing db tests |
| P7 | attempt kind stops being derived from the attempts that exist | KILLED | 28 failing db tests |
| P8 | a second PRIMARY attempt becomes storable | KILLED | 8 failing db tests |
| P9 | PRIMARY admission stops moving the request PENDING -> GENERATING | KILLED | 12 failing db tests |
| P10 | the active-attempt-per-request index is removed | KILLED | 4 failing db tests |
| P11 | the pricing duration binding is removed | KILLED | 4 failing db tests |
| P12 | the pricing native-tier binding is removed | KILLED | 4 failing db tests |
| P13 | the pricing risk-profile binding is removed | KILLED | 5 failing db tests |
| P14 | the generation-mode binding is removed | KILLED | 4 failing db tests |
| P15 | the audio-mode binding is removed | KILLED | 4 failing db tests |
| P16 | Transaction B inserts the reservation directly as RESERVED again | KILLED | 4 failing db tests |
| P17 | the generic Job RESERVING -> RESERVED bypass is restored | KILLED | 4 failing db tests |
| P18 | the generic Request GENERATING -> DELIVERED bypass is restored | KILLED | 4 failing db tests |
| P19 | the generic Reservation -> CONSUMED bypass is restored | KILLED | 4 failing db tests |
| P22 | an FX rate with the same id but different content is accepted | KILLED | 4 failing db tests |
| P23 | the FX rate a snapshot names is never persisted | KILLED | 4 failing db tests |
| P24 | the concurrent-attempt guard is removed from admission | KILLED | 9 failing db tests |
| P25 | a finished request admits a new paid attempt | KILLED | 6 failing db tests |
| P26 | the job's output configuration is no longer snapshotted from the project | KILLED | 8 failing db tests |
| P27 | the job target-resolution vocabulary is no longer closed at the database | KILLED | 4 failing db tests |
| P28 | a scene with no compiled prompt is admitted anyway | KILLED | 4 failing db tests |
| Q1 | Transaction C parent-request serialization removed | KILLED | 4 failing db tests |
| Q2 | Transaction C lock acquired after sibling inspection | KILLED | 5 failing db tests |
| Q3 | concurrent attempt loser leaks P2002 (no lock, index only) | KILLED | 9 failing db tests |
| Q4 | user-regeneration parent-scene serialization removed | KILLED | 4 failing db tests |
| Q5 | conflict classifier keyed on the guessed index name is reinstated | KILLED | 4 failing db tests |
| Q6 | conflict classifier accepts a generic P2002 | KILLED | 3 failing db tests |
| Q7 | GenerationJob project read moved outside its transaction | KILLED | 4 failing db tests |
| Q8 | GenerationJob project lock removed but read kept in-transaction | KILLED | 4 failing db tests |

### The Q-series, and why Q8 is the one that matters

Each Q mutation removes or reorders exactly one serialization point. All eight
die.

**Q8** is the discriminating one. It keeps the project read *inside* the
transaction and removes only the `FOR SHARE` lock — and still fails. Without it,
"the read moved into the transaction" and "the read is serialized against a
concurrent writer" would be indistinguishable, and only the second is the
actual fix. **Q2** does the same job for Transaction C: it keeps the lock but
takes it *after* the sibling inspection, which is the plausible half-fix, and
that dies too.

**Q5** and **Q6** are the classifier, reinstated in its two possible forms.
`Q5` keys on the index name — the shape live PostgreSQL never produces, so the
translation silently never fires and the loser's `P2002` escapes. `Q6` accepts
any `P2002`, so an unrelated collision is reported as "a regeneration is already
in flight". Both are caught, which is the evidence that removing the classifier
was the right call rather than a convenient one.

### Mutations that measured the wrong thing, and what they found

**M22 and M23 survived an earlier round, and were right to.** They removed the
`consumedAt` and `deliveredAt` writes, and nothing failed — because after the
atomic-primitive correction neither branch could execute. Both edges into
`CONSUMED` belong to Transaction G and `GENERATING → DELIVERED` to Transaction
F, so the generic methods refuse them before reaching the write. The branches
were removed. **M22b** and **M23b** replace them, aimed at the reachable
siblings `releasedAt` and `failedAt`, and both die.

**P4 was aimed badly by the author** — it replaced the scene's duration with the
literal `5`, which is exactly the fixture's own duration, so the mutation was a
no-op and its survival said nothing. **P4b** uses `7` and dies against 29 tests.

**P20 was killed by the typechecker rather than by behaviour**, because deleting
the catch arm left its helper unreferenced. It has been retired along with the
classifier it targeted; `Q1`, `Q3` and `Q4` now cover that ground behaviourally.

### The one survivor

**N7 — the tenant predicate in the provider-boundary CAS.**
`armProviderBoundary` loads the attempt with a tenant-scoped `findFirst`
**inside its transaction** and returns `LOST` when it finds nothing. The
predicate in the CAS `where` is a second, redundant copy of a check that has
already decided the outcome; removing it changes no behaviour any test can
observe, and **N8**, which removes the scoped read itself, dies immediately.
The requirement that tenant scope share the CAS's transactional decision is met
by that read. The redundant predicate is kept as defence in depth, exactly as
previously authorized. Manufacturing a test for it would be evidence about
nothing.

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
- **Transaction F (scene delivered) is not implemented, and its edge is now
  closed rather than half-open.** `GENERATING → DELIVERED` is refused by the
  generic request transition with `TRANSITION_RESERVED`: delivery spends a
  customer's regeneration right, and the half that makes it safe — output
  verification — does not exist yet. The constraints, the composite foreign key
  and `GenerationScene.currentDeliveredRequestId` are in place for it. The same
  applies to Transaction G and both edges into `CONSUMED`.
- **`deliveredAt` and `consumedAt` are therefore never written today.** The
  transactions that earn those instants will write them; the generic methods no
  longer carry unreachable branches that pretend to.
- **The job state machine's cancellation and failure edges are the one place I
  extended beyond the brief's explicit list.** §9 froze the forward path;
  which non-terminal states may reach `CANCELLED` and `FAILED_TERMINAL` was not
  specified. I chose the narrowest reading — no cancellation once composition
  has begun, and no failure edge out of `DELIVERABLE_READY` — and flag it here
  rather than presenting it as given.
