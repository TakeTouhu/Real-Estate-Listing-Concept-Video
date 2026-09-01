# Phase 4C-3B-2A — Multi-provider model catalog and two-resolution semantics

Milestone: Phase 4C-3B-2A
Base: `2aa05e4357297a5021c6947fe10bb06a52ac7a63` (merged Phase 4C-3B-1, PR #47)
Decision record: ADR-0033

> This report is an immutable technical snapshot and carries no lifecycle
> status. The GitHub pull request is the authoritative lifecycle source.

## Semantic ledger — every current use of `resolution`

Produced by inspection **before** any edit, and the reason this milestone stops
where it does. Classification per the CTO's four categories.

### PRODUCT_TARGET_OUTPUT_RESOLUTION

| Occurrence | Note |
| --- | --- |
| `VideoProject.resolution` (`domain/storyboard/types.ts:36`, `schema.prisma:304`) | What the customer asked the product to deliver. Currently free text. |
| `createVideoProject` input + validation (`storyboard-service.ts:57,108,125`) | Only checks non-blank. |
| `POST …/video-projects` body field (`api/…/video-projects/route.ts:47`) | Free-text API input. |
| Create-panel form field (`create-panel.tsx:71,97,160`) | Free-text UI input. |
| Project display (`projects-view.tsx:109`, `storyboard-view.tsx:96`) | Shown to the customer as the project's resolution. |
| `StoryboardProjectView.resolution` (`web/lib/storyboard.ts:61,78`) | Read-model passthrough. |
| `UpdateVideoProjectInput.resolution` (`storyboard/ports.ts:23`) | Mutable project field. |

### PROVIDER_NATIVE_GENERATION_RESOLUTION

| Occurrence | Note |
| --- | --- |
| `VideoModelCapability.resolutions` (`domain/generation/capability.ts:89`) | What the *model* can generate. |
| `OPEN_VIDEO_CAPABILITY.resolutions` (`wavespeed/capability.ts:56`) | `["480p","720p","1080p"]` — OpenVideo's native list. |
| `ProviderGenerationInput.resolution` (`video-providers/types.ts:37`) | Goes on the wire. |
| `mapToWaveSpeedRequest` body `resolution` (`wavespeed/mapping.ts:58`) | The literal request field. |
| `OPEN_VIDEO_REQUEST_FIELDS` (`wavespeed/capability.ts:20`) | Names the wire field. |
| Self-check inputs (`web/lib/health.ts:57`, `worker/bootstrap.ts:60`) | `"720p"` as a provider input for an offline cost estimate. |

### LEGACY_AMBIGUOUS

**The defect.** Each of these is simultaneously the product target and the
native token, because for the only wired model the two coincide.

| Occurrence | Why it is ambiguous |
| --- | --- |
| `GenerationRequestSettings.resolution` (`capability.ts:121`) | Assembled from the **project** (`generation-service.ts:378`) and validated against the **model's native list** (`capability.ts:213`). One field, both meanings, in two lines. |
| `assertSettingsSupported` resolution check (`capability.ts:213`) | Compares a product target to a native list. Correct only while they coincide. |
| `SceneGeneration.requestResolution` (`domain/generation/types.ts:170`, `schema.prisma:416`) | Immutable snapshot of the project value; stored rows cannot say which meaning was intended. |
| `GenerationRequestFacts.resolution` → request hash (`request-identity.ts:57,123`) | Identity-bearing. Splitting it changes what is hashed. |
| `generationRequestFactsFrom` reconstruction (`request-identity.ts:101–123`) | Rebuilds the ambiguous value; already fails closed on `null`. |
| `PreparedGeneration.resolution` (`execution-preflight.ts:78,374`) | Carries the ambiguous fact to execution. |
| Snapshot write (`generation-service.ts:257`) | `requestResolution: project.resolution`. |
| Hash input (`generation-service.ts:162`) | `resolution: view.project.resolution`. |

### UNRELATED

`env.ts:82` ("configuration resolution"), `generation-execution-repository.ts:24`
("tenant resolution"), `analysis/normalization.ts:67,82` (photo pixel
dimensions), `web/lib/analysis.ts:84` ("reimplements the resolution").

### What the ledger decided

Every LEGACY_AMBIGUOUS row is either persisted, hashed, or both. Splitting them
changes request identity **and** the meaning of existing rows, and legacy rows
must fail closed where native resolution cannot be reconstructed. That is a
migration, not a rename, and mixing it with catalog design is the combination
the scope discipline warns against — so **this milestone changes none of them**
and proposes Phase 4C-3B-2B below.

## What shipped

```ts
// domain — shape and rules, provider-neutral
type TargetOutputResolution = "720p" | "1080p";          // a quality class, not a raster size
interface NativeGenerationResolution { providerValue: string }   // opaque: no heightPx
interface TargetResolutionDelivery {
  nativeGenerationResolution: NativeGenerationResolution;
  normalization: "NONE" | "DOWNSCALE" | "UPSCALE";
  nativeMeetsTarget: boolean;
}
interface NativeGenerationPolicy {
  byTarget: Readonly<Partial<Record<TargetOutputResolution, TargetResolutionDelivery>>>;
}

interface ModelEntryIdentity { key; providerName; displayName; tier; recommended }
interface VerifiedModelEntry extends ModelEntryIdentity {
  providerModelId: string;                    // an executable address — verified-only
  availability: { kind: "SELECTABLE" };
  capability: VideoModelCapability;
  nativeGeneration: NativeGenerationPolicy;
  pricing: VerifiedModelPricing | null;
}
interface UnverifiedModelEntry extends ModelEntryIdentity {
  availability: { kind: "UNVERIFIED"; missing: readonly string[] };
  providerModelId?: never;                    // structurally forbidden, with the rest
  capability?: never; nativeGeneration?: never; pricing?: never;
}
type VideoModelEntry = VerifiedModelEntry | UnverifiedModelEntry;

isSelectableModel(entry): entry is VerifiedModelEntry
supportedTargetOutputResolutions(entry): readonly TargetOutputResolution[]  // policy keys
planGenerationResolution(entry, target): TargetResolutionDelivery           // a lookup

// video-providers — the values
createVideoModelCatalog()   // H3 Max (default), H3, Veo 3.1, WaveSpeed OpenVideo
deepFreeze(value)           // runtime immutability for the whole graph
ProviderName = "fake" | "wavespeed" | "fal"   // type only; the env enum is unchanged
```

### Delivery policy, stated per model and per target

| Model | Target | Native token | Normalization | `nativeMeetsTarget` |
| --- | --- | --- | --- | --- |
| H3 Max | 720p | `768P` | DOWNSCALE | `true` |
| H3 Max | 1080p | `768P` | UPSCALE | **`false`** |
| OpenVideo | 720p | `720p` | NONE | `true` |
| OpenVideo | 1080p | `1080p` | NONE | `true` |

Looked up, never calculated: `planGenerationResolution` returns the declared
object by reference, so there is no parsing or height arithmetic to get wrong.

**ADR-0033 carries the reasoning.** Zero schema, migration, request-identity,
API and UI change.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors |
| `pnpm lint` | exit 0 |
| `pnpm test` | **1452 passed**, 65 files (baseline 1399 / 63) |
| `pnpm build` | exit 0 |
| `pnpm test:db` | **213 passed**, 9 files (unchanged) |
| `prisma migrate diff --from-migrations` | `No difference detected.` — no schema change |

## The required tests, and where each is proven

| # | Requirement | Proven by |
| --- | --- | --- |
| 1 | H3 Max is the default product model | `catalog.default()` is `minimax-h3-max`; it is the only `recommended` entry |
| 2 | H3 Max records native `768P`, not 720p/1080p | Both deliveries name `{ providerValue: "768P" }`; `capability.resolutions` is `["480P","768P"]` and asserted **not** to contain `720p` or `1080p` |
| 3 | Target 720p coexists with native 768P | Plan: native `768P`, `DOWNSCALE`, `nativeMeetsTarget: true` |
| 4 | Target 1080p coexists without claiming native 1080p | Plan: native `768P`, `UPSCALE`, **`nativeMeetsTarget: false`** |
| 5 | A different native policy needs no orchestration change | Two models with opposite policies go through the same `planGenerationResolution`, yielding opposite `nativeMeetsTarget`; an opaque token (`"studio-grade"`) works identically |
| 6 | WaveSpeed's capability is intact | The entry holds `OPEN_VIDEO_CAPABILITY` **by reference** (`toBe`), and its resolutions/motion/negative-prompt declarations are re-asserted |
| 7 | Persisted identities are not retargeted | A WaveSpeed-admitted fact set hashes identically before and after the default becomes fal; the same request on H3 Max hashes differently |
| 8 | Legacy rows fail closed | Pinned at its **current** scope: `generationRequestFactsFrom` already refuses a row with `null` snapshot columns. Native-resolution fail-closed is 3B-2B — see limitations |
| 9 | Hash changes on a generation-significant change | Provider, model id and resolution each change the hash |
| 10 | No provider-specific field leaks into the domain | Compile-time `never` pin over `falQueueUrl`/`falEndpoint`/`wavespeedBaseUrl`/`minimaxPreset`/`googleProject`/`apiKey`/`headers`/`requestBody` |
| 11 | No production provider POST | `createGeneration` production invocation sites: **0** |
| 12 | No real fal request | No fal adapter exists; `VIDEO_PROVIDER=fal` fails env validation; the catalog is a frozen table that performs no I/O |
| 13 | No paid execution path becomes reachable | Default provider is still `fake`; no paid gate; `planGenerationResolution` refuses both unverified models |

Plus: the target vocabulary refuses native tokens (`768P`, `480P`, `2K`,
`720P`) and inherited names (`toString`, `__proto__`); refusals name the model
key and not the provider endpoint; every entry is frozen and pricing is `null`
throughout.

## Review corrections applied

| Blocker | Correction |
| --- | --- |
| **1 — fabricated capabilities on unverified entries** | `VideoModelEntry` is now a discriminated union. `UnverifiedModelEntry` declares `providerModelId?: never`, `capability?: never`, `nativeGeneration?: never`, `pricing?: never`, so the placeholders that existed (`heightPx: 0`, a 1-to-1-second duration range, a `"unverified"` token) are **unconstructible**, not merely unreachable. Runtime tests assert both unverified entries have exactly six identity keys and nothing else; type-level tests assert the invalid combinations do not type-check. |
| **1b — provisional provider model ids** | `providerModelId` moved from the shared identity to the verified arm: it is an executable address, and an unverified entry has no business asserting one. The concrete ids are removed from MiniMax H3 and Veo 3.1, with no replacement and no `candidateProviderModelId`. H3's stale `"exact production endpoint"` missing item is gone — the route is known, the *product contract* is not — and Veo's names `production variant selection and frozen endpoint contract`, because fal publishes standard, Fast and other 3.1 routes. |
| **1b — `SELECTABLE` wording too strong** | It now means *eligible for product-level model selection against a verified capability contract*, explicitly not paid-execution readiness. A test asserts H3 Max is selectable while the configured provider is `fake`, `VIDEO_PROVIDER=fal` is rejected, and its pricing is `null`. |
| **2 — shallow freezing** | A `deepFreeze` helper freezes the whole graph, and `OPEN_VIDEO_CAPABILITY` is deeply frozen **at its source**. Six regression tests attempt real mutations — `resolutions` push and index assignment, a delivery's `nativeMeetsTarget`, a native `providerValue`, an availability `missing` list, the entry array, entry fields — and re-read through a fresh `createVideoModelCatalog()` and `createOpenVideoCapabilityProvider().current()` to prove state is unchanged. A seventh walks the graph asserting `Object.isFrozen` at every level. |
| **3 — generic `heightPx` arithmetic** | Removed entirely. `NativeGenerationResolution` is `{ providerValue }` and nothing else; `TARGET_HEIGHT_PX` is gone; the relationship is stated per model per target and returned by reference. Tests assert no `heightPx`/`widthPx`/`pixels`/`lines` key exists, that the returned object *is* the declared one, and that a token with no numeric meaning at all (`"studio-grade"`) works. |

Also added per §6: a renderer tie for H3 Max's `PROMPT_RENDERED` camera-motion
claim. It does not assert the enum — it renders a compiled prompt with
`SLOW_DOLLY_FORWARD` through the real `renderPrompt`, asserts the motion
sentence is present, asserts it is absent when the scene carries no motion, and
asserts the two renderings differ. If the renderer stopped carrying motion the
declaration would have to become `UNSUPPORTED`, which is the same invariant
OpenVideo already owes.

## Execution-safety answers

| Question | Answer |
| --- | --- |
| Real fal call | **NO** — no fal adapter exists in this milestone |
| Real WaveSpeed call | **NO** |
| Paid-generation path reachable | **NO** |
| `createGeneration` production orchestration callers | **0** |
| Can changing the default retarget a persisted generation | **NO** — snapshot fields are authoritative; pinned by test |

## Proposed Phase 4C-3B-2B — the resolution migration

Everything in the LEGACY_AMBIGUOUS section, as one milestone:

1. `VideoProject.resolution` becomes the product target, constrained to
   `TargetOutputResolution` at the API, UI and service boundary.
2. `SceneGeneration` gains a native-generation snapshot column alongside
   `requestResolution`, so a row records both meanings.
3. `GenerationRequestFacts` carries both, and the request hash covers both —
   an identity-semantics change that must be documented and tested explicitly.
4. `generationRequestFactsFrom` fails closed for a legacy row whose native
   resolution cannot be proven, rather than deriving it from today's catalog.
5. `assertSettingsSupported` validates the *native* value against
   `capability.resolutions`, and the *target* against
   `targetOutputResolutions`.
6. `ProviderGenerationInput.resolution` is fed the native value from
   `planGenerationResolution`.

It needs a Prisma migration and touches request identity, so it is deliberately
not combined with catalog design.

## Invariants held

Prisma schema and migrations **unchanged** · request identity and hashing
**unchanged** · `VideoProject`, `SceneGeneration`, storyboard service, API routes
and UI **unchanged** · `OPEN_VIDEO_CAPABILITY` **unchanged** · `mapToWaveSpeedRequest`
**unchanged** · env schema **unchanged** · `createVideoProvider` **unchanged** ·
pricing **unchanged** · execution repository, preflight and state machine
**unchanged** · Phase 4C-3B-1 sanitization **unchanged** · no paid gate · no
submission audit · no worker loop · no provider call.

## Known limitations

- **The catalog is not yet consumed.** Nothing calls
  `createVideoModelCatalog()` in production; orchestration still uses the single
  `VideoModelCapabilityProvider`. Wiring it is part of 3B-2B, and until then the
  default *model* and the configured *provider* disagree by design.
- **Test 8 is pinned at its current scope**, not the future one. The
  fail-closed behaviour proven here is the existing null-snapshot refusal; a
  legacy row whose *native* resolution is unprovable cannot be refused yet,
  because no column records it.
- **Two of four models cannot be selected**, and one of them — MiniMax H3 — is
  the model the product would want precisely when native 1080p detail matters.
  Until its native output is verified in lines, a 1080p deliverable is an
  upscale from 768.
- **ADR-0032's submission certainty is still unimplemented.** Its
  WaveSpeed-centric plan is superseded; the outcome union will be
  provider-agnostic with status interpretation inside each adapter.
- **The superseded 3B-2 branch is read-only reference.** It was not modified,
  opened as a PR, merged, rebased or cherry-picked. After 3B-2B merges, a new
  provider-agnostic submission-certainty milestone will salvage only
  individually revalidated ideas from it.
