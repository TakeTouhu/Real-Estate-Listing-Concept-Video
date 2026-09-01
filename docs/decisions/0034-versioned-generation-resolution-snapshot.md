# ADR-0034: A versioned request identity, and a resolution snapshot that cannot be re-derived

- Status: Accepted
- Date: 2026-09-01
- Phase: 4C-3B-2B
- Completes: ADR-0033, which named the two resolutions and deliberately left
  persistence, request identity and model selection untouched
- Amends: ADR-0018 (immutable request snapshot) — extends the snapshot; ADR-0016
  (request identity) — versions the hash

## Context

ADR-0033 named the two things one `resolution` field had been standing for — the
**product target** a customer asked for, and the **native generation
resolution** a provider is told to produce — and stopped there deliberately. It
recorded the four places still holding the ambiguous single value as
`LEGACY_AMBIGUOUS`: `VideoProject.resolution`,
`SceneGeneration.requestResolution`, `GenerationRequestFacts.resolution` and
`ProviderGenerationInput.resolution`.

All four are persisted, hashed, or submitted. Separating them therefore changes
what a stored row means and what a request identity is, which is why it was
split out rather than folded into the catalog milestone.

It cannot be deferred further, because the catalog now contains a default model
whose 1080p deliverable is an upscale. As long as a single field exists, the
system has no way to record that the file it produced carries the requested
dimensions but not the detail — and no way to stop a later catalog correction
from silently restating what an already-approved attempt promised.

## Decision

### 1. Request identity is versioned in the stored value

`requestHash` becomes `sha256:v2:<hex>` over a twelve-element tuple:

```
assetId, compiledPrompt, durationSeconds, cameraMotion, aspectRatio,
targetOutputResolution, nativeGenerationResolution, resolutionNormalization,
nativeMeetsTarget, modelKey, providerName, providerModelId
```

V1 was `sha256:<hex>` over eight, one of which was the ambiguous `resolution`.
The same request hashes differently under the two tuples, so the two
vocabularies must stay distinguishable **in stored data**, forever. Bumping the
prefix is what makes a V1 row visibly V1 rather than a V2 row that happens to
disagree.

**No hash is ever rewritten or recomputed.** A migration that recomputed old
hashes would make every in-flight request look new, which is a duplicate
provider charge rather than a visible error.

`resolutionNormalization` and `nativeMeetsTarget` are in the tuple even though
both are derivable from today's catalog — **that is precisely why**. They are
frozen product delivery semantics. If a future catalog correction changed how a
model satisfies a 1080p request, an already-admitted attempt must not compare
equal to a new one merely because the provider id and the target string still
match; the delivery plan the customer was admitted under is part of what was
agreed.

A test pins the literal digest of a known request. Its failure means the tuple's
order or membership changed, and the correct response is almost never to update
the expected value — it is to bump the version again.

### 2. The snapshot gains five columns, all-or-none, and is never backfilled

`scene_generations` gains `requestModelKey`, `requestTargetOutputResolution`,
`requestNativeGenerationResolution`, `requestResolutionNormalization` and
`requestNativeMeetsTarget`.

For rows admitted under V1 all five stay null. **They are not backfilled**, for
the same reason ADR-0018's snapshot was not: deciding what a V1
`requestResolution` meant is exactly the ambiguity this change removes.
`generationRequestFactsFrom` fails closed on such a row.

`requestResolution` is **retained rather than dropped**. The rows carrying it
were hashed over it, so removing the column would destroy the only surviving
record of what a V1 attempt was admitted for.

Three states are forbidden, by database CHECK constraint rather than by
convention, because the constraint also binds writers that are not this
application:

- a **partially populated** V2 snapshot — it would look reconstructable and
  hash to something else;
- a row carrying **both vocabularies** — nothing says which one it was admitted
  under;
- a snapshot **disagreeing with its own hash version** — a V2 snapshot under a
  `sha256:` hash, or a V2 hash with no snapshot;
- a **blank** model key or native token. Not merely non-null: the all-or-none
  rule is satisfied by `''`, so without this a row could present a
  complete-looking snapshot naming no model and asking the provider to generate
  at nothing. Non-blank is the *only* rule on the native token — the token is
  the vendor's and this system does not parse it (ADR-0033).

The constraint keys off the hash prefix, so the row's version is a fact it
states rather than something a reader infers from which columns are populated.

### 2b. The create port is V2-only; the read port keeps history

`SceneGeneration` and `NewSceneGeneration` answer different questions, and the
first revision of this milestone conflated them. Deriving the write type from
the read type with a plain `Omit` inherited every nullable snapshot field, so
application code could still express a populated legacy `requestResolution`, a
partial V2 delivery snapshot, or a complete delivery snapshot on a row with no
compiled prompt — a row born unexecutable.

The two contracts are therefore split:

- **current create port — V2 only.** Every reconstruction fact is required, the
  five delivery facts are required, and `requestResolution` is typed as exactly
  `null`. Not `string | null` with a convention: `null` makes the legacy
  vocabulary *unwritable*, so the database's identity-version constraint agrees
  with the type instead of being the only thing enforcing it.
- **current read port — V1 + V2 history.** Unchanged and still nullable,
  because those rows record work that may have been paid for.

`requestCameraMotion` stays `string | null` on both: null there is a legitimate
request carrying no camera motion, and the hash was computed over exactly that
null. It is the one nullable field that is a value rather than an absence.

There is deliberately no legacy create method, no compatibility flag and no
union arm restoring V1 creation. A test needing a historical row seeds it
directly — raw Prisma for the database suite, a named `seedHistorical` on the
in-memory double — because that is what it is: history being restored, not an
admission being made. Thirteen compile-time assertions pin the contract, and a
mutation (M15) that loosens the type is proven to break them.

### 3. `VideoProject.targetOutputResolution` is a closed vocabulary, and the
migration fails closed

The Prisma field is renamed; the physical column stays `resolution` via `@map`,
so no data moves. A CHECK constraint restricts it to `720p` / `1080p`.

If any existing project holds a value outside that set, **the migration aborts
and the deployment stops**. It does not "clean up" the row. A project row is a
customer's stated request, and rewriting `4k` to `1080p` would change what
somebody asked for in a table that already has generations hashed against it. An
explicit pre-check raises a message naming the count and the query to run, so
the failure is actionable rather than a generic constraint violation.

The old `resolution` key is not retained as a writable alias anywhere — not on
`VideoProjectUpdate`, not on `CreateProjectInput`, not in the HTTP body, not in
the DTO. An alias would let a caller that was never updated keep setting the
ambiguous value, which is the drift this ADR removes. A client still sending
`resolution` gets a 422.

### 4. Model selection is a per-request argument, with no fallback

`GenerationService.startScene` takes an optional `modelKey`. Omitted means the
catalog default, **resolved exactly once** — reading the default twice in one
admission would let a catalog change between the two reads hash one model and
persist another.

An unknown key, or one naming an `UNVERIFIED` entry, is refused. Nothing falls
back to the default: generating on a model the caller did not ask for, and
charging them for it, is worse than refusing.

**There is deliberately no `modelKey` column on `VideoProject`.** A stored
per-project choice would let a project silently pin a model indefinitely, and
the migration would have to guess what every existing project "would have
chosen". The selection lives on the request that used it and is frozen onto the
attempt.

### 5. Execution resolves the catalog by the attempt's own frozen key

Preflight replaces the single-model capability provider with the catalog,
narrowed to `find` alone. `default()` is not on the dependency type at all,
because falling back to the default model for an attempt admitted on another one
is precisely the substitution this check exists to prevent.

Three findings are distinguished, and two refusal reasons are added, bringing
the vocabulary to sixteen:

- **`MODEL_UNAVAILABLE`** — the frozen key resolves to nothing, or to an entry
  that is no longer `SELECTABLE`. There is no contract left to compare against.
  `RETRYABLE`, on the same-identity criterion: a catalog entry restored or
  promoted from `UNVERIFIED` is exactly the world change the disposition
  describes, and the attempt's own frozen key and provider model id are
  unchanged. Nothing retries automatically.
- **`PROVIDER_IDENTITY_MISMATCH`** — the entry resolves and disagrees with the
  row about *where the request goes*. `TERMINAL`, unchanged.
- **`MODEL_DELIVERY_PLAN_CHANGED`** — the entry resolves and still points at the
  same provider request, but the catalog now declares a different delivery plan
  for the frozen target: a different native token, a different normalization, a
  different answer on `nativeMeetsTarget`, no plan for that target at all, or a
  capability that has narrowed until it no longer offers the frozen native
  token. `TERMINAL`.

**Two authorities, and the check is agreement rather than adoption.** The frozen
snapshot is the truth of what was approved; the current catalog is the authority
on whether that is still safe to execute. When they agree, the snapshot is
submitted — nothing is re-planned or re-hashed, and the prepared artifact is
byte-identical to the frozen facts. When they disagree, *neither* answer is
usable: submitting the frozen plan spends money on delivery semantics the
product no longer stands behind, and submitting the current plan executes
something the customer never approved. So preflight refuses and requires a new
admission at the current semantics.

An earlier revision of this milestone omitted the agreement check on the
grounds that "the snapshot wins". That is right about *what gets submitted* and
wrong about *whether to submit at all* — it left a corrected catalog unable to
stop an attempt admitted under the belief it superseded.

All three refuse **before any storage credential is minted**, and tests assert
that ordering — a refusal that has already signed a download URL has handed out
access for work that will never run.

### 6. The provider boundary carries the native token, and nothing else

`ProviderGenerationInput.resolution` becomes `nativeGenerationResolution`. The
WaveSpeed adapter maps it to its own wire field, which is still called
`resolution`, because an adapter's job is to speak the vendor's vocabulary
rather than export it inwards.

`PreparedGeneration` carries all four delivery facts — the target, the native
token, the normalization and `nativeMeetsTarget` — rather than collapsing them
back into one string. Only the native token is a provider input; the other three
are product facts the submission boundary must not invent for itself.

`VideoModelCapability.resolutions` is renamed `nativeGenerationResolutions`, and
`assertSettingsSupported` now compares native to native. Validating a product
target against a list of native tokens was the conflation itself: whether a model
serves a *target* is `planGenerationResolution`'s answer, not that function's.

### 7. `nativeMeetsTarget` is audited

The generation-requested audit entry gains `modelKey`, `targetOutputResolution`
and `nativeMeetsTarget`. The third is the one worth auditing: it is the
difference between a native 1080p deliverable and an upscaled one, and it must
be answerable later without re-deriving it from a catalog that may since have
changed. None of the three is customer content.

## Consequences

- Every V1 attempt is permanently unexecutable. This is the intended outcome —
  its inputs are genuinely gone — and it was already true for rows predating
  ADR-0018 and ADR-0023. Preflight classifies it as `LEGACY_SNAPSHOT_MISSING`,
  which is `TERMINAL`.
- The two derivable facts in the hash mean a catalog correction to a model's
  delivery policy makes new requests non-identical to old ones on that model.
  That is deliberate; it is not a bug to be optimized away by dropping them.
- A catalog correction to a model's delivery policy makes every already-admitted
  attempt on that model unexecutable (`MODEL_DELIVERY_PLAN_CHANGED`, terminal).
  That is the intended trade: a correction means the product was wrong about
  what it promised, and re-admitting is the honest remedy. There is no operator
  report of how many rows a given correction would strand, which is recorded as
  follow-up work.
- Nothing here enables paid execution. There is still no fal adapter, no
  verified pricing, and no paid gate. `SELECTABLE` remains selection
  eligibility, exactly as ADR-0033 defined it.
- Composition still performs no normalization. `UPSCALE` is recorded and not
  yet honoured; Phase 5 owns it, and a 1080p H3 Max deliverable is not native
  1080p until it does. Nothing in the product may describe it as such.

## Alternatives rejected

**Keep one field and interpret it per model.** The interpretation would have to
live somewhere, and it would be a function of the catalog — so a catalog change
would retroactively reinterpret stored rows. The whole point of a snapshot is
that it does not move.

**Backfill V1 rows from today's catalog.** Today's stored `720p` provably meant
"OpenVideo native 720p", but only because OpenVideo was the only model. Writing
that inference into an immutable record of a possibly-paid attempt is
fabrication, and the resulting facts would not reproduce the stored hash anyway.

**Rewrite V1 hashes to the V2 tuple.** Every in-flight request would look new.
Duplicate provider charges are the exact failure the identity exists to prevent.

**Rename the physical `resolution` column.** A larger, riskier migration that
buys nothing: the meaning is fixed by the constraint and the domain type, not by
the column name.

**Store the delivery plan on `VideoProject` instead of the attempt.** Project
settings are mutable after admission — that is why ADR-0018 exists — so a plan
stored there could change what an approved request generates at.
