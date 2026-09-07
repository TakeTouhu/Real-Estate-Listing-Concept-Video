# Phase 4C-3B-2F-1 — Completion report

The dormant paid submission authorization gate. Base:
`b613d2eb2bee8f4ad0a6d6403171dc0b4356ca6f`.

> **Revision 2 — CTO review corrections.** The first submission
> (`1c0bfd5caecbec67aafd4f31a0736eeb80c31319`) was not approved. Three of its
> statements were wrong and are corrected throughout this document:
>
> | Superseded claim | Correction |
> | --- | --- |
> | A `CONSUMED` reservation is universally invalid | A post-delivery `USER_REGENERATION` runs against a `CONSUMED` reservation by contract |
> | `RECONCILIATION_EXHAUSTED` carries no uncertain exposure | Its provider cost remains uncertain and stays in the guard |
> | `NO_NEGATIVE_UNIT_ECONOMICS` is a runtime customer block | It is a sellability decision made before the work is offered, and has been removed from runtime |
>
> Also corrected: the complete `PricingSnapshot` is now re-derived rather than
> partly trusted; the authorization instant comes from a clock read after the
> lock rather than from the caller; the financial basis of every authorization
> is persisted with its transition event; and persisted `BIGINT` money is
> range-checked before it is narrowed.
>
> **Revision 3 — final integrity corrections.** Revision 2
> (`1b4c3ea978ac7763e323d54750e12df4dd01b1f7`) was not approved. Two integrity
> defects remained, both of which allowed a paid boundary to be crossed on a
> fact that was no longer true:
>
> | Defect | Correction |
> | --- | --- |
> | The `GenerationReservation` row was read without a row lock, so a release or reconciliation hold could commit between the gate's decision and its CAS | A tenant-scoped `FOR SHARE` row lock on the exact reservation, taken after the cost lock and held to commit |
> | `loadExposure` trusted each sibling's stored `estimatedPlanningCostMicroUsd`, so one edited row could remove real exposure from the guard | Every cost-bearing sibling goes through the same `verifyPersistedPricingSnapshot` the candidate does; a sibling that cannot reproduce fails the authorization closed |

One provider-neutral service answers exactly one question:

> Given one already-admitted provider attempt, is the system allowed to arm the
> paid submission boundary?

**No provider is called anywhere in this phase.** The gate ends at
`SUBMITTING` and nothing consumes what it returns.

## The authorization contract

```text
attempt already admitted
+ orchestrationState == QUEUED
+ submissionCertainty == PRE_SUBMISSION
+ a reservation this request kind may stand on
    (RESERVED always; CONSUMED only for a USER_REGENERATION)
+ a pricing contract eligible on its verified stable/list price
    at the post-lock authorization instant
+ a PricingSnapshot that re-derives exactly from its own frozen inputs
+ the persisted route is one the product sells
+ Safety Guard is not in HARD_PAUSE with this attempt's cost included
        ↓
   armProviderBoundary()  ← inside the same transaction and lock
        ↓
   SUBMITTING committed
        ↓
   AUTHORIZED
```

### Gate input — the whole of it

```ts
{ organizationId, attemptId, context }
```

Nothing else. The caller cannot supply the provider, the model, the pricing
snapshot, the contract key, the cost, the risk profile, the reserved units, the
billing cycle, the attempt state, the certainty, the quality tier, the duration,
the target resolution, the request kind, the regeneration ordinal or the request
hash — every one is loaded through the tenant-scoped persistence graph. Two
caller-controlled copies of a persisted fact eventually disagree, and the one
that decides whether to spend money is the wrong place to find that out.

**There is no `authorizationInstant`, and its absence is a control.** The
instant decides pricing eligibility, so a caller that could choose it could
authorize against a contract that had expired — not as a hypothetical abuse but
as the ordinary consequence of a worker passing along a timestamp it captured
when it picked the job up. See *The authorization clock* below.

The `context` a caller supplies carries actor, correlation, causation and reason
code — who asked and why. Its `eventType` is overwritten: the label on the one
event that records permission to spend money is what an audit query selects on,
and it is not the caller's to write.

### Closed outcome union

`AUTHORIZED` · `ATTEMPT_NOT_FOUND` · `ATTEMPT_NOT_ARMABLE` ·
`RESERVATION_INVALID` · `PRICING_INELIGIBLE` · `SAFETY_GUARD_HARD_PAUSE` ·
`ROUTING_NOT_AUTHORIZED` · `LOST_CONCURRENCY`

There is deliberately **no** `PROFITABILITY_REJECTED` arm — see *Profitability
is not a runtime block*.

Each failure arm carries a closed reason vocabulary. No arm carries a database
error, a provider message or free text: a caller that can only `switch` over a
known set cannot mistake an unrecognized refusal for permission, and a reason
that leaked a raw error would put tenant or provider detail into whatever logs
it.

`AUTHORIZED` deliberately carries **no token**. What it reports is the state the
database already committed — this attempt is `SUBMITTING` at this version. A
reusable capability object would be a second source of truth, and the one that
can authorize a POST twice.

## Pure evaluator, then side effects

```text
PaidSubmissionGateFacts → evaluatePaidSubmissionGate(...) → decision
                              ↓ (only if PERMITTED)
                        armProviderBoundary()
```

`evaluatePaidSubmissionGate` holds no database handle, no provider client and no
clock. It receives validated, normalized facts — never a Prisma model, and the
authorization instant among them — which is what makes the money-spending rule
exhaustively testable without spending any, and every branch of it
deterministically mutable.

Non-armable attempt states, submission certainties and reservation states are
each mapped through an exhaustive `Record<...>` over the enum, so a value added
to any of those unions fails the build here rather than inheriting whichever
branch happened to be last. `classifyProviderCostExposure` closes its state
switch with a `never` check for the same reason.

The service composes the evaluator with persistence and nothing else. Its
dependencies are a repository, a billing-cycle revenue reader and a clock —
there is no provider client in the type and no way to add one without changing
the port file, so *the gate cannot call a provider* is a fact about its type
rather than a promise in a comment.

## Reservation policy

The state alone does not decide. What decides is the state **together with the
parent request's kind**, because a customer's regeneration right is sold with
the original video and is exercised after it has been delivered — by which time
the reservation is `CONSUMED` and no further customer unit is owed.

| Reservation state | `INITIAL` request | `USER_REGENERATION` request |
| --- | --- | --- |
| `RESERVED` | **authorizes** | **authorizes** |
| `CONSUMED` | refused — `RESERVATION_CONSUMED` | **authorizes** |
| `RESERVING` | refused — `RESERVATION_NOT_HELD` | refused — `RESERVATION_NOT_HELD` |
| `RELEASED` | refused — `RESERVATION_RELEASED` | refused — `RESERVATION_RELEASED` |
| `RECONCILIATION_HOLD` | refused — `RESERVATION_ON_RECONCILIATION_HOLD` | refused — `RESERVATION_ON_RECONCILIATION_HOLD` |

Getting `CONSUMED` wrong is expensive in both directions. Refusing it
universally — as the first submission did — denies a customer the regeneration
they already paid for. Accepting it universally would let a fresh `INITIAL`
request render against units that are already gone.

The exemption is narrow and stays narrow. `RELEASED` means the entitlement
itself is gone, and a regeneration right cannot outlive the entitlement it was
sold with; `RECONCILIATION_HOLD` means an earlier submission's fate is
unresolved. Neither becomes acceptable because the request is a regeneration.

`SceneGenerationRequest.kind` and `userRegenerationOrdinal` are read from the
tenant-scoped chain and never accepted from a caller — a caller able to assert
"this is a regeneration" could spend against any consumed reservation. The pair
must also be coherent (`INITIAL` ⇒ no ordinal, `USER_REGENERATION` ⇒ an
ordinal); an incoherent row refuses with
`REQUEST_REGENERATION_ORDINAL_INVALID` rather than being allowed to select the
permissive branch.

A `SYSTEM_RECOVERY` attempt inherits its parent request's semantics: the rule
branches on the *request* kind, so a platform retry under a post-delivery
regeneration is judged exactly as the regeneration is. It is not a second
customer regeneration and does not consume a right the customer did not use.

Identity and coherence are checked as well: the reservation must belong to this
attempt's job, `reservedTotalVideoUnits` must equal `job.requiredVideoUnits`, and
`reservedHighQualityUnits` must equal `job.requiredHighQualityUnits` **in both
directions**. High quality marks units already reserved and never adds any, so a
hold claiming more or fewer is incoherent either way.

Nothing here converts a reservation state, and nothing consumes quota — for a
regeneration no less than for an initial request. A database test proves the
`CONSUMED` reservation is byte-for-byte unchanged across an authorization, that
its `stateVersion` does not move, and that no second reservation is created.

## Pricing policy

Eligibility is the Phase 4C-3B-2D contract, called rather than reimplemented:
`evaluatePaidSubmissionPricingEligibility(contract, authorizationInstant)`.
Verified stable/list pricing in force at the instant is required;
promotion-only, unverified, expired and not-yet-effective are all refused. A
live promotion alongside a verified stable rule is eligible **and the stable
rule remains the planning basis** — a discount that ends must not leave the
platform committed to work it can no longer cost.

The contract is resolved by the snapshot's **own frozen identity**, so what is
judged is the contract this attempt was admitted against, not whatever the
catalog would return for its provider and model today.

On top of eligibility the gate re-checks the persisted binding — provider,
contract key, requested duration and risk profile — before
`armProviderBoundaryWithin` re-checks the rest from the stored row. That is
deliberate defence in depth: admission enforced these once, and persisted
corruption between then and now must not buy a paid call.

### Complete snapshot integrity

**Correction.** The first submission checked a subset of binding fields and then
*trusted* `estimatedPlanningCostMicroUsd` as stored. That is the wrong place to
stop, for a specific reason: provider and model are the fields nobody tampers
with, because changing them breaks the submission. The stored cost is the field
that decides how much of a cycle's Safety Guard headroom this attempt consumes,
and it can be rewritten to almost nothing while every binding field still
matches perfectly.

The whole row is now re-derived. `verifyPersistedPricingSnapshot` loads every
persisted column —

```text
pricingVersion · provider · contractKey · contractFingerprint · identityJson
stablePriceReferenceJson · riskProfileKey · riskBufferBps · requestedSeconds
billableSeconds · estimatedStableCostMicroUsd · estimatedPlanningCostMicroUsd
pricingEffectiveAtEpochMs · fxSnapshotId
```

— resolves the candidate contract by the snapshot's complete identity, and then:

1. compares `providerPricingContractFingerprint(contract)` against the persisted
   `contractFingerprint`. Phase 4C-3B-2D introduced that field precisely because
   two contracts can share all seven identity dimensions while differing in
   price, verification, verification window, duration policy or promotion — so
   resolving by identity and calling it the same contract is a guess. A mismatch
   is `PRICING_CONTRACT_FINGERPRINT_MISMATCH`;
2. range-checks the `BIGINT` columns *before* narrowing them;
3. checks that the persisted effective instant lies inside the contract's own
   window. The instant is an *input* to the derivation, so re-deriving with it
   can never disagree with it — a moved instant would reproduce itself
   perfectly. What can be checked is whether it is a time at which this contract
   applied at all;
4. re-runs the **same** `createPricingSnapshot` admission ran, over the persisted
   risk profile, duration, instant and exact FX snapshot;
5. compares every immutable commercial fact, including both cost amounts, the
   billable duration, the risk buffer, the identity and the stable price
   reference. A single disagreement refuses with
   `PRICING_SNAPSHOT_NOT_REPRODUCIBLE` — there is no such thing as a snapshot
   that is mostly the one that was admitted.

The value that becomes exposure is the **re-derived** planning cost, not the
stored column. No pricing arithmetic is duplicated in the repository: it reads
rows, and the pricing domain does the maths.

### Historical exposure integrity — a separate responsibility

**Correction.** Revision 2 protected the candidate and left `loadExposure`
reading each sibling's stored `estimatedPlanningCostMicroUsd` and converting it
directly. That is not a smaller version of the same protection; it is a hole in
the same equation:

```text
existing PROCESSING sibling, real planning cost ¥5,000
stored amount edited to a valid safe integer worth ¥10
        ↓
Safety Guard sees ~¥4,990 less exposure than exists
        ↓
a candidate with a flawless snapshot authorizes a call that should hard-pause
```

Verifying one term of a sum and trusting the rest leaves the sum exactly as
forgeable as before. Every cost-bearing sibling — `IN_FLIGHT`, `UNCERTAIN` and
`SETTLED_ESTIMATED` alike — now goes through **the same**
`verifiedPlanningCostYen`, which loads the complete snapshot, resolves the
contract by its persisted identity, and calls the same
`verifyPersistedPricingSnapshot` the candidate goes through. Candidate and
sibling share one verifier and one arithmetic path; they are not forked.

**Two different questions, deliberately.** Current pricing *eligibility* is
required of the candidate — it is about to be priced and paid for. A sibling has
already been priced, and the only question about it is whether its persisted
historical snapshot reproduces exactly. A contract that expired last month still
describes real money that was really committed, and erasing that cost because
the rate card lapsed would understate the cycle in precisely the situation — a
provider price change during an incident — where the guard matters most. So no
sibling is ever evaluated against the current authorization instant.

**Failure is closed, and correctly attributed.** A cost-bearing sibling with a
missing snapshot, an unresolvable historical contract, a fingerprint mismatch, a
non-reproducible row, a tampered amount, an unrepresentable `BIGINT` or a
missing/invalid referenced FX snapshot is **not** skipped and **not** counted as
zero. The authorization refuses with `PRICING_EXPOSURE_SNAPSHOT_INVALID` — a
distinct reason under `PRICING_INELIGIBLE`, separate from every reason that
describes the candidate's own pricing, because a sibling's broken snapshot says
nothing about this attempt's FX rate and labelling it that way would send an
operator to the wrong row.

A `DEFINITIVELY_REJECTED` sibling is exempt, and that is deliberate: it
contributes zero provider exposure, so its historical price is not part of the
equation. Requiring reproduction from it would turn an attempt the provider
refused into cost purely because its rate card is no longer reconstructible.

### Persisted money at the `BIGINT` boundary

`microUsd(Number(value))` narrows first and validates second, so a value beyond
2^53 is already wrong by the time the pricing domain inspects it — and what the
pricing domain does with an unsafe integer is **throw**, because inside that
domain it is a caller defect. At the persistence boundary it is neither: a row
holding an unrepresentable amount is a corrupt or hostile financial fact, and
the correct answer is to refuse the authorization, not to raise
`PricingArithmeticError` out of an ordinary gate invocation where it would
surface as a 500 and skip every audit path a refusal takes.

One narrow helper — `persistedIntegerToNumber` / `persistedMicroUsd` — checks
the range *before* narrowing and returns `null`. Every caller in the
authorization path turns that into `PRICING_AMOUNT_UNREPRESENTABLE`. The same
discipline covers the FX snapshot's integer columns, where a silently narrowed
rate would mis-convert every amount it touched.

### The authorization clock

**Correction.** The instant was caller input. It decides pricing eligibility, so
a caller could select a time at which an expired contract was still eligible.

It is now a dependency:

```ts
interface AuthorizationClock { now(): EpochMillis }
```

read **after the cost-admission lock is acquired**, exactly once, and used for
every time-dependent part of one decision. A request that waited behind a long
queue is judged at the time it reached the front rather than the time it joined
— and a database test constructs precisely that: a contract whose window closes
mid-wait authorizes at the pre-close instant and refuses with
`PRICING_CONTRACT_EXPIRED` at the post-close one, with the boundary never
reached.

No domain code calls `Date.now()`; a static test over the whole `authorization/`
module asserts it, with `clock.ts` as the one legitimate reader.

## Profitability is not a runtime block

**Correction.** The first submission ran `NO_NEGATIVE_UNIT_ECONOMICS` at
submission time and refused with `PROFITABILITY_REJECTED`. That was wrong, and
both the check and the outcome arm are gone.

The rule is a **sellability** decision. It answers "would the contractual worst
case for this route lose money?", and that question has to be answered before a
route is commercially certified and before a plan is configured — because by the
time a customer submits, the work is already sold. Asking it at runtime converts
a margin that moved *after* the sale into a refusal to render, which is exactly
the restriction the frozen principle forbids:

> Normal contractual customer usage must not be restricted merely because of
> short-term internal cost pressure.

It also had no honest input. Nothing persists per-scene revenue, and dividing a
subscription by a current scene count produces an *average* — which is precisely
what a worst-case check must not plan against. The `SceneRevenueReader` port has
been removed rather than left in place with nothing behind it, because a port
that exists is a port something will eventually fill with a guess.

### Where the rule belongs instead

`NO_NEGATIVE_UNIT_ECONOMICS` is a **Phase 4C-3B-2F-2 activation prerequisite**:
every production route must carry an approved commercial certification proving
its contractual worst case is non-negative, including the already-frozen
regeneration economics (three paid provider attempts per scene) and the required
system-recovery/failure reserve. That certification gates:

- product pricing review;
- route commercial certification;
- provider-routing activation;
- customer-plan configuration admission.

The runtime gate may still block on an invalid reservation, invalid pricing,
unauthorized routing, a non-armable attempt, lost concurrency, and a Safety
Guard `HARD_PAUSE`. It may not block a contracted request on a margin
calculation. The separation, stated once:

```text
commercial sellability certification   ≠   runtime paid-submission authorization
   (before the work is offered)              (after it has been bought)
```

`evaluateUnitEconomics`, `worstCaseSceneProviderCostYen` and
`PROFITABILITY_TARGETS` remain in the pricing domain, unchanged and untouched by
this gate. They are read by the certification path, not by a customer request.

## Safety Guard

The existing pure contract, unchanged:

```text
WARNING    floor = max(¥20,000, billing-cycle revenue × 25%)
HARD PAUSE floor = max(¥15,000, billing-cycle revenue × 20%)

state = profit < hardPauseFloor ? HARD_PAUSE
      : profit < warningFloor   ? WARNING
      : SAFE
```

Strictly **below**, never at-or-below — the floors are the last acceptable
values, not the first unacceptable ones. The published plan thresholds are
consequences of that formula rather than a table: ¥20,000/¥15,000 for Standard,
¥29,950/¥23,960 for Premium, ¥74,500/¥59,600 for Enterprise, all asserted by
test.

The quantity compared is **projected contribution profit**, which is where
exposure enters:

```text
projectedContributionProfit = billingCycleRevenue − totalProviderCostExposure

totalProviderCostExposure = knownActualCost        (structurally 0 today)
                          + settledEstimatedCost   ← corrected: was missing
                          + uncertainCost
                          + inFlightCost
                          + nextProjectedCost      ← the candidate's own
```

### Exposure categories

**Correction.** The first submission classified on execution state alone, and
therefore lost money that had been or may have been spent. `FAILED_TERMINAL`
says the work is over; it says nothing about whether the provider was paid, and
the same state covers both "the provider ran it, billed us, and the output
failed validation" and "the provider refused it outright".

Classification is now a function of **both axes** — execution state and
`submissionCertainty` — through one canonical
`classifyProviderCostExposure(state, certainty)`. No repository writes its own
list; a persistence query narrows with a prefilter derived from the module's own
exported constants, and a parity test proves that prefilter never excludes
anything the classifier would have counted.

| Category | When | Why |
| --- | --- | --- |
| **Known actual** | *(never returned today)* | Nothing persists what a provider actually billed. The category exists so the future ingestion path has somewhere to put its answer without the guard's arithmetic changing |
| **Settled estimated** | `OUTPUT_VERIFIED`, `FAILED_RETRYABLE`, `FAILED_TERMINAL`, `QUEUED`, `CANCELLED_PRE_SUBMISSION` — with `ACCEPTED` | Crossed the boundary and finished. Conservative, and explicitly **not** actual cost: the immutable planning estimate, retained until an actual-cost ingestion path *replaces* it |
| **Uncertain** | `RECONCILIATION_PENDING`, `RECONCILIATION_EXHAUSTED` (any certainty but `DEFINITIVELY_REJECTED`); any terminal state with `SUBMISSION_UNKNOWN` | May already have been billed, and nothing can establish it was not |
| **In-flight** | `SUBMITTING`, `PROCESSING`, `PROVIDER_SUCCEEDED`, `OUTPUT_INGESTING` | At or past the boundary with an unfinished cost lifecycle |
| **None** | any state with `DEFINITIVELY_REJECTED`; `QUEUED` / `CANCELLED_PRE_SUBMISSION` / terminal states with `PRE_SUBMISSION` | The provider refused, or the boundary was never crossed |

`RECONCILIATION_EXHAUSTED` is the correction that matters most. Its frozen
meaning is *the reconciliation window is exhausted and the provider submission
remains unknowable*. Exhausting the window resolves the **customer's**
entitlement; it resolves nothing at all about what the provider charged. Zeroing
it because the state is terminal would make giving up look like a refund, and
would understate exposure in exactly the cycles where an incident happened.

`DEFINITIVELY_REJECTED` is the one negative fact strong enough to zero a cost
anywhere: the provider refused the submission, so there is nothing to bill.

`SUBMITTING` counts from the instant the boundary commits, before any HTTP call:
an attempt that crashed mid-POST is indistinguishable from one that never sent,
and the difference is a charge.

Each attempt is valued at **its own immutable planning snapshot**, converted
through **its own persisted `FxRateSnapshot`** via the canonical
`validateFxSnapshot` / `convertMicroUsdToYen` path. No live FX, no default rate:
a missing, invalid or unrepresentable rate fails the gate closed, including when
it belongs to some *other* attempt's exposure, because a total known to be short
must not authorize anything.

### Warning does not block

`SAFE` and `WARNING` both continue; only `HARD_PAUSE` refuses. Normal
contractual usage is not restricted because the month is thin — a customer who
bought forty videos is owed forty videos. The warning is not swallowed either:
the decision is carried out on the `AUTHORIZED` result so it can be recorded.

## Routing authorization

A provider-neutral table in `@app/domain` binding all eight facts: quality tier,
provider name, provider model id, request model key, native generation
resolution, target output resolution, generation mode, audio mode.

| Tier | Provider | Model key | Provider model id | Native | Targets |
| --- | --- | --- | --- | --- | --- |
| `NORMAL` | `fal` | `minimax-h3-max` | `minimax/h3-max/image-to-video` | `768P` | 720p, 1080p |
| `NORMAL` | `wavespeed` | `wavespeed-open-video` | `wavespeed-ai/open-video/image-to-video` | `1080p` | 720p, 1080p |

H3 Max's provider is **`fal`**, never `google-veo` and never the model's
manufacturer: a route names whoever the request is sent to and whoever invoices.
Target output resolution stays independent of native generation resolution — both
product targets are served from one 768P generation, and 1080p is an upscale.
Nothing here claims H3 Max native 1080p.

**`HIGH_QUALITY` has no authorized route.** Veo 3.1 Fast remains benchmark-gated
with a verified pricing contract and no adapter, no credential and no factory
branch. Listing it would let an attempt pass routing and arrive at a boundary
with nothing behind it; the empty set is the honest state and
`QUALITY_TIER_ROUTE_NOT_AUTHORIZED` says so precisely.

Validation, never selection. The attempt froze its route at admission and the
duplicate-payment hash covers those facts, so substituting a different provider
here would produce an attempt whose stored identity describes work nobody
ordered. A route that is no longer authorized fails closed; a reroute requires a
new attempt row.

The table is **validation only** and nothing in it makes a provider executable.
A route being authorized is not a factory branch, a credential or a call: fal
has an authorized route shape and no production factory branch or key, and Veo
has neither. The table's version (`ROUTING_POLICY_VERSION`) is persisted with
every authorization, because which routes the product sold on a given day is not
reconstructible from the current source.

### Dependency direction

`@app/domain` depends only on `@app/shared`, so it cannot import
`@app/video-providers` to read the executable catalog — that would invert the
direction and put a concrete adapter in the layer that decides whether money may
be spent. The cost is **one duplicated string**, the H3 Max provider model id,
and it is paid with a test rather than a comment:
`tests/routing-catalog-parity.test.ts` imports both packages and fails if they
disagree, and additionally requires every authorized route to name a
`SELECTABLE` catalog entry with a matching provider and model id.

No capability envelope, duration range, aspect-ratio policy, native-generation
policy or pricing is duplicated. Each has exactly one authority.

## Concurrency and serialization

### Same attempt

The Phase 4C-3B-2E compare-and-set remains the final authority. Two workers
evaluating the same valid attempt produce exactly one `AUTHORIZED`; the loser
gets `LOST_CONCURRENCY` and is never handed permission to POST. Nothing retries.

### The reservation row

**Correction.** The cost-admission lock orders two *authorizations* against one
cycle. It says nothing about a third party changing the reservation those
authorizations depend on, and that left a legal race:

```text
T1  lock cycle → read reservation RESERVED → gate permits
T2                UPDATE reservation → RELEASED (or RECONCILIATION_HOLD)
T2                commit
T1  arm QUEUED → SUBMITTING → commit
```

The paid boundary is crossed after the hold that authorized it stopped
authorizing it, and nothing later can undo that — the provider may already have
been paid.

A **tenant-scoped `FOR SHARE` row lock** on the exact reservation reached
through attempt → request → scene → job → reservation is now taken immediately
after the cost-admission lock, before any fact that depends on it is read, and
held until the transaction commits or rolls back.

`FOR SHARE` rather than `FOR UPDATE`: the authorization does not modify the
reservation, it only needs to be certain nobody else does while it decides, and
a shared lock blocks every state-changing `UPDATE`/`DELETE` on that row for the
lifetime of the transaction. Two authorizations against one reservation are not
in conflict with each other — the cost lock already orders those, and the
attempt CAS is the final authority — so `FOR UPDATE` would serialize readers
against each other for no correctness gain. A mutation weakening it to
`FOR KEY SHARE`, which does *not* block a state update, is in the ledger.

### Same organization and billing cycle

A PostgreSQL **transaction-scoped advisory lock** keyed on
`(hashtext("paid-submission:<orgId>"), hashtext("cycle:<cycleKey>"))`, taken
before any fact is read and held until commit — and before the authorization
instant is read, so a request that waited behind it is priced at the time it was
actually decided. Two authorizations for one
organization and cycle therefore cannot both read the same exposure and both
conclude it is affordable: the second waits, re-reads, and sees the first one's
committed attempt.

No migration: the correctness property is "two authorizations for one
organization and cycle are ordered", and an advisory lock states exactly that
without inventing a row to lock. It releases at commit or rollback, so a crashed
worker cannot strand an organization.

Scoped to organization **and** cycle, never globally — one tenant's incident must
not pause another, and last month's exposure must not block this month's work.
Both are asserted by test.

**Lock ordering.** The canonical order is:

```text
organization + cycle cost-admission advisory lock
  → GenerationReservation row lock
    → Attempt arm CAS
```

Every future workflow that mutates reservation state as part of submission
reconciliation or entitlement release must take these in the same order. The
advisory lock is the outermost lock in the system. The Phase 4C-3B-2E
locks — `scene_generation_requests` (attempt admission), `generation_scenes`
(regeneration admission) and `video_projects` (job creation) — are each taken
inside their own transactions and are never held while this one is acquired,
because authorization never admits anything. The single nesting is this lock
around `armProviderBoundaryWithin`, which takes no row lock beyond its own CAS.
No cycle exists: nothing acquires a 2E lock and then waits for this one.

`armProviderBoundary`'s body was **extracted** into
`armProviderBoundaryWithin(tx, input)` so the gate can compose it into one
transaction rather than duplicating it. The public method is unchanged in
behaviour — it opens a transaction and calls the extracted function. Two
transactions would reopen exactly the window the lock exists to close.

### How the concurrency tests discriminate

Not by launching two calls and hoping. Measured directly, two in-process
authorizations complete one after another even on separate pools — so a plain
race passes against an implementation with no lock at all. Instead a **third**
connection takes the same cost lock and holds it, both authorizations are
started and asserted to be *still blocked*, and only then is it released. They
are then genuinely contending, and the lock is what orders them.

Verified by removing the lock: both concurrency tests fail.

The reservation race is proven in **both directions**, because either alone
leaves half the window open:

- **A writer wins first.** A second connection opens a transaction, updates the
  reservation to `RELEASED` (and separately to `RECONCILIATION_HOLD`) and holds
  it uncommitted. The authorization is started and asserted to be *still
  blocked* — that is what makes it a proof rather than a hopeful race. On
  commit it refuses with `RESERVATION_RELEASED` / `RESERVATION_ON_
  RECONCILIATION_HOLD`, and the attempt is still `QUEUED` with no
  `submissionBoundaryEnteredAt`.
- **The authorization wins first.** Driven through the real `withCostAdmission`,
  whose callback runs inside the transaction after both locks are taken, so a
  concurrent reservation `UPDATE` is asserted blocked and then completes once
  the authorization commits. Re-issuing the lock SQL in the test would have
  proven a copy of the query rather than the one production uses.

All three fail when the row lock is removed; the post-delivery regeneration path
against a terminal `CONSUMED` reservation is asserted not to regress.

### The successful flow, in order

```text
begin transaction
  → resolve the reservation's immutable billing cycle
  → acquire the organization + cycle cost-admission lock
  → lock this attempt's GenerationReservation row (FOR SHARE)
  → load the authoritative gate facts (attempt chain, reservation,
      verified pricing snapshot, cycle exposure)
  → read the authorization instant from the clock
  → evaluate the pure gate
  → armProviderBoundaryWithin: compare-and-set QUEUED → SUBMITTING
  → append the PAID_SUBMISSION_AUTHORIZED transition event carrying
      the financial basis of the decision
commit
  → AUTHORIZED
```

The compare-and-set remains the final authority. If it loses, the answer is
`LOST_CONCURRENCY` and no provider authorization is issued to the loser.

## Audit — the durable authorization record

The existing `GenerationTransitionEvent` mechanism, not a second audit table.
For an authorized attempt the `QUEUED → SUBMITTING` transition event is the
authoritative boundary record, written atomically with the state change.

**Correction.** A Safety Guard `WARNING` previously existed only in the returned
object. That is not durable: if the process crashes after the commit but before
its caller records the return value, the system cannot reconstruct that the
provider boundary was crossed under `WARNING` — and the one question an incident
asks of a paid boundary is *under what conditions did we let this through*.

The financial basis of every authorization is now written into the event's
`safeMetadata`, inside the same transaction as the compare-and-set:

```text
authorizationPolicyVersion   routingPolicyVersion   safetyGuardState
billingCycleKey              billingCycleRevenueYen pricingSnapshotId
knownActualCostYen           settledEstimatedCostYen
uncertainCostYen             inFlightCostYen        nextProjectedCostYen
projectedContributionProfitYen
warningFloorYen              hardPauseFloorYen
```

Each is a yen integer, a closed-vocabulary value or a version identifier. All
are newly allowlisted keys in `ALLOWED_TRANSITION_METADATA_KEYS`; no prompt, no
provider payload, no raw error, no credential and no signed URL goes near it,
and a test asserts the record carries none of them. The two policy versions are
there because *which rules were in force* is not reconstructible from the
current source, so a decision found in history needs them to be readable at all.

The event type is fixed by the service as `PAID_SUBMISSION_AUTHORIZED` and the
audit keys are written *after* the caller's metadata, so a caller can supply
actor, correlation and causation but cannot relabel a paid authorization or
pre-seed a friendlier guard state into its own record.

Both a `SAFE` and a `WARNING` authorization are reloaded through a **separate
database connection** in the integration suite and asserted from the row alone.
No process-local return value participates.

**A rejected gate writes nothing.** The attempt stays `QUEUED` with no
`submissionBoundaryEnteredAt` and no new event: a refusal discovered nothing
about the provider, so a transition event would be history for a state change
that did not happen. Asserted by test.

## What this phase does not do

No real fal POST, no Veo POST, no new WaveSpeed paid orchestration, no polling,
no reconciliation worker, no stale-`SUBMITTING` recovery, no output ingestion,
no composition, no upscale, no entitlement consumption, no payment gateway, no
Stripe, no add-on purchasing, no UI. No live fal, WaveSpeed, Veo, FX or
payment-provider lookup of any kind.

The authorization service has **no provider dependency and performs no network
call**, proven two ways: a static check over its own source for transport
imports and call syntax, and a runtime check that drives a complete
authorization with `fetch`, `XMLHttpRequest` and `WebSocket` replaced by
throwing stubs.

`SUBMISSION_UNKNOWN` can never re-arm — no reset to `QUEUED`, no second POST, no
new invocation on the same attempt. Stale `SUBMITTING` is never treated as
permission to try again; recovery is a later reconciliation phase.

Customer billing is untouched on every path, authorized or refused. No
`GenerationReservation` is consumed and none is created, no customer unit is
decremented, no money moves, no invoice is written and no add-on is purchased —
including on the post-delivery regeneration path, whose whole point is that the
provider cost is internal.

## Production activation prerequisites

The gate is dormant and, with the shipped readers, authorizes **nothing at all**.
Before any real paid submission:

1. **Authoritative billing-cycle revenue.** Nothing persists a subscription,
   plan assignment or invoice. `BillingCycleRevenueReader` is a port and the
   shipped implementation returns `null`, which fails closed. Assuming Standard
   would hard-pause an Enterprise customer at a quarter of their real threshold;
   deriving a plan from seats or usage would invent a commercial fact from
   operational data.
2. **An immutable FX snapshot source.** The gate correctly requires a persisted
   `FxRateSnapshot` for USD → JPY Safety Guard evaluation, and **no production
   process creates one today.** Phase 4C-3B-2F-2 must not activate paid provider
   execution until there is an authorized source or workflow that creates the
   exact snapshot attempt pricing uses. No live FX access is added here, and
   none should be added without that authorization.
3. **An actual provider-cost ingestion path.** Until it exists,
   `knownActualCostYen` is structurally zero and accepted terminal attempts are
   carried at `settledEstimatedCostYen` — the immutable planning estimate, held
   conservatively. That ingestion path must **replace** the settled estimate for
   the attempts it covers, not add to it.
4. **Provider price re-verification immediately before activation.** This phase
   operates against the persisted/catalogued verified contract for deterministic
   tests; it does **not** complete the production re-verification requirement.
5. **Commercial certification of every production route.**
   `NO_NEGATIVE_UNIT_ECONOMICS` moved out of runtime and lives here: each route
   needs an approved certification proving its contractual worst case is
   non-negative, including the frozen regeneration economics (three paid
   provider attempts per scene) and the required system-recovery/failure
   reserve. Nothing may be offered to a customer on an uncertified route.
6. **Provider routing activation.** Credentials, factory branches and a concrete
   adapter belong to Phase 4C-3B-2F-2 and require separate CTO authorization.
   fal has no production factory branch and no credential today; Veo has no
   authorized route at all.
7. **A reconciliation worker.** Attempts in `RECONCILIATION_PENDING` and
   `RECONCILIATION_EXHAUSTED` accumulate uncertain exposure with no path to
   resolve it. Without reconciliation, a cycle's uncertain total only grows.
8. **A stale-`SUBMITTING` recovery worker.** In-flight exposure is entered at the
   boundary commit and left only by a later transition; with no recovery, a
   crashed worker's attempt holds exposure indefinitely. Recovery must preserve
   the `SUBMISSION_UNKNOWN` no-re-POST semantics through every later phase.
9. **A canonical production source for `providerModelId`.** One string is
   duplicated between `@app/domain` and `@app/video-providers` under
   test-enforced parity; a single authority at the correct dependency level
   would be better.

## Mutation ledger — 72/74 killed

Every mutation targets an **executed** artefact — the pure gate, the routing
table, the exposure classifier, the pricing-integrity verifier, the
persisted-money helper, the reservation row lock, the authorization service, or
the persistence that feeds them — and each removes exactly one rule the gate is
supposed to enforce, or restores exactly one rule a correction round removed.
The harness applies a mutation, runs the gated suites, restores the file, and
asserts the restore is byte-identical.

| ID | Mutation | Result | Detected by |
| --- | --- | --- | --- |
| G1 | the QUEUED requirement is removed | KILLED | 14 failing unit tests |
| G2 | the PRE_SUBMISSION requirement is removed | KILLED | 7 failing unit tests |
| G3 | SUBMISSION_UNKNOWN becomes armable | KILLED | 5 failing unit tests |
| G4 | the reservation requirement is removed | KILLED | 4 failing unit tests |
| H1 | a CONSUMED reservation is refused again for every request kind | KILLED | 4 failing unit tests |
| H2 | an INITIAL request is allowed against a CONSUMED reservation | KILLED | 5 failing unit tests |
| H2b | the regeneration exemption ignores the request kind | KILLED | 5 failing unit tests |
| H2c | the regeneration exemption widens to RELEASED | KILLED | 5 failing unit tests |
| H2d | the request kind/ordinal coherence check is removed | KILLED | 5 failing unit tests |
| G5 | a RECONCILIATION_HOLD reservation is accepted | KILLED | 7 failing unit tests |
| G7 | the under-reservation check is removed | KILLED | 4 failing unit tests |
| G8 | the reservation job-identity check is removed | KILLED | 5 failing unit tests |
| G9 | stable pricing verification is no longer required | KILLED | 13 failing unit tests |
| G10 | the pricing snapshot binding re-check is removed | KILLED | 4 failing unit tests |
| G11 | a snapshot bound to another attempt is accepted | KILLED | 4 failing unit tests |
| G12 | the FX failure check is removed | KILLED | 5 failing unit tests |
| H10 | the pricing integrity verdict is ignored by the gate | KILLED | 6 failing unit tests |
| H10b | the repository stops re-deriving any persisted snapshot | KILLED | 70 failing db tests |
| H9 | the contract fingerprint check is removed | KILLED | 4 failing unit tests |
| H11 | a tampered planning cost is accepted | KILLED | 3 failing unit tests |
| H11b | a tampered stable cost is accepted | KILLED | 3 failing unit tests |
| H11c | tampered billable seconds are accepted | KILLED | 3 failing unit tests |
| H11d | a snapshot priced outside its contract's window is accepted | KILLED | 3 failing unit tests |
| H11e | the stable price reference is no longer compared | KILLED | 3 failing unit tests |
| H17 | a persisted BIGINT is narrowed before its range is checked | KILLED | 6 failing unit tests |
| H17b | an unrepresentable micro-USD amount is no longer refused | KILLED | 3 failing unit tests |
| R1 | the reservation row lock is removed | KILLED | 6 failing db tests |
| R2 | the reservation row lock is taken after the facts are read | KILLED | 6 failing db tests |
| R3 | the reservation lock no longer blocks a state-changing writer | KILLED | 6 failing db tests |
| R4b | the reservation lock is no longer tenant scoped | **SURVIVED** | 0 failing tests |
| R5b | the reservation lock targets a row that is not this attempt's | KILLED | 6 failing db tests |
| E1 | sibling exposure uses the raw persisted planning cost | KILLED | 31 failing db tests |
| E2 | an unverifiable sibling is silently skipped | KILLED | 11 failing db tests |
| E3 | an unverifiable sibling is counted as zero cost | KILLED | 11 failing db tests |
| E4 | the gate ignores the exposure verification verdict | KILLED | 6 failing unit tests |
| E5 | a definitively rejected sibling must reproduce its price | **SURVIVED** | 0 failing tests |
| H17c | the repository narrows a persisted amount without a range check | KILLED | 5 failing unit tests |
| G22 | the routing provider check is removed | KILLED | 8 failing unit tests |
| G23 | the routing provider-model-id check is removed | KILLED | 8 failing unit tests |
| G24 | the routing model-key check is removed | KILLED | 7 failing unit tests |
| G25 | the routing native-tier check is removed | KILLED | 8 failing unit tests |
| G26 | the routing audio-mode check is removed | KILLED | 7 failing unit tests |
| G27 | a HIGH_QUALITY Veo route becomes authorized | KILLED | 13 failing unit tests |
| H3 | RECONCILIATION_EXHAUSTED stops counting as uncertain exposure | KILLED | 3 failing unit tests |
| H3b | RECONCILIATION_EXHAUSTED is dropped from the persistence prefilter | KILLED | 3 failing unit tests |
| H4 | an accepted OUTPUT_VERIFIED attempt's cost is omitted | KILLED | 3 failing unit tests |
| H5 | an accepted FAILED_TERMINAL attempt's cost is omitted | KILLED | 4 failing unit tests |
| H5b | every settled attempt is dropped from the exposure total | KILLED | 11 failing unit tests |
| H6 | a definitively rejected attempt is counted as cost | KILLED | 5 failing unit tests |
| H6b | the definitively-rejected exclusion is dropped from the prefilter | KILLED | 4 failing unit tests |
| G19 | uncertain exposure is excluded from the total | KILLED | 12 failing unit tests |
| G20 | in-flight exposure is excluded from the total | KILLED | 17 failing unit tests |
| G18 | the candidate's own projected cost is excluded from exposure | KILLED | 18 failing unit tests |
| G34 | exposure aggregation stops scoping by organization | KILLED | 4 failing db tests |
| G35 | exposure aggregation stops scoping by billing cycle | KILLED | 4 failing db tests |
| G36 | the attempt chain is no longer tenant-scoped | KILLED | 4 failing db tests |
| G16 | the Safety Guard hard pause is ignored | KILLED | 9 failing unit tests |
| G17 | a Safety Guard warning becomes a hard block | KILLED | 13 failing unit tests |
| G37 | unknown billing-cycle revenue is treated as zero | KILLED | 7 failing unit tests |
| G38 | the default revenue reader invents a Standard plan | KILLED | 3 failing unit tests |
| H7 | a runtime profitability rejection is restored | KILLED | 4 failing unit tests |
| H8 | a per-scene revenue reader is restored and gates the decision | KILLED | 15 failing unit tests |
| H12b | the service bypasses the injected clock and reads wall time | KILLED | 8 failing unit tests |
| H13 | the clock is read before the cost-admission lock | KILLED | 3 failing unit tests |
| H14 | the authorization event type becomes caller-controlled | KILLED | 3 failing unit tests |
| H15 | the authorization record is not attached to the transition | KILLED | 6 failing unit tests |
| H16 | the Safety Guard state is omitted from the record | KILLED | 4 failing unit tests |
| H16b | the exposure components are omitted from the record | KILLED | 4 failing unit tests |
| H16c2 | caller metadata overrides the authorization record | KILLED | 3 failing unit tests |
| H16d | the projected profit and floors are omitted from the record | KILLED | 3 failing unit tests |
| G29 | armProviderBoundary is skipped but AUTHORIZED is returned | KILLED | 10 failing unit tests |
| G31 | the lost CAS is reported as authorized | KILLED | 3 failing unit tests |
| G32b | the customer reservation is consumed on authorization | KILLED | 7 failing db tests |
| G33 | the cost-admission lock is removed | KILLED | 5 failing db tests |

### The two survivors, and why they stay

**R4b — the tenant predicate on the reservation lock query.** Widening
`p."organizationId" = $org` to `OR TRUE` changes nothing observable, and the
reason is structural rather than a coverage gap: the lock query already pins one
row through `a."id" = $attemptId` and the attempt → request → scene → job →
reservation join, and attempt ids are unique. Tenant isolation for this
authorization is enforced a few statements later by `loadAttemptChain`, whose
own predicate **is** proven — `G36` removes it and dies against four database
tests, and a cross-tenant attempt is answered `ATTEMPT_NOT_FOUND` before the
reservation matters at all.

The predicate stays as defence in depth. Removing it would make this query's
safety depend on a *different* function keeping its predicate, which is exactly
the coupling that breaks quietly during a refactor. `R5b` proves the row being
locked is the right one: pointing the join at a reservation that is not this
job's kills against six database tests.

**E5 — the `NONE`/`KNOWN_ACTUAL` guard in the exposure loop.** Removing it
changes nothing because no row that classifies to `NONE` can reach the loop: the
SQL prefilter already excludes `DEFINITIVELY_REJECTED`, and every other `NONE`
combination requires `PRE_SUBMISSION` at a state that is not always-cost-exposed,
which the prefilter also excludes. The branch is unreachable given the current
query.

The behaviour the CTO brief asks for — a definitively rejected sibling is *not*
required to reproduce its historical price — is delivered and is tested
(`requires no snapshot reproduction from a definitively rejected sibling`), and
the exclusion carrying it is proven independently: `H6b` removes
`DEFINITIVELY_REJECTED` from the prefilter and dies against four unit tests.
The guard is kept because it fails in the safe direction — without it, a row the
prefilter ever wrongly admitted would have its cost silently *added* — and
because the classifier, not the prefilter, is the documented authority on
categories. Manufacturing a test for a branch no production path can reach would
be evidence about nothing.

### A mutation that measured the wrong thing this round

**R4** (the predecessor of `R4b`) was reported KILLED by the typechecker. That
was not evidence: dropping the `WHERE` clause left `organizationId` unused, so
TypeScript failed on an unused parameter rather than on anything about tenant
scoping. Re-aimed as `R4b`, which keeps the parameter used and neutralises only
the predicate — and then survives, for the structural reason above. **R5** was
likewise mis-aimed: joining `ON TRUE` locks a *superset* of reservations, which
is over-locking rather than a defect, so it could not fail. `R5b` locks a row
that is genuinely not this attempt's and dies.

### A test defect this round found

The first run of the reservation-race mutations took roughly 45 minutes each.
The cause was in the new tests, not the harness: on a failed assertion they left
a transaction holding the reservation row for its full 20-second budget, and
every later test's `beforeEach` cleanup then blocked behind it on the same
table. The holders now release in a `finally` and the assertion is made after
the release, so a failure is a plain failure. The same mutated suite now runs in
about ten seconds and still kills the same three tests.

### Mutations that measured the wrong thing

Three mutations in this round survived their first run, and in every case the
mutation was mis-aimed rather than the code untested. Recording them because a
survivor that turns out to be a harness bug is exactly the kind of thing a
ledger stops being useful for if it is quietly re-run until green.

**G32 — "the customer reservation is consumed on authorization."** The mutation
consumed reservations `where: { generationJobId: input.attemptId }`, and an
attempt id is not a job id, so it matched no rows and consumed nothing. Re-aimed
as **G32b** at every held reservation; it now dies against seven database tests.

**H12 — "the authorization instant becomes caller input again."** The mutation
read an optional `authorizationInstant` off the input and fell back to the
clock. No test can populate that field, because `AuthorizePaidSubmissionInput`
does not have it — the property "a caller cannot choose the time" is enforced by
the input **type**, not by a runtime branch, so no behavioural mutation of it is
observable. Manufacturing a test that casts a field into the input would be
testing the mutation rather than the code. Re-aimed as **H12b** at the
executable half of the same property — the service bypassing the injected clock
and reading wall time — which dies against eight tests, alongside the static
check that no module outside `clock.ts` calls `Date.now()`.

**H16c — "a caller may pre-seed the record's guard state."** The mutation
removed `...context.metadata` from the record, which makes the record *more*
authoritative, not less. Inverted: re-aimed as **H16c2**, moving the caller's
metadata to the end of the spread so caller values win over the audit facts.
That dies against three tests.

### Previously reported survivors, resolved

**G28b — the gate's risk-profile binding** was reported in the first submission
as a documented redundancy. It is no longer reported as a survivor because the
mutation set changed shape: the gate's pricing verification is now the full
snapshot re-derivation (`H10`, `H10b`, `H9`, `H11`–`H11e`), each of which fails
observably. The narrower binding re-check remains in place as defence in depth,
and `armProviderBoundaryWithin`'s own check is still proven independently by the
Phase 4C-3B-2E ledger (`P13`).

**N7** was re-run after the `armProviderBoundary` extraction in the previous
submission, together with the other four boundary mutations, to confirm the
refactor was behaviour-preserving: `M1r`, `M2r`, `M11r` and `N15r` all still
die, and `N7r` still survives for exactly the reason previously authorized. The
extraction is unchanged in this round.

## Verification

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass |
| `pnpm test` | Pass — 83 files, 2,117 tests |
| `pnpm build` | Pass |
| `pnpm test:db` | Pass — 17 files, 416 tests |
| Prisma drift check | `No difference detected.` |
| Database migration | **None required** — the merged Phase 4C-3B-2E schema already carries everything |
| Mutation ledger | 72/74 killed; 2 documented redundancies |

The two persisted facts this round newly reads — `SceneGenerationRequest.kind`
and `userRegenerationOrdinal` — already exist on the merged Phase 4C-3B-2E
schema, complete with the CHECK constraint that pairs them. The cost-admission
lock is a transaction-scoped advisory lock rather than a table, and the
authorization record is written into the existing
`GenerationTransitionEvent.safeMetadata` rather than into a second audit table.
Nothing here required a schema change, and none was made:
`git status packages/database/prisma/` is clean and the migration directory is
unchanged at 12.
