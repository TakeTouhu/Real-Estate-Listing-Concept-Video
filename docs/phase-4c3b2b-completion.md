# Phase 4C-3B-2B — Versioned request identity and the resolution snapshot

Milestone: Phase 4C-3B-2B
Base: `9e530504b8098c3093eecc8140d36094067f8a42` (merged Phase 4C-3B-2A, PR #48)
Decision record: ADR-0034

> This report is an immutable technical snapshot and carries no lifecycle
> status. The GitHub pull request is the authoritative lifecycle source.

## Size — final, and covered by a one-time CTO exception

Measured from the final reviewed head against base
`9e530504b8098c3093eecc8140d36094067f8a42`.

| Scope | Insertions | Deletions | Total |
| --- | ---: | ---: | ---: |
| Production TypeScript | 840 | 123 | 963 |
| Tests | 2,048 | 221 | 2,269 |
| Migration SQL + Prisma schema | 168 | 2 | 170 |
| Documentation (`docs/`, `CHANGELOG.md`) | 1,205 | 30 | 1,235 |
| **Code + tests + migration** | 3,056 | 346 | **3,402** |
| **Everything** | 4,261 | 376 | **4,637** |

**The CTO has granted a one-time size exception for Phase 4C-3B-2B / PR #49.**
The milestone's original ceiling was ≤1,600 with a hard stop above 1,900; the
correction envelope was subsequently raised to 3,450 code-and-tests and 4,700
overall, and the values above are within it. The exception was granted because
the excess is predominantly **required test and documentation evidence** rather
than feature scope: production TypeScript is 963 changed lines against 2,269 of
tests.

**This exception is specific to this milestone and is not precedent for any
later one.** The code + tests + migration total of **3,402** is frozen.

### Why the authorized split would not have helped

The pre-authorized split was 3B-2B-1 (domain/persistence/identity) and 3B-2B-2
(API/UI naming). Measured on the finished work at the time it was proposed, the
API/UI half was **215** changed lines and the domain half **2,683** — the second
still well over the hard stop on its own. The split would have produced one
compliant milestone and one that was not, which is why an exception was the
better answer than an artificial division.

A split that *would* have worked exists — separating request-identity V2 from
model selection and the catalog-drift gate — but it is a different decomposition
from the one authorized, and the work was already complete when that became
apparent.

### Where the evidence went

Most of the test volume was mandated by the milestone brief: §32 (per-fact hash
regression), §33 (the legacy matrix), §34 (the model-selection matrix against
the real catalog), §35 (the provider-boundary regression), and the migration-text
regressions §6 and §19 require. The §36 mutation ledger then found three places
where that evidence was not yet discriminating, and closing those added more.
Technical review added the V2-only create contract with its thirteen
compile-time assertions and two current-write regressions.

## What shipped

### 1. Request identity V2

`requestHash` is now `sha256:v2:<hex>` over a twelve-element tuple:

```
assetId, compiledPrompt, durationSeconds, cameraMotion, aspectRatio,
targetOutputResolution, nativeGenerationResolution, resolutionNormalization,
nativeMeetsTarget, modelKey, providerName, providerModelId
```

V1 was eight elements, one of which was the ambiguous `resolution`. The prefix
carries the version so a V1 row stays visibly V1 in stored data forever.

`resolutionNormalization` and `nativeMeetsTarget` are in the tuple **although
both are derivable from today's catalog** — that is the reason they are there.
They are frozen delivery semantics: a catalog correction must not make an
already-admitted attempt compare equal to a new one merely because the provider
id and the target string still match.

No stored hash is rewritten. No V1 snapshot is backfilled.

### 2. The V2 snapshot, all-or-none, never backfilled

`scene_generations` gains `requestModelKey`, `requestTargetOutputResolution`,
`requestNativeGenerationResolution`, `requestResolutionNormalization` and
`requestNativeMeetsTarget`. `requestResolution` is **kept** — V1 rows were
hashed over it, so it is their only surviving record — and never written again.

`generationRequestFactsFrom` refuses four distinct states, all with the same
neutral message that names no id, hash, prompt, model key or provider detail:

| State | Why it refuses |
| --- | --- |
| V1 row (all five null) | The V2 delivery semantics required for safe execution cannot be proven from a V1 row without reinterpreting historical data. |
| Partial V2 snapshot | Corruption, not a legacy record — and it would hash to something else. |
| Both vocabularies present | Nothing says which one it was admitted under. |
| V2 snapshot under a `sha256:` hash | The row's own prefix says which tuple produced it. |

The database enforces the same three prohibitions by CHECK constraint, because
a convention does not bind a writer that is not this application.

### 3. `VideoProject.targetOutputResolution`, closed at every boundary

Renamed in the Prisma model, mapped onto the existing physical `resolution`
column, so no data moves. Constrained to `720p` / `1080p` in the database, in
the domain type, in `createProject`, at the HTTP boundary, and in the UI
control.

**The old key survives nowhere as a writable alias** — not on
`VideoProjectUpdate`, `CreateProjectInput`, the request body, or the DTO.

### 4. Model selection, with no fallback

`startScene(actor, org, project, scene, modelKey?)`. Omitted means the catalog
default, read **exactly once**. Unknown key and `UNVERIFIED` entry are both
refused, and neither reads the default — asserted, because a fallback added
later would be invisible otherwise.

There is no `modelKey` column on `VideoProject` and no HTTP or UI caller yet.

### 4b. The create port is V2-only

`SceneGeneration` describes every row the system can **read**, history included.
`NewSceneGeneration` describes what this application may **write** today, and
the first revision conflated them: a plain `Omit` inherited every nullable
snapshot field, so a populated legacy `requestResolution`, a partial V2
snapshot, or a complete delivery snapshot on a row with no compiled prompt were
all still expressible.

The write type now requires every reconstruction fact and all five delivery
facts, and pins `requestResolution` to exactly `null` — not `string | null` with
a convention. That makes the legacy vocabulary *unwritable*: with the type
narrowed, the M7 mutation (write the legacy column on a V2 row) is a **compile
error** rather than something only the database and a test would catch.

`requestCameraMotion` stays `string | null`, because null there is a legitimate
request carrying no camera motion and the hash was computed over exactly that.

There is no legacy create method, no compatibility flag and no union arm. Tests
needing a historical row seed it directly — raw Prisma in the database suite, a
named `seedHistorical` on the in-memory double — because that is history being
restored, not an admission being made.

Thirteen compile-time assertions in
`packages/domain/src/generation/new-scene-generation-contract.test.ts` pin the
contract in both directions, including that the **read** shape stays nullable so
historical rows remain representable.

### 5. Execution resolves by the attempt's frozen key

`ExecutionPreflightDeps.capabilities` becomes `models: Pick<VideoModelCatalog,
"find">`. `default()` is not on the type, so substituting the deployment's
current default for an attempt admitted on another model is a compile error
rather than a comment.

Two refusal reasons are added, taking the vocabulary to sixteen:

| Reason | Finding | Disposition |
| --- | --- | --- |
| `MODEL_UNAVAILABLE` | The frozen key resolves to nothing, or to a de-verified entry. | RETRYABLE |
| `PROVIDER_IDENTITY_MISMATCH` | The entry resolves and disagrees about *where the request goes*. | TERMINAL |
| `MODEL_DELIVERY_PLAN_CHANGED` | The entry resolves and still points at the same provider request, but now declares a different delivery plan for the frozen target — or a capability that no longer offers the frozen native token. | TERMINAL |

The delivery-plan check is **agreement, not adoption**. The frozen snapshot is
the truth of what was approved; the current catalog is the authority on whether
that is still safe to execute. When they agree the snapshot is submitted
unchanged — a test asserts the prepared artifact is byte-identical to the frozen
facts, so "agreement" cannot quietly become "re-planning". When they disagree
neither answer is usable, and the attempt is refused.

An earlier revision of this milestone omitted that check, arguing "the snapshot
wins". That is right about *what gets submitted* and wrong about *whether to
submit at all*: it left a corrected catalog unable to stop an attempt admitted
under the belief it superseded. Brief §24/§26 caught it.

All three refuse before any storage credential is minted, and tests assert that
ordering by counting signs, existence checks and asset reads.

### 6. The provider boundary

`ProviderGenerationInput.resolution` → `nativeGenerationResolution`;
`VideoModelCapability.resolutions` → `nativeGenerationResolutions`;
`assertSettingsSupported` compares native to native. The WaveSpeed adapter still
sends the vendor's own `resolution` wire field.

`PreparedGeneration` carries all four delivery facts rather than one string.

## The 3B-2A semantic ledger, resolved

Every `LEGACY_AMBIGUOUS` occurrence the previous milestone catalogued:

| Occurrence | Resolution |
| --- | --- |
| `GenerationRequestSettings.resolution` | → `nativeGenerationResolution`, fed from the model's delivery plan, not the project. |
| `assertSettingsSupported` resolution check | Compares native to native. |
| `SceneGeneration.requestResolution` | Retained as V1-only; five V2 columns carry the meaning. |
| `GenerationRequestFacts.resolution` | Replaced by five explicit facts; no alias. |
| `generationRequestFactsFrom` | Fails closed on four distinct states. |
| `PreparedGeneration.resolution` | Replaced by the four delivery facts. |
| Snapshot write (`generation-service.ts`) | Writes `requestResolution: null` and the five V2 fields. |
| Hash input (`generation-service.ts`) | Twelve facts from the resolved entry and its delivery plan. |

Every `PRODUCT_TARGET_OUTPUT_RESOLUTION` occurrence is renamed to
`targetOutputResolution` and closed. Every
`PROVIDER_NATIVE_GENERATION_RESOLUTION` occurrence is renamed to make the
native meaning explicit, except the WaveSpeed wire field, which stays the
vendor's name.

## Verification

| Check | Result |
| --- | --- |
| `pnpm -r typecheck` + root `tsc --noEmit` | Pass |
| `pnpm lint` (ESLint 9 flat) | Pass, no warnings |
| `pnpm test` | **1,525 passed / 1,525** (68 files) |
| `pnpm test:db` (live PostgreSQL 16) | **220 passed / 220** (9 files) |
| `pnpm build` (Next.js production) | Pass |
| `prisma migrate deploy` from an empty database | All 9 migrations applied |
| `prisma migrate diff --exit-code` | **`No difference detected.`** |

### Migration verified against real legacy data

| Scenario | Result |
| --- | --- |
| Eight pre-3B-2B migrations + a legacy project (`resolution='1080p'`) + a V1 generation (`sha256:legacyhash`, `requestResolution='1080p'`) | Applied. Both rows **verified unchanged by MD5 over their contents** before and after, all five V2 columns null. |
| Same, with the project's `resolution` set to `'4k'` | **Aborted** with the explicit message naming the count and the query. **0 V2 columns and 0 constraints added**, the offending row still `'4k'` — the transaction rolled back. |

### Every constraint exercised directly

| Attempted write | Result |
| --- | --- |
| Project target `4k` | Rejected — `video_projects_resolution_target_check` |
| V2 hash, no delivery snapshot | Rejected — identity-version check |
| V2 hash, partial snapshot | Rejected — identity-version check |
| V2 row also carrying `requestResolution` | Rejected — identity-version check |
| V1 hash carrying a V2 snapshot | Rejected — identity-version check |
| Normalization `SIDEGRADE` | Rejected — normalization check |
| Snapshot target `8k` | Rejected — target-output check |
| Blank / empty `requestModelKey` | Rejected — model-key non-blank check |
| Blank `requestNativeGenerationResolution` | Rejected — native-resolution non-blank check |
| Well-formed V2 row (`768P` / `UPSCALE` / `false`) | Accepted |
| Legacy V1 row (all five V2 columns null) | Accepted |

## The required tests, and where each is proven

| Requirement | Where |
| --- | --- |
| Hash regression — the V2 tuple cannot silently change | `request-identity.test.ts` — a pinned literal digest, which fails on reordering rather than only on a one-sided change |
| Both new resolution facts are identity-bearing separately | `request-identity.test.ts`, `catalog.test.ts` |
| The two *derivable* facts are identity-bearing too | `request-identity.test.ts` |
| Legacy matrix — V1, partial, both-vocabularies, version mismatch | `generation-reconstruction.test.ts` |
| Null camera motion is still a real value, not a missing one | `generation-reconstruction.test.ts` |
| Model selection — default, named, unknown, unverified, unsupported target | `generation-service.test.ts` |
| The default is read exactly once, and not at all when a model is named | `generation-service.test.ts` |
| An upscaled delivery is frozen as upscaled and hashed that way | `generation-service.test.ts` |
| Capability validated against the native token, not the product target | `generation-service.test.ts`, `capability.test.ts` |
| Reuse is per-model | `generation-service.test.ts` |
| Preflight resolves by the frozen key; absent and de-verified entries refuse | `execution-preflight.test.ts` |
| An unavailable model refuses **before** signing | `execution-preflight.test.ts` (asserts zero signs and zero existence checks) |
| The frozen plan wins over the current catalog | `execution-preflight.test.ts` |
| Provider boundary carries the native token | `mapping.test.ts`, `wavespeed/capability.test.ts` |
| Persistence round-trip of all five V2 columns, including `false` | `generation-repository.db.test.ts` |
| Database refuses both vocabularies, a partial snapshot, an off-vocabulary target | `generation-repository.db.test.ts` |
| A legacy row still stores and reads back as null | `generation-repository.db.test.ts` |
| The migration performs no data modification | `tests/schema/resolution-identity-v2-migration.test.ts` |
| The migration fails closed and adds every constraint, naming each V2 column in both directions | `tests/schema/resolution-identity-v2-migration.test.ts` |
| The migration does not parse the provider's native token | `tests/schema/resolution-identity-v2-migration.test.ts` |
| The create port cannot express a V1 row, a partial V2 snapshot, or a complete snapshot with a null prompt | `new-scene-generation-contract.test.ts` (13 compile-time assertions) |
| The **read** shape stays nullable, so historical rows remain representable | `new-scene-generation-contract.test.ts` |
| A row created through the current port is complete, reconstructs, and reproduces its own hash | `in-memory-generation.test.ts`, `generation-repository.db.test.ts` |
| A legacy row seeded outside the create port still reads back as all-null | `in-memory-generation.test.ts`, `generation-repository.db.test.ts` |
| Catalog drift — native token, normalization, `nativeMeetsTarget`, target withdrawn, capability narrowed | `execution-preflight.test.ts` |
| An agreeing plan is not adopted, and the row is not rewritten | `execution-preflight.test.ts` |
| The real catalog: H3 Max default, 720p→768P/DOWNSCALE/true, 1080p→768P/UPSCALE/**false** | `tests/generation/model-selection.test.ts` |
| The real catalog: explicit `wavespeed-open-video`, and both unverified entries refused by admission's own guard | `tests/generation/model-selection.test.ts` |
| A future H3 Max 1080p admission reaches the wire as `768P`, with no translation step | `wavespeed/mapping.test.ts` |
| HTTP refuses the old key, an off-vocabulary value, and a non-string | `tests/api/storyboard-routes.test.ts` |
| The UI offers a closed selector that starts unset | `create-panel.test.ts` |

## Mutation ledger (§36)

Each mutation was applied to the final code, measured, then restored. "Detected"
counts failing tests from `pnpm test` unless noted; a typecheck error is also a
detection and is reported separately where it occurred.

| # | Mutation | Typecheck errors | Failing tests | Detected |
| --- | --- | ---: | ---: | --- |
| M1 | Remove `targetOutputResolution` from the V2 hash | 1 | 3 | yes |
| M2 | Remove `nativeGenerationResolution` from the V2 hash | 0 | 3 | yes |
| M3 | Remove `modelKey` from the V2 hash | 0 | 2 | yes |
| M4a | Remove `resolutionNormalization` from the V2 hash | 1 | 2 | yes |
| M4b | Remove `nativeMeetsTarget` from the V2 hash | 0 | 2 | yes |
| M5 | Restore the unversioned `sha256:` prefix | 0 | 6 | yes |
| M6 | Derive a legacy row's plan from today's catalog | 0 | 2 | yes |
| M7 | Write the legacy `requestResolution` on a V2 row | 0 | 6 unit + **203** db | yes |
| M8 | Allow a partial V2 snapshot (relax the constraint) | 0 | 1 schema + 2 db | yes |
| M9 | Send the product target as WaveSpeed's wire resolution | 0 | 2 | yes |
| M10 | H3 Max 1080p claims `1080p` as its native token | 0 | 7 | yes |
| M11 | Unknown model key falls back to the default | 0 | 2 | yes |
| M12 | Accept an `UNVERIFIED` model | 0 | 3 | yes |
| M13 | Mint a signed URL before refusing a legacy row | 0 | 26 | yes |
| M14 | Allow a drifted delivery plan through preflight | 1 | 6 | yes |
| M15 | Loosen `NewSceneGeneration` so V1/incomplete creation is expressible | **35** (domain) / 9 (root) | 0 | yes |

**M15's evidence is compile-time by design, and that is why its failing-test
count is 0.** Vitest transpiles without type-checking, so a widened write
contract produces no red test — it produces 35 `tsc` errors in the domain
package, every one of them from the contract file's assertions, plus 9 at the
root where the loosened type breaks real call sites. A ledger entry reporting
only "0 failing tests" would have looked like a survival; it is the opposite.

**M7 changed character after the correction.** With the write type narrowed,
`requestResolution: targetOutputResolution` no longer compiles at all — the
mutation has to be written with a deliberate `as unknown as null` cast to be
applied. Both forms are reported: the honest form is a compile error, the
cast form fails 6 unit tests. Its database count is now 0 rather than the 203
reported pre-correction, because the DB suite exercises the repository directly
and its fixtures are proper V2 rows; `GenerationService` is not on that path.

**Three mutations initially survived, and each exposed a real gap that was
closed. These are reported because they are the ledger's actual findings.**

**M6** first failed only one test. The domain's legacy matrix used a row with
`requestResolution` already null, so a mutation that infers a plan *from* that
column never fired against it — the matrix was missing the realistic V1 row,
the one carrying `"720p"` and nothing else. Added; M6 then failed two.

**M8** was not caught at all. The migration-text test asserted the
identity-version constraint by name and by its `sha256:v2:%` prefix, both of
which a constraint checking only `requestModelKey` still satisfies. The test now
asserts every V2 column appears in **both** branches, and a live database built
from the mutated migration is also exercised; M8 then failed 1 schema test and 2
database tests. *(One intermediate M8 run reported 203 database failures — that
was PostgreSQL having stopped, not a detection, and it is recorded here rather
than counted.)*

**M12** was not caught, and the reason is worth keeping. `planGenerationResolution`
independently refuses an unverified entry, so deleting admission's own selection
guard still produced a `VALIDATION_FAILED` — from a layer whose message
describes a resolution-planning failure rather than an unavailable model. The
behaviour was defence in depth working; the *evidence* was not discriminating.
The unverified and unknown tests now pin the message, so admission's guard is
proven to be the one that fires. M12 then failed three.

Every mutated file was restored and verified byte-identical by MD5 against a
pre-mutation copy:

```
IDENTICAL  packages/domain/src/generation/request-identity.ts
IDENTICAL  packages/domain/src/generation/generation-service.ts
IDENTICAL  packages/domain/src/generation/execution-preflight.ts
IDENTICAL  packages/domain/src/generation/ports.ts
IDENTICAL  packages/video-providers/src/wavespeed/mapping.ts
IDENTICAL  packages/video-providers/src/catalog.ts
IDENTICAL  .../00000000000009_phase4c3b2b_resolution_identity_v2/migration.sql
```

No mutation-only code is committed (`grep -rn "MUTATION M"` → 0 hits).

## Notable decisions taken during implementation

**The capability fixture's native tokens were changed to `FIXTURE_LOW` /
`FIXTURE_HIGH`.** They had been `720p` / `1080p`, which are product targets.
Fixtures that look like targets are exactly how a target came to be validated
against a native list, so the fixture now cannot pass by coincidence.

**`toTargetOutputResolution` in the Prisma repository narrows rather than
casts, and throws rather than defaulting.** The column is TEXT and the domain
field is non-nullable. Choosing `720p` for an unrecognised value would silently
rewrite a customer's stated request; choosing `1080p` would promise detail
nobody agreed to produce.

**A non-member in a V2 delivery column maps to `null`.** That is not a repair:
it makes the snapshot incomplete, and an incomplete snapshot is what
`generationRequestFactsFrom` refuses. An impossible stored value therefore fails
the attempt closed rather than executing it under an unrecognised semantic.

**`requiredMember` uses `find`, not `includes`.** `includes` would leave a cast
as the only way to express the narrowing it just proved, and a cast reads the
same whether or not the check above it still exists.

**The UI receives the vocabulary as plain data from the server page.** Importing
the domain constant into the Client Component put server-only crypto in the
browser bundle and broke the production build — the same boundary rule already
established for camera motions and room types.

**A default parameter of `undefined` silently takes the default.** The
absent-model preflight fixtures passed against the *present* model until the
sentinel became `null`. Two tests were wrong in a way that would have made the
new refusal look proven.

**`NewSceneGeneration` was derived from the read shape**, which quietly
inherited every nullable snapshot field and left V1 and partial-V2 creation
expressible in application code. The database and the domain both refused such a
row, so nothing was broken in practice — but "refused at runtime by two other
layers" is a weaker guarantee than "unwritable", and the type was the layer that
should have said so first. CTO technical review §1 required the narrowing.

**The catalog-drift gate was missing from the first revision**, on the argument
that the frozen snapshot is authoritative. It is — for *what* to submit. It is
not the authority on *whether* to submit, and conflating the two left a
corrected catalog with no way to stop an attempt it had superseded. Brief
§24/§26 required the check; it is now `MODEL_DELIVERY_PLAN_CHANGED`.

## Invariants held

- Tenant scope unchanged: no new `organizationId` column, every read still
  filtered through the owning project.
- No secret, signed URL, prompt, or customer text in any new error message,
  audit field, or log line. The three added audit fields are a catalog key, a
  product vocabulary member, and a boolean.
- No `any`, no `@ts-ignore`, no cast-based bypass.
- Preflight still writes nothing and holds no method that could.
- `createGeneration` still has zero production callers. Nothing in this
  milestone contacts a provider, and no test made a network call.

## Known limitations

- **Every V1 attempt is now permanently unexecutable.** Intended — its inputs
  are gone — and already true for rows predating ADR-0018 and ADR-0023.
- **Nothing normalizes a delivered video.** `UPSCALE` is recorded and not
  honoured. An H3 Max 1080p deliverable is not native 1080p until Phase 5
  composition exists, and nothing in the product may describe it as such.
- **No customer-facing surface exposes `nativeMeetsTarget`**, and there is no
  model selector in the UI. Both are prerequisites for offering model choice to
  customers.
- **A catalog delivery-plan correction silently strands admitted rows.**
  Preflight refuses them terminally, which is the safe outcome, but nothing
  tells an operator beforehand how many attempts an edit would strand and
  nothing reports them afterwards. A read-only reconciliation query is a
  prerequisite for routine catalog corrections.
- Unchanged and cumulative: no fal adapter, no paid gate, provider-agnostic
  submission certainty is still unimplemented (there is no ADR-0032 file — the
  active specification lives in `docs/decisions/TODO.md`), and pricing is `null`
  for every selectable model.
