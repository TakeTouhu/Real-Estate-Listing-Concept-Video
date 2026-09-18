# ADR-0047 — Bounded automatic media-failure `SYSTEM_RECOVERY` admission

- Status: Accepted (Phase 4C-3B-2H-3B-6B)
- Supersedes: nothing. Consumes ADR-0045 (durable media-validation lifecycle)
  and is the opposite operational path to ADR-0046 (Transaction F).

## Context

ADR-0046 gave `VALID` its one consequence: the customer-visible delivery of a
Scene. `INVALID_MEDIA` and `INTEGRITY_MISMATCH` were left as durable terminal
verdicts with no downstream action at all — deliberately, because the decision
they imply spends money.

This phase makes that decision. A terminal media failure may cause the platform
to admit **one** bounded, automatic `SYSTEM_RECOVERY` provider attempt.

Production recovery is **not** active. Nothing constructs the runner, schedules
it, or calls it.

## Decision 1 — The same request, because this is platform failure

The customer asked once. What came back was not a usable video, which is the
platform's problem rather than a change of mind, so recovery reuses the **same**
`SceneGenerationRequest`:

```text
one SceneGenerationRequest
  -> PRIMARY attempt
  -> at most one automatic media-failure SYSTEM_RECOVERY attempt
```

No new `SceneGenerationRequest` is created, `userRegenerationOrdinal` is not
touched, and the derived regeneration entitlement is identical before and after.
A `SYSTEM_RECOVERY` attempt is not a `USER_REGENERATION` request, and conflating
them would bill a customer an entitlement for the platform's own failure.

## Decision 2 — One automatic retry, and the cap is a circuit breaker

Without a cap the shape is:

```text
output -> invalid -> recovery -> invalid -> recovery -> ...
```

The moment paid provider execution is enabled that is an automatic spending
loop with no human in it. `MAX_AUTOMATIC_MEDIA_RECOVERY_ATTEMPTS_PER_REQUEST`
is `1`, and it is not a tunable: a deployment that wants more is asking to spend
more of a customer's money without anyone deciding to.

The count is **conservative**. It counts every existing `SYSTEM_RECOVERY`
attempt under the request, not only ones this actor created, because nothing
durably records which actor admitted a given recovery. Being wrong in the
permissive direction produces the loop; being wrong in the refusing direction
costs one refused automatic retry that an operator can still handle
deliberately.

### The cap is emphatically **not** a global `SYSTEM_RECOVERY` cap

Generic attempt admission (Transaction C) may still admit later recovery
attempts sequentially once an earlier attempt has finished — that is how an
operator recovers deliberately after an incident and how reconstruction replays
a sequence. Moving this cap into Transaction C would remove that capability
silently, and the loss would be invisible until someone needed it.

`tests/integration/generic-system-recovery-not-capped.db.test.ts` exists
specifically to fail if anyone does that: it drives one request to
`PRIMARY` ordinal 1, `SYSTEM_RECOVERY` ordinal 2 and `SYSTEM_RECOVERY` ordinal 3
through the generic API, and asserts the automatic policy refuses at one in the
same breath.

## Decision 3 — Same route, exactly. No fallback

The recovery reuses the source attempt's immutable route: `providerName`,
`providerModelId`, `requestModelKey`, the customer's exact
`requestRenderedPrompt`, and the whole native-resolution decision
(`requestNativeGenerationResolution`, `requestResolutionNormalization`,
`requestNativeMeetsTarget`).

No fallback provider, no provider ranking, no inference from today's defaults,
and no re-rendering of the prompt. The promise is **"retry the same work
once"**, which is safe to do without asking anyone. **"Silently choose a
different product"** is not the same promise, costs differently, and produces a
different video — so it is a separate decision that has not been made.

## Decision 4 — A historically valid route is not automatically a safe one

Before planning, the route is revalidated against **today's** catalogs. The
model must still exist, still be `SELECTABLE`, still point at the same provider
and provider model id, still support the Job's target, and
`planGenerationResolution` must still return the same native resolution,
normalization and `nativeMeetsTarget`. Any difference is `NO_SAFE_CURRENT_ROUTE`.

Re-running under a changed catalog would silently produce *different work* than
the attempt being retried, under the same request identity.

## Decision 5 — Historical identity, current money

The source attempt's persisted pricing snapshot says which route was priced. It
does not say what that route costs now.

Nothing is copied. `estimatedStableCostMicroUsd`,
`estimatedPlanningCostMicroUsd` and `riskBufferBps` are re-derived through the
canonical pricing domain at the planning instant, because a recovery is a new
attempt that will be billed at today's rate — and because the paid authorization
gate re-derives those figures from the contract, so a copied row would fail
verification later, during an incident, which is the worst possible moment.

The new snapshot gets its own id, its own `pricingEffectiveAt`, its own
persisted row, the risk profile derived from the Job's quality tier and the
duration derived from the Scene.

### Selecting the current contract

Requiring the historical `pricingVersion` to remain current forever would make
recovery impossible after any price change. So the **five commercial
dimensions** — provider, pricing model key, generation mode, native tier, audio
mode — are what must match, and `pricingVersion` and `durationBillingRuleId` may
legitimately have moved on. The existing
`evaluatePaidSubmissionPricingEligibility` is then the authority at the planning
instant.

Exactly one eligible contract is required. Zero is `NO_SAFE_CURRENT_PRICING`;
more than one is `AMBIGUOUS_CURRENT_PRICING`, because taking the first would
silently pick a price.

## Decision 6 — Fresh FX, or no plan

The paid authorization path refuses a snapshot whose `fxSnapshotId` is null
(`PRICING_FX_SNAPSHOT_MISSING`). A recovery planned without a rate could
therefore never be armed — it would queue work nothing can ever execute. The
planner requires a valid fresh `FxSnapshot` from an injected port and otherwise
refuses with `NO_SAFE_CURRENT_PRICING`.

The port exists so this can be proven offline. **No network FX integration is
added and no rate provider is production-wired.**

## Decision 7 — One canonical parser for the persisted pricing identity

`identityJson` is a `Json` column. Prisma types it as `JsonValue`, which is
honest: the database cannot promise the seven dimensions are present, are
strings, or were written by this application at all. Casting it and reading
fields off it would let a corrupt or partially-migrated row price a **new paid
attempt**.

`parseProviderPricingIdentity` parses it, iterating the exported
`IDENTITY_DIMENSION_NAMES` so a future dimension cannot be added to the type and
silently skipped. A malformed identity is a returned failure with a closed
reason that never echoes the offending JSON.

## Decision 8 — Planning happens outside the transaction

A pricing catalog can move behind a service; an FX rate is a rate *from
somewhere*. A transaction spanning either would hold row locks across a network
call. The runner therefore plans to completion first and hands the repository a
finished `PricingSnapshot` and `FxSnapshot`.

No boundary method accepts a callback. That is structural: a repository taking a
planner is exactly how external I/O ends up inside an open transaction later.

## Decision 9 — Lock order, including the validation

```text
GenerationJob → GenerationScene → SceneGenerationRequest → source attempt → validation
```

The same high-level ordering Transaction F uses, so the two can never form a
deadlock cycle. The **request** lock is what makes the sibling count and the cap
safe: two workers holding the same terminal failure serialize before either
reads "how many recoveries exist", and it is also the lock `admitAttemptWithin`
assumes its caller already holds.

The validation row is locked last, after the attempt and before any authority is
read. A terminal verdict is effectively immutable today, so that lock is
defence-in-depth — but a transaction contract the implementation does not follow
is a comment rather than a guarantee. It deliberately returns nothing: whether a
row exists stays the authoritative read's question, so a missing, cross-tenant or
mismatched validation still fails closed through the existing outcome vocabulary
rather than through a lock result.

## Decision 10 — The verdict must describe the source attempt's bytes

`validation.receiptSha256` and `receiptSizeBytes` must equal the source
attempt's `outputSha256` and `outputSizeBytes`. A mismatch raises
`SOURCE_RECEIPT_BINDING_CONFLICT`: the receipt is not repaired, the verdict is
not changed, media validation is not re-run, and no recovery is created anyway.
A verdict about other bytes says nothing about this attempt.

## Decision 11 — Transaction C is reused, not duplicated

`admitAttemptWithin` is extracted from the generic `admit()` exactly as
`armProviderBoundaryWithin` was before it. Recovery locks its chain, re-checks
its own authority, then calls the helper — so attempt kind, attempt ordinal, the
canonical request hash, pricing and FX binding, the first `ATTEMPT` event and
the `PENDING -> GENERATING` rule all stay derived in **one** place.

The kind derives to `SYSTEM_RECOVERY` because a `PRIMARY` already exists; the
ordinal derives to the previous maximum plus one; the request stays `GENERATING`
because only a `PRIMARY` starts it. None of those is passed in.

The helper is **not** a public escape hatch. `packages/database/src/index.ts`
lists its orchestration exports explicitly rather than re-exporting the module,
so the helper is unreachable from `@app/database`, and a static regression
asserts that plus the bounded set of production call sites.

## Decision 12 — The request hash is re-derived, never copied

`computeGenerationRequestHash` runs over the facts actually being persisted. For
an unchanged route it must equal the source attempt's hash — and the test asserts
equality *and* re-derives the hash independently, rather than copying the source
value and calling that a match. A caller offering its own digest for identical
facts would walk straight past the active-request protection that stops the
platform paying twice.

## Decision 13 — No schema change

The existence of the newer `SYSTEM_RECOVERY` attempt **is** the durable
idempotency marker. No `recoveryHandledAt`, no `recoverySourceValidationId`, no
`mediaRecoveryStatus`, no counter column, no migration. The source validation
remains immutable historical evidence, and migration 12 stays newest.

## Decision 14 — Raw planning failures never escape

A planner touches a pricing catalog, a model catalog and an FX source — every
one a place a credential, a vendor URL or a raw response body can appear in an
exception. A throw is normalized to a fixed `INTERNAL_ERROR` with no cause, no
details and no original message.

The runner also *parses* the planner's return rather than trusting the type: a
structural type is a promise about a compiled call site, not about the value that
arrives. An unknown kind, a missing or null snapshot, a missing rate or a raw
refusal code all normalize to the same fixed error, so nothing surfaces later as
a `TypeError` quoting whatever the planner was holding. The repository's pricing
and FX binding checks remain the final authority for a materialized plan.

## Consequences

- A terminal media failure now has exactly one possible automatic consequence,
  and it is bounded.
- Successful admission changes **nothing** customer-facing: the request stays
  `GENERATING` with no `deliveredAt`, the Scene keeps its state and its
  delivered pointer, the Job stays `GENERATING`, and the reservation is
  untouched. Only a new attempt, its pricing snapshot and one `ATTEMPT` event
  are added.
- The paid provider boundary stays closed. The recovery attempt is `QUEUED` and
  `PRE_SUBMISSION`; no provider is called, no paid-submission authorization is
  invoked, no quota moves.
- `RECOVERY_LIMIT_REACHED` is an **operational outcome only**. Nothing is
  terminalized: the request is not failed, the Scene is not failed, the Job is
  not failed and the reservation is not released. Customer-visible failure
  semantics are Phase 6C's decision.

## Required before production activation

**Phase 6C is mandatory.** Until exhaustion and failure settlement exist, a
request whose single automatic recovery has been spent and failed again simply
stops being a candidate, with no customer-visible resolution.

### Carried-forward fairness concern

A large prefix of candidates that repeatedly produce `NO_PLAN` — an unsafe
current route, no eligible contract, no usable rate — can occupy the
oldest-first bounded sweep across repeated runs. Discovery already excludes
everything that can *never* become eligible again (spent caps, superseded
attempts, wrong states), but a `NO_PLAN` candidate is not in that category: it
may become planable when a catalog or rate card changes, so excluding it would
be wrong too.

This is not a Phase 6B blocker because the runner is dormant, Phase 6C is
mandatory before activation, and no provider call or paid side effect exists.
Phase 6C's activation design must ensure unsafe or unrecoverable failures are
settled, or otherwise cannot indefinitely starve actionable recovery work. No
schema was added in 6B for this concern.

### Carried-forward regeneration-workflow concern

Unchanged from Phase 6A: the state machine permits
`Job DELIVERABLE_READY -> REVISING -> GENERATING` and `Scene READY -> REVISING`.
Automatic recovery for a `USER_REGENERATION` requires Job `GENERATING` and Scene
`REVISING` and fails closed otherwise. The production actor that performs those
transitions must be proven to exist before activation; Phase 6B does not add it.
