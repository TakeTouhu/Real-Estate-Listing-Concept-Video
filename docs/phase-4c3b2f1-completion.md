# Phase 4C-3B-2F-1 — Completion report

The dormant paid submission authorization gate. Base:
`b613d2eb2bee8f4ad0a6d6403171dc0b4356ca6f`.

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
+ a valid RESERVED hold, coherent with the job's units
+ a pricing contract eligible on its verified stable/list price
+ a PricingSnapshot bound to this attempt, binding intact
+ NO_NEGATIVE_UNIT_ECONOMICS passes at three paid attempts
+ Safety Guard is not in HARD_PAUSE with this attempt's cost included
+ the persisted route is one the product sells
        ↓
   armProviderBoundary()  ← inside the same transaction and lock
        ↓
   SUBMITTING committed
        ↓
   AUTHORIZED
```

### Gate input — the whole of it

```ts
{ organizationId, attemptId, authorizationInstant, context }
```

Nothing else. The caller cannot supply the provider, the model, the pricing
snapshot, the contract key, the cost, the risk profile, the reserved units, the
billing cycle, the attempt state, the certainty, the quality tier, the duration,
the target resolution or the request hash — every one is loaded through the
tenant-scoped persistence graph. Two caller-controlled copies of a persisted
fact eventually disagree, and the one that decides whether to spend money is the
wrong place to find that out.

### Closed outcome union

`AUTHORIZED` · `ATTEMPT_NOT_FOUND` · `ATTEMPT_NOT_ARMABLE` ·
`RESERVATION_INVALID` · `PRICING_INELIGIBLE` · `PROFITABILITY_REJECTED` ·
`SAFETY_GUARD_HARD_PAUSE` · `ROUTING_NOT_AUTHORIZED` · `LOST_CONCURRENCY`

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
clock. It receives validated, normalized facts — never a Prisma model — which is
what makes the money-spending rule exhaustively testable without spending any,
and every branch of it deterministically mutable.

## Reservation policy

| State | Authorizes a new paid attempt? |
| --- | --- |
| `RESERVED` | **yes** |
| `RESERVING` | no — the hold is not established yet |
| `CONSUMED` | no — the units are already spent on delivered work |
| `RELEASED` | no — nothing is held to pay for this |
| `RECONCILIATION_HOLD` | no — the uncertainty that caused the hold is unresolved |

Identity and coherence are checked as well: the reservation must belong to this
attempt's job, `reservedTotalVideoUnits` must equal `job.requiredVideoUnits`, and
`reservedHighQualityUnits` must equal `job.requiredHighQualityUnits` **in both
directions**. High quality marks units already reserved and never adds any, so a
hold claiming more or fewer is incoherent either way.

Nothing here converts a reservation state, and nothing consumes quota.

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

## Profitability policy

`NO_NEGATIVE_UNIT_ECONOMICS`, via the existing `evaluateUnitEconomics`. No
margin arithmetic is reimplemented.

The worst case is the contractual maximum for one scene —
`worstCaseSceneProviderCostYen`, three paid attempts: the initial generation
plus the two user regenerations the entitlement sells. That is a count of paid
*provider attempts* derived from frozen policy, not a stored counter and not the
number of attempt rows that happen to exist, which would let a provider outage
make a scene look unsellable.

**Only negative blocks.** A gross margin below the 75% target or the 70% floor
is an internal pricing review, never a refusal to render work a customer already
bought. `PROFITABILITY_TARGETS` is read by nothing in the gate, and a test
proves a 9.6% margin still authorizes. Break-even authorizes too: refusing a
configuration that exactly covers its costs would be a different rule than the
one that was frozen.

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

totalProviderCostExposure = knownActualCost
                          + uncertainCost
                          + inFlightCost
                          + nextProjectedCost   ← the candidate's own
```

### Exposure categories

One canonical module owns the state sets; no repository writes its own list. The
three are disjoint by construction, asserted by test — an attempt contributes to
exactly one, so nothing double-counts and nothing is silently dropped.

| Category | States | Why |
| --- | --- | --- |
| **Known actual** | *(empty)* | Nothing persists what a provider actually billed |
| **Uncertain** | `RECONCILIATION_PENDING` | May already have been billed; carried until reconciliation says otherwise |
| **In-flight** | `SUBMITTING`, `PROCESSING`, `PROVIDER_SUCCEEDED`, `OUTPUT_INGESTING` | At or past the boundary with an unfinished cost lifecycle |

`SUBMITTING` counts from the instant the boundary commits, before any HTTP call:
an attempt that crashed mid-POST is indistinguishable from one that never sent,
and the difference is a charge.

`OUTPUT_VERIFIED`, `FAILED_TERMINAL`, `FAILED_RETRYABLE`,
`CANCELLED_PRE_SUBMISSION` and `RECONCILIATION_EXHAUSTED` are absent — the first
four have finished their cost lifecycle or never crossed the boundary, and the
last is terminal after reconciliation ran out of ways to find out. Holding it as
"uncertain" forever would pause an organization with no path to release.

Each attempt is valued at **its own immutable planning snapshot**, converted
through **its own persisted `FxRateSnapshot`** via the canonical
`validateFxSnapshot` / `convertMicroUsdToYen` path. No live FX, no default rate:
a missing or invalid rate fails the gate closed, including when it belongs to
some *other* attempt's exposure, because a total known to be short must not
authorize anything.

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

### Same organization and billing cycle

A PostgreSQL **transaction-scoped advisory lock** keyed on
`(hashtext("paid-submission:<orgId>"), hashtext("cycle:<cycleKey>"))`, taken
before any fact is read and held until commit. Two authorizations for one
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

**Lock ordering.** This is the outermost lock in the system. The Phase 4C-3B-2E
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

## Audit

The existing `GenerationTransitionEvent` mechanism, not a second audit table.
For an authorized attempt the `QUEUED → SUBMITTING` transition event is the
authoritative boundary record, written atomically with the state change.

**A rejected gate writes nothing.** The attempt stays `QUEUED` with no
`submissionBoundaryEnteredAt` and no new event: a refusal discovered nothing
about the provider, so a transition event would be history for a state change
that did not happen. Asserted by test.

## What this phase does not do

No real fal POST, no Veo POST, no new WaveSpeed paid orchestration, no polling,
no reconciliation worker, no stale-`SUBMITTING` recovery, no output ingestion,
no composition, no upscale, no entitlement consumption, no payment gateway, no
Stripe, no add-on purchasing, no UI.

The authorization service has **no provider dependency and performs no network
call**, proven two ways: a static check over its own source for transport
imports and call syntax, and a runtime check that drives a complete
authorization with `fetch`, `XMLHttpRequest` and `WebSocket` replaced by
throwing stubs.

`SUBMISSION_UNKNOWN` can never re-arm — no reset to `QUEUED`, no second POST, no
new invocation on the same attempt. Stale `SUBMITTING` is never treated as
permission to try again; recovery is a later reconciliation phase.

## Production activation prerequisites

The gate is dormant and, with the shipped readers, authorizes **nothing at all**.
Before any real paid submission:

1. **Re-verify current provider prices immediately before activation.** This
   phase operates against the persisted/catalogued verified contract for
   deterministic tests; it does **not** complete the production price
   re-verification requirement.
2. **Resolve the authoritative billing-cycle revenue source.** Nothing persists
   a subscription, plan assignment or invoice. `BillingCycleRevenueReader` and
   `SceneRevenueReader` are ports, and the shipped implementations return `null`,
   which fails closed. Assuming Standard would hard-pause an Enterprise customer
   at a quarter of their real threshold; deriving a plan from seats or usage
   would invent a commercial fact from operational data.
3. **Confirm the canonical production routing source for `providerModelId`.**
   One string is duplicated between `@app/domain` and `@app/video-providers`
   under test-enforced parity; a single authority at the correct dependency level
   would be better.
4. **Implement the provider-outcome persistence path** that would populate known
   actual cost. Until it exists the Safety Guard runs on planning estimates
   alone, and the known-actual category is structurally empty.
5. **Enable provider credentials only in Phase 4C-3B-2F-2**, and wire a concrete
   provider only after separate CTO authorization.
6. **Retain `SUBMISSION_UNKNOWN` no-re-POST semantics** through every later
   reconciliation and recovery phase.

## Mutation ledger — 37/38 killed

Every mutation targets an executed artefact: the pure gate, the routing table,
the exposure sets, the authorization service, its default revenue readers, or
the persistence that feeds them. Each removes exactly one rule the gate is
supposed to enforce.

| ID | Mutation | Result | Detected by |
| --- | --- | --- | --- |
| G1 | the QUEUED requirement is removed | KILLED | 14 failing unit tests |
| G2 | the PRE_SUBMISSION requirement is removed | KILLED | 7 failing unit tests |
| G3 | SUBMISSION_UNKNOWN becomes armable | KILLED | 5 failing unit tests |
| G4 | the reservation requirement is removed | KILLED | 4 failing unit tests |
| G5 | a RECONCILIATION_HOLD reservation is accepted | KILLED | 5 failing unit tests |
| G6 | a CONSUMED reservation is accepted | KILLED | 4 failing unit tests |
| G7 | the under-reservation check is removed | KILLED | 4 failing unit tests |
| G8 | the reservation job-identity check is removed | KILLED | 4 failing unit tests |
| G9 | stable pricing verification is no longer required | KILLED | 10 failing unit tests |
| G10 | the pricing snapshot binding re-check is removed | KILLED | 4 failing unit tests |
| G11 | a snapshot bound to another attempt is accepted | KILLED | 4 failing unit tests |
| G12 | the FX failure check is removed | KILLED | 5 failing unit tests |
| G13 | the profitability rejection is removed | KILLED | 5 failing unit tests |
| G14 | the 70% margin target becomes a hard block | KILLED | 5 failing unit tests |
| G15 | the worst case is priced at one attempt instead of three | KILLED | 5 failing unit tests |
| G16 | the Safety Guard hard pause is ignored | KILLED | 7 failing unit tests |
| G17 | a Safety Guard warning becomes a hard block | KILLED | 6 failing unit tests |
| G18 | the candidate's own projected cost is excluded from exposure | KILLED | 11 failing unit tests |
| G19 | uncertain exposure is excluded | KILLED | 3 failing unit tests |
| G20 | in-flight exposure is excluded | KILLED | 3 failing unit tests |
| G21 | an attempt is counted as both uncertain and in-flight | KILLED | 3 failing unit tests |
| G22 | the routing provider check is removed | KILLED | 8 failing unit tests |
| G23 | the routing provider-model-id check is removed | KILLED | 8 failing unit tests |
| G24 | the routing model-key check is removed | KILLED | 7 failing unit tests |
| G25 | the routing native-tier check is removed | KILLED | 8 failing unit tests |
| G26 | the routing audio-mode check is removed | KILLED | 7 failing unit tests |
| G27 | a HIGH_QUALITY Veo route becomes authorized | KILLED | 3 failing unit tests |
| G28b | the risk-profile binding is removed from the fact loader | **SURVIVED** | 0 failing tests |
| G29 | armProviderBoundary is skipped but AUTHORIZED is returned | KILLED | 8 failing db tests |
| G30 | AUTHORIZED is returned before the SUBMITTING commit | KILLED | 4 failing db tests |
| G31 | the lost CAS is reported as authorized | KILLED | 3 failing unit tests |
| G32 | the customer reservation is consumed on authorization | KILLED | 7 failing db tests |
| G33 | the cost-admission lock is removed | KILLED | 5 failing db tests |
| G34b | exposure aggregation stops scoping by organization | KILLED | 4 failing db tests |
| G35b | exposure aggregation stops scoping by billing cycle | KILLED | 4 failing db tests |
| G36 | the attempt chain is no longer tenant-scoped | KILLED | 4 failing db tests |
| G37 | unknown billing-cycle revenue is treated as zero | KILLED | 4 failing unit tests |
| G38 | the default revenue reader invents a Standard plan | KILLED | 3 failing unit tests |

### Three mutations that measured the wrong thing

**G31 survived its first run** — reporting a lost compare-and-set as
`AUTHORIZED` was not caught. The reason is a genuine consequence of the design
rather than a missing assertion: with the cost-admission lock in place, two
in-process authorizations are serialized, so the second re-reads and refuses on
`ATTEMPT_ALREADY_SUBMITTED` long before its CAS could lose. The `LOST` arm is
still real — the repository's public `armProviderBoundary` is a writer outside
the lock discipline — so it is now exercised directly at the service level,
where the mutation dies against three tests.

**G34 and G35 were killed by the typechecker, which was a false signal.** The
failure came from an unrelated narrowing bug in a test file I had just added,
not from the mutation. Both were re-run after fixing it and **survived**: the
tenant- and cycle-scoping tests used revenue generous enough to absorb the
exposure they were supposed to notice, so they passed whether or not the scope
existed. The amounts are now tight — ¥117 of headroom above the ¥15,000 floor —
and **G34b** and **G35b** each die against four database tests.

### The one survivor

**G28b — the risk-profile binding in the fact loader.** The gate re-checks that
the persisted snapshot's risk profile matches the job's quality tier, and
`armProviderBoundaryWithin` checks the same thing from the same stored row a few
statements later through `checkPricingBinding`. Removing the gate's copy
therefore changes no observable behaviour: the corruption is still refused, with
the same outcome and the same reason, by the boundary. The Phase 4C-3B-2E ledger
already proved the boundary's check independently (`P13`), and an integration
test here proves the property holds end to end.

It is kept as defence in depth — the gate loads facts under the cost lock and the
boundary re-reads them, and a future refactor that moved either could otherwise
leave neither. Manufacturing a test for a mutation that corresponds to no
reachable failure would be evidence about nothing, which is the same judgement
recorded for `N7` in Phase 4C-3B-2E.

`N7` itself was re-run after the `armProviderBoundary` extraction, together with
the other four boundary mutations, to confirm the refactor was behaviour-
preserving: `M1r`, `M2r`, `M11r` and `N15r` all still die, and `N7r` still
survives for exactly the reason previously authorized.

## Verification

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass |
| `pnpm test` | Pass — 82 files, 2,065 tests |
| `pnpm build` | Pass |
| `pnpm test:db` | Pass — 17 files, 379 tests |
| Prisma drift check | `No difference detected.` |
| Database migration | **None required** — the merged Phase 4C-3B-2E schema already carries everything |
