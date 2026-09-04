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

**The snapshot binds its estimate to its contract.** Raised in review against
the corrected head, and a real gap: `contract` and `estimate` were independent
inputs, so an H3 Max contract could be filed with a Veo estimate and produce a
frozen record whose costs cannot be re-derived from the price it names.
`ProviderCostEstimate` now carries the contract key it was computed from, and a
mismatch throws — an audit record that cannot be re-derived is worse than none,
and a caller pairing two unrelated inputs is a defect, not an outcome.

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

Thirty-three mutations — §43's set, immutability and boundary cases, and the
seven from review — each applied to real source, gated, and restored
byte-identically. Counts are from the final run against the corrected code.

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
| C7 | the snapshot accepts an estimate from a different contract | KILLED | 1 failing test |

**33/33 killed.**

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
| `pnpm test` | Pass — 74 files, 1,779 tests (144 new) |
| `pnpm build` | Pass |
| `pnpm test:db` | Pass — 9 files, 220 tests |
| Prisma parity | `No difference detected.` |
| Schema / migration changes | **Zero** |

No network call, no environment read and no `Date.now()` anywhere in the pricing
domain; evaluation instants and FX rates are injected.

## Size — flagged, not trimmed

| | Lines |
| --- | --- |
| Production | 1,522 |
| Tests | 1,179 |
| Documentation | 284 |
| **Total changed** | **2,985** |

Raised explicitly because size is what PR #50 was rejected for. This phase's
brief set no size gate, and the head the CTO reviewed was already 2,420 total
changed lines without objection; the two correction rounds added 565 more, and
the great majority of that is test code — the full-identity lookup, the
`EpochMillis` conversion, the required floor and the snapshot binding each
needed new coverage, and the compile-time arity assertion that finally killed C5
exists only because a runtime test could not.

Nothing was cut to make this number smaller. If 2,985 is over the line for this
phase, the correct remedy is a split instruction, not quietly thinned evidence —
and the split would be clean, because the customer and provider halves share no
code.

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
