# Phase 4C-3B-2B — Versioned request identity and the resolution snapshot

Milestone: Phase 4C-3B-2B
Base: `9e530504b8098c3093eecc8140d36094067f8a42` (merged Phase 4C-3B-2A, PR #48)
Decision record: ADR-0034

> This report is an immutable technical snapshot and carries no lifecycle
> status. The GitHub pull request is the authoritative lifecycle source.

## Size — over the hard stop, reported rather than trimmed

| Scope | Insertions | Deletions | Total |
| --- | ---: | ---: | ---: |
| Code and tests (excludes `docs/`, `CHANGELOG.md`) | 1,938 | 308 | **2,246** |
| API and UI only (`apps/`, `tests/api/`) | 168 | 47 | 215 |
| Domain, database, providers (`packages/`, `tests/integration/`, `tests/schema/`) | 1,770 | 261 | 2,031 |
| Documentation (`docs/`, `CHANGELOG.md`) | 586 | 16 | 602 |

The authorized ceiling was ≤1,600 with a hard stop above 1,900. **This exceeds
it**, and the excess is reported here rather than absorbed by deleting evidence.

**The pre-authorized split does not resolve it.** The brief proposed 3B-2B-1
(domain/persistence/identity) and 3B-2B-2 (API/UI naming). Measured on the
finished work, the API/UI half is 215 lines and the domain half is 2,031 —
still over the hard stop on its own. The split would produce one compliant
milestone and one that is not, so it does not buy what it was meant to buy.

The size is dominated by tests rather than by production code:

| File | Lines changed |
| --- | ---: |
| `generation-service.test.ts` | 365 |
| `generation-repository.db.test.ts` | 169 |
| `generation-service.ts` | 149 |
| `resolution-identity-v2-migration.test.ts` | 140 |
| `generation-reconstruction.test.ts` | 139 |
| `execution-preflight.test.ts` | 139 |
| `migration.sql` | 125 |

Production TypeScript across all packages is roughly 500 changed lines. What
made this milestone large is that a hash-versioning change with no
backward-compatible path has to be *proved*, in the domain, against a live
database, and against the migration text — and that a rename of one field
reaches every layer at once because the field is persisted, hashed, submitted
and displayed.

An alternative split that would work is possible — separating the request-
identity version from model selection — but it is a different decomposition
from the one authorized, and choosing it is the CTO's call rather than mine.

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
| V1 row (all five null) | Inputs are genuinely gone. |
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

### 5. Execution resolves by the attempt's frozen key

`ExecutionPreflightDeps.capabilities` becomes `models: Pick<VideoModelCatalog,
"find">`. `default()` is not on the type, so substituting the deployment's
current default for an attempt admitted on another model is a compile error
rather than a comment.

`MODEL_UNAVAILABLE` is the fifteenth refusal reason — `RETRYABLE`, distinct
from `PROVIDER_IDENTITY_MISMATCH`, and raised before any storage credential is
minted. The frozen delivery plan is never re-derived from the resolved entry.

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
| `pnpm test` | **1,480 passed / 1,480** (65 files) |
| `pnpm test:db` (live PostgreSQL 16) | **218 passed / 218** (9 files) |
| `pnpm build` (Next.js production) | Pass |
| `prisma migrate deploy` from an empty database | All 9 migrations applied |
| `prisma migrate diff --exit-code` | **`No difference detected.`** |

### Migration verified against real legacy data

| Scenario | Result |
| --- | --- |
| Eight pre-3B-2B migrations + a legacy project (`resolution='1080p'`) + a V1 generation (`sha256:legacyhash`, `requestResolution='1080p'`) | Applied. **Both rows byte-identical afterwards**, all five V2 columns null. |
| Same, with the project's `resolution` set to `'4k'` | **Aborted** with the explicit message naming the count and the query. **No column was added** — the transaction rolled back. |

### Every constraint exercised directly

| Attempted write | Result |
| --- | --- |
| Project target `4k` | Rejected — `video_projects_resolution_target_check` |
| V2 hash, no delivery snapshot | Rejected — identity-version check |
| V2 hash, partial snapshot | Rejected — identity-version check |
| V2 row also carrying `requestResolution` | Rejected — identity-version check |
| V1 hash carrying a V2 snapshot | Rejected — identity-version check |
| Normalization `SIDEGRADE` | Rejected — normalization check |
| Well-formed V2 row (`768P` / `UPSCALE` / `false`) | Accepted |

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
| The migration fails closed and adds the three constraints | `tests/schema/resolution-identity-v2-migration.test.ts` |
| HTTP refuses the old key, an off-vocabulary value, and a non-string | `tests/api/storyboard-routes.test.ts` |
| The UI offers a closed selector that starts unset | `create-panel.test.ts` |

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
- **No reconciliation report** for admitted attempts whose frozen delivery plan
  the current catalog no longer states. Preflight deliberately does not
  re-derive it, which is correct for identity and leaves an operator without
  visibility.
- Unchanged and cumulative: no fal adapter, no paid gate, ADR-0032's submission
  certainty is still unimplemented, and pricing is `null` for every selectable
  model.
