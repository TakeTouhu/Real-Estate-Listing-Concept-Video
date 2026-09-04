# Phase 4C-3B-2D — Completion report

Pricing contract hardening. Base: `4019cc8830fb28267f990e1ec0527fe4f45f0384`.

Pure domain contracts only. No billing, no payment, no reservation persistence,
no provider execution, no customer charge, and no migration.

## The separation this phase exists for

Provider cost and customer price are different facts with different owners, and
they now live in different modules with no path between them. A vendor changing
its rate card cannot move a customer's price or entitlement, because no customer
function reads a provider price and no provider function reads a plan.

| Concern | Module |
| --- | --- |
| Customer plans, seats, units, add-ons | `customer-plan-catalog.ts`, `customer-pricing.ts` |
| Provider identity, verification, billing algebra | `provider-pricing-contract.ts`, `provider-pricing-catalog.ts` |
| Cost estimation and FX | `provider-cost-calculator.ts` |
| Paid-submission pricing eligibility | `pricing-eligibility.ts` |
| Immutable decision record | `pricing-snapshot.ts` |
| Commercial safety | `profitability.ts`, `safety-guard.ts` |

All of it sits in `@app/domain`, which depends only on `@app/shared`. Provider
adapters own no commercial policy — the dependency runs the other way, so they
structurally cannot.

## Money is integer, always

Nothing stores `0.08`, `1.2` or `0.05`. Provider amounts are micro-USD, customer
amounts are whole yen, and every rate is basis points. The three are distinct
nominal types, so a provider cost added to a customer price is a compile error
rather than a plausible number.

`mulDiv` computes `value × numerator / denominator` with a `BigInt` product and
rounds half away from zero. `BigInt` because an annual Enterprise contract times
a multiplier already exceeds 3.5×10¹², and "still fits a double" is not a
property to depend on when the failure mode is a silently wrong price.

## Frozen values encoded

| | Value |
| --- | --- |
| Standard / Premium / Enterprise | ¥49,800 / ¥119,800 / ¥298,000 monthly ex tax |
| Included users | 3 / 10 / 30 |
| Included video units | 15 / 40 / 100 |
| Included high-quality units | 1 / 5 / 10 (inside the total, never beside it) |
| Additional seat | ¥3,000/month ex tax, all plans |
| Annual prepayment discount | 500 bps |
| Add-on multipliers | 12,000 bps normal, 15,000 bps high quality |
| Risk buffers | 3,000 bps normal AI, 5,000 bps high-quality AI |
| H3 Max stable | 80,000 micro-USD/billable second |
| Veo 3.1 Fast stable | 100,000 micro-USD/billable second, durations 4/6/8, billed through **fal** |
| WaveSpeed OpenVideo 1080p stable | 60,000 micro-USD/billable second, 3–20 seconds inclusive |

## Corrections applied after CTO review

**Lookup uses the complete identity.** `find(provider, pricingModelKey)` is gone.
A contract is addressed by all seven dimensions — provider, pricing model,
generation mode, native tier, audio mode, billing rule and pricing version —
collapsed into one opaque escaped key, so the 1080p audio-on price can never be
returned for a 768P audio-off request. Duplicate keys fail at module load rather
than at the first mispriced request.

**Veo 3.1 Fast is billed through `fal`.** The model is Google's; the invoice is
fal's, and a pricing contract names whoever charges. `google-veo` appears
nowhere.

**OpenVideo bills 3–20 seconds inclusive**, not 1–20.

**Instants are `EpochMillis`, not `Date`.** `Object.freeze` protects a
reference, not the object behind it, so every frozen contract and snapshot was
still handing out something `setTime` could rewrite. Stored instants are now
integers, which no consumer can mutate through either the caller's original
value or the one the snapshot exposes.

**The profitability floor is required.** The `= yen(0)` default made the
commercial rule opt-in. Rounding now happens in exactly one place —
`finalizeCustomerPrice`, which takes the floor positionally — and both add-ons
and annual prepayment go through it. `annualContractRawPricing` returns exact
figures only and has no rounded field to bypass it with.

**The snapshot derives everything from one calculation.** This went through two
rounds. Review first found that `contract` and `estimate` were independent
inputs, so an H3 Max contract could be filed with a Veo estimate; the first fix
gave `ProviderCostEstimate` a `contractKey` and threw on a mismatch. The CTO
then established that identity matching was necessary but not sufficient — two
contracts can share all seven identity dimensions and still differ in stable
price, verification state, duration policy or effective window, and separately
an estimate's `riskProfileKey` could contradict a hand-supplied
`riskBufferBps`.

Both classes are now gone rather than detected. `createPricingSnapshot` takes
`{ contract, riskProfile, requestedSeconds, pricingEffectiveAt, fx? }` and runs
the same `estimateProviderCost` ordinary pricing uses. There is no `estimate`
input and no `riskBufferBps` input, so there is nothing left that can disagree.
It returns a `PricingResult` rather than throwing, because the remaining
failures — a promotional-only contract, an ungeneratable duration, an unusable
rate — are ordinary outcomes a caller must handle.

The snapshot also records a **contract fingerprint**: a canonical encoding of
every price-changing field, not just the identity. That is what lets an auditor
prove *which* same-identity contract produced a record. Exact text rather than a
digest — a hash buys brevity and pays in collisions and a dependency, and an
audit field is not length-constrained.

**Invalid FX rates fail closed.** `FxSnapshot` was checked only for currency
direction. A zero numerator converts every provider cost to ¥0 and a negative
one makes it negative — both *improve* every margin, so the corruption is
invisible exactly where a margin review looks. A zero denominator was worse
than wrong: it reached `mulDiv` and threw, making a bad input an unhandled
defect. `validateFxSnapshot` now requires both components to be positive safe
integers, returning `FX_SNAPSHOT_RATE_INVALID`, and the snapshot refuses to name
a rate it could not validate.

**Stable and promotional verification are separate fields.** One shared
verification state forced a single answer to two questions, so a perfectly good
list price became ineligible merely because a discount also existed. A contract
can now carry a verified stable rule *and* a live verified promotion: it is
eligible, and plans against the stable rule. A promotion alone is still
insufficient.

## Decisions worth reviewing

**No H3 Max promotion record exists.** The launch rate is $0.02/sec, and the
type system can represent a promotion — but its exact effective window is not
known, and a promotion with an invented end date is indistinguishable from a
permanent price at planning time. An absent record refuses; a guessed one plans
against fiction. The stable $0.08 is the only planning base.

**Add-ons are priced as one fraction.** `planPrice × multiplier × quantity ÷
(includedUnits × 10,000)`, never a rounded per-unit price times a count.
Premium's high-quality unit is ¥4,492.5 exactly: round it first and two units
come to ¥8,986 or ¥8,984 against a true ¥8,985.

**Rounding cannot create a loss.** Nearest-¥100 can move a price down, so the
order is raw → validate → round → re-validate → final. A rounded candidate below
the profitability floor is replaced by the next ¥100 up, and if that is still
below the floor the package is refused rather than quoted at a loss.

**Eligibility refuses by default.** Missing, unverified, expired, not-yet-
effective and promotional-only pricing are all refused, and a closed effective
window expires a contract regardless of its stored label — the label can lag,
the clock cannot. Eligibility is a pricing answer only: Veo has a verified rate
card and no adapter, and a price cannot make a model runnable.

**Worst case, not average.** Profitability evaluates three paid attempts — the
contractual maximum — because the observed 1.25 average is a KPI. Pricing
against the average means every customer who uses what they were sold is a loss.
`isNegativeUnitEconomics` is true only *below* zero; break-even is not a loss.

**Safety Guard is strictly "below".** Profit exactly at a floor is the last
acceptable value, not the first unacceptable one. It classifies abnormal cost
and blocks nothing: normal entitlement must not be denied because a month was
thin.

## Mutation ledger

Forty-four mutations — §43's set, immutability and boundary cases, the review
corrections, and the snapshot-binding and FX groups from the final round — each
applied to real source, gated, and restored byte-identically. Counts are from
the final run against the corrected code.

C7 is absent from the table, and deliberately. It mutated the identity-only
mismatch check, and that check no longer exists: the CTO's correction removed
the inputs it guarded rather than strengthening it, so there is nothing left to
disable. The property it protected is now carried by S8, which is stronger —
S8 re-adds an `estimate` input and is killed at compile time, whereas C7 could
only catch a mismatch that had already been constructed.

| ID | Mutation | Result | Detected by |
| --- | --- | --- | --- |
| P1 | normal risk buffer 30% → 0% | KILLED | 6 failing tests |
| P2 | normal risk buffer 30% → 50% | KILLED | 6 failing tests |
| P3 | high-quality risk buffer 50% → 30% | KILLED | 3 failing tests |
| P4 | planning cost selects the promotional rule | KILLED | 1 failing test |
| P5 | UNVERIFIED pricing becomes eligible | KILLED | 2 failing tests |
| P6 | EXPIRED pricing becomes eligible | KILLED | 2 failing tests |
| P7 | promotional-only pricing becomes eligible | KILLED | 1 failing test |
| P8 | H3 Max planning base becomes $0.02 | KILLED | 8 failing tests |
| P9 | cost uses requested rather than billable duration | KILLED | 1 failing test |
| P10 | normal add-on multiplier 1.20 → 1.00 | KILLED | 2 failing tests |
| P11 | high-quality add-on multiplier 1.50 → 1.20 | KILLED | 3 failing tests |
| P12 | annual discount 5% → 0% | KILLED | 4 failing tests |
| P13 | Standard high-quality add-on becomes allowed | KILLED | 1 failing test |
| P14 | nearest-100 rounding → floor-100 | KILLED | 1 failing test |
| P15 | add-on rounds an intermediate per-unit price | KILLED | 1 failing test |
| P16 | unsafe downward rounding accepted | KILLED | 4 failing tests |
| P17 | NO_NEGATIVE_UNIT_ECONOMICS disabled | KILLED | 3 failing tests |
| P18 | break-even treated as a loss | KILLED | 1 failing test |
| P19 | contractual attempts 3 → 1 | KILLED | 2 failing tests |
| P20 | Safety Guard "below" → "at or below" | KILLED | 6 failing tests |
| P21 | every billing rule treated as per-second | KILLED | 2 failing tests |
| P22 | discrete billable duration rounds down | KILLED | 5 failing tests |
| P23 | video units 30s → 60s per unit | KILLED | 6 failing tests |
| P24 | high-quality stops consuming high-quality units | KILLED | 1 failing test |
| P25 | customer catalog stops being deeply frozen | KILLED | 1 failing test |
| P26 | provider catalog stops being deeply frozen | KILLED | 3 failing tests |
| C1 | lookup falls back to provider + model only | KILLED | 2 type errors |
| C2 | Veo attributed to `google-veo` instead of `fal` | KILLED | 14 failing tests |
| C3 | WaveSpeed minimum duration 3 → 1 | KILLED | 3 failing tests |
| C4 | snapshot stores a mutable `Date` | KILLED | 2 failing tests |
| C5 | the safety floor becomes optional again | KILLED | 2 type errors |
| C6 | a verified stable price is refused whenever a promotion exists | KILLED | 1 failing test |
| S1 | the snapshot's risk buffer stops coming from the risk profile | KILLED | 13 failing tests |
| S2 | the snapshot's risk profile key is hardcoded | KILLED | 1 failing test |
| S3 | the fingerprint omits the stable rule | KILLED | 2 failing tests |
| S4 | the fingerprint omits the billable duration policy | KILLED | 2 failing tests |
| S5 | the fingerprint omits the effective window | KILLED | 1 failing test |
| S6 | the fingerprint omits the stable verification state | KILLED | 1 failing test |
| S7 | a failed cost estimate stops being returned as a refusal | KILLED | 1 failing test |
| S8 | an independent estimate input is re-added | KILLED | 2 type errors |
| X1 | the positive-numerator check is removed | KILLED | 5 failing tests |
| X2 | the positive-denominator check is removed | KILLED | 3 failing tests |
| X3 | the safe-integer requirement on the rate is removed | KILLED | 6 failing tests |
| X4 | the snapshot stops validating the FX rate it records | KILLED | 1 failing test |

**44/44 killed.**

Two survived on their first run, and both exposed real gaps rather than noise.
**P7** survived because rewriting the promotional-only fixture to `UNVERIFIED`
removed the only case where the stable *label* said verified while the rule was
`null`; that case is now tested directly. **C5** survived because every runtime
test passes a floor explicitly, so re-adding a default changed nothing
observable — an optional parameter is invisible to a caller that always supplies
it. It is now pinned by a compile-time arity assertion, which is the only thing
that can hold requiredness.

## Verification

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass |
| `pnpm test` | Pass — 74 files, 1,802 tests (167 pricing) |
| `pnpm build` | Pass |
| `pnpm test:db` | Pass — 9 files, 220 tests |
| Prisma parity | `No difference detected.` |
| Schema / migration changes | **Zero** |

No network call, no environment read and no `Date.now()` anywhere in the pricing
domain; evaluation instants and FX rates are injected.

## Size — flagged, not trimmed

| | Lines |
| --- | --- |
| Production | 1,690 |
| Tests | 1,435 |
| Documentation | ~355 |
| **Total changed** | **around 3,480** |

Production and test counts are exact. The documentation figure is approximate on
purpose: this section is part of what it measures, so every attempt to state the
total precisely changed it. The exact number at any given commit is
`git diff --numstat 4019cc88..HEAD`.

Recorded rather than managed. The CTO has accepted the phase size and directed
that PR #53 not be split solely to reduce the diff, and that no test or
documentation be removed for that purpose — so nothing was. Three correction
rounds took it from 2,420 to roughly 3,480, and the growth is predominantly
contract tests: the full-identity lookup, the `EpochMillis` conversion, the
required floor, the snapshot binding and the FX rules each needed coverage, and
two of the properties (a required parameter, an absent input) can only be held
by compile-time assertions because no runtime test can observe them.

## Paid gate — still blocked

`VIDEO_PROVIDER` remains `z.enum(["fake", "wavespeed"])`. No `FAL_API_KEY` or
`FAL_KEY`, no fal factory branch, no Veo provider or execution path, no payment
gateway, no pricing-driven submission gate, no automatic charge or add-on
purchase. `packages/video-providers` has **zero** changes to its types, ports,
adapters, catalog or factory — submission certainty and `SUBMISSION_UNKNOWN`
semantics are byte-identical. H3 Max keeps `pricing: null` in the model catalog,
and every model's selectability and verification state is untouched.

## Architecture conflict encountered

One, resolved conservatively. `deepFreeze` lived in `@app/video-providers`, but
the pricing domain needs the same discipline and `@app/domain` cannot import
that package — the dependency runs the other way. It moved to `@app/shared` with
a re-export shim left behind, which is the pattern this repository already used
for `wavespeed/http.ts`. No caller changed and no behaviour changed; the
alternative was a second copy of "frozen means frozen all the way down", and two
copies eventually disagree.

## Known limitations

- **Pricing verification is documentary, not observed.** Every rate here comes
  from published material; none was confirmed against a live API, and no call is
  authorized. All of it must be re-verified before any paid path opens.
- **Nothing consumes these contracts.** No orchestration, entitlement ledger or
  submission gate reads them yet, so the pricing domain is enforced by the
  compiler and its tests and by no runtime path.
- **Add-on package sizes are not encoded**, deliberately: they are not frozen,
  so the calculator takes a requested quantity.
- **Security/Procurement Review Support has no price**, and none was invented.
- **No ADR was written.** The decisions here were frozen by the CTO rather than
  taken during implementation, and the brief did not request one. If a durable
  decision record is wanted, it should be authorized separately.
