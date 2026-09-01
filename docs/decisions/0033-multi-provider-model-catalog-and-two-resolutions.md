# ADR-0033: A multi-provider model catalog, and two resolutions that were always different

- Status: Accepted
- Date: 2026-08-31
- Phase: 4C-3B-2A
- Amends: ADR-0019 (provider capability ownership) — extends it from one verified
  descriptor to a catalog of them, without changing who owns what
- Context for: ADR-0032 (paid submission certainty), which remains unimplemented

## Context

The architecture was built around a single configured model. ADR-0019 froze one
verified capability descriptor for `wavespeed-ai/open-video/image-to-video` and
deliberately refused a model registry, on the grounds that "a selection
mechanism nobody has specified would be speculative surface on the one path that
spends money." That reasoning was right at the time and the specification now
exists: the product is explicitly multi-provider and multi-model, with MiniMax
H3 Max through fal as the default and WaveSpeed retained.

Adding a second model exposes a defect that a single model concealed.

The system has one field called `resolution`, and it means two different things
at once. For OpenVideo the two happen to be the same string — it generates
natively at `720p` and `1080p`, which are also the deliverables the product
offers — so a single field looked correct. H3 Max generates natively at `480P`
or `768P` and at nothing else. A 1080p deliverable from H3 Max is a `768P`
generation that has been enlarged. A single field cannot say that, and a system
that cannot say it will eventually claim native 1080p detail it never produced.

## Decision

### 1. Two named concepts, permanently

- **`TargetOutputResolution`** — the product-level deliverable. A closed union,
  `"720p" | "1080p"`, because it is a promise the product makes to a customer.
- **native generation resolution** — what the selected provider/model is asked
  to generate. Provider-specific, open, never a product promise.

They are structurally distinct types, not two strings with different names.

**A native resolution is opaque — `{ providerValue }` and nothing else.** An
earlier revision of this milestone paired the token with a `heightPx` and
compared it arithmetically against an assumed target height. Review rejected
that, correctly, and the reason is worth recording: `768P` is not "video height
768" independently of aspect ratio — fal documents 768P at 16:9 as 1344×768, and
image-to-video output follows the supplied image's ratio, so the raster size
varies with the source. A product label like `1080p` is likewise a **quality
class**, not a promise of 1920×1080; this service supports multiple aspect
ratios including future vertical and square media. Deriving the relationship by
parsing vendor strings or assuming a height is inference dressed as arithmetic.

**The relationship is therefore stated per model, per target**, in the model's
own policy, and `planGenerationResolution` is a *lookup* rather than a
calculation. Its load-bearing field is `nativeMeetsTarget`:

| Model | Target | Native token | Normalization | `nativeMeetsTarget` |
| --- | --- | --- | --- | --- |
| H3 Max | 720p | `768P` | DOWNSCALE | `true` |
| H3 Max | 1080p | `768P` | UPSCALE | **`false`** |
| OpenVideo | 720p | `720p` | NONE | `true` |
| OpenVideo | 1080p | `1080p` | NONE | `true` |

Nothing in the product may describe an H3 Max 1080p output as native 1080p. The
supported targets are the **keys of that policy**, so no second array can
disagree with it.

### 2. Normalization is composition's job, and is only *recorded* here

This module computes `NONE` / `DOWNSCALE` / `UPSCALE` and stops. No scaling is
implemented; Phase 5 owns it. The point of computing it now is that the fact is
available *before* money is spent on the assumption that the deliverable will
carry native detail.

### 3. The catalog is provider-neutral, and split the way ADR-0019 split capability

The domain owns the shape of a model entry and the rules applied to it
(`packages/domain/src/generation/model-catalog.ts`); the adapter package owns
what is true about each vendor (`packages/video-providers/src/catalog.ts`).
There is no fal field, no WaveSpeed field, no MiniMax field and no Google field
anywhere in the domain types, and a compile-time test asserts it — the risk is
not that someone adds `falQueueUrl` today, but that a later adapter needs one
field, adds it where it is convenient, and the domain quietly learns about fal.

### 4. An unverified entry structurally cannot hold operational facts

`VideoModelEntry` is a discriminated union of `VerifiedModelEntry` and
`UnverifiedModelEntry`. A verified entry carries `providerModelId`, capability,
native-generation policy and pricing; an unverified one carries identity plus a
list of what is missing, and declares `providerModelId?: never`,
`capability?: never`, `nativeGeneration?: never`, `pricing?: never` — omitting
them is fine, supplying any value is a type error.

**`providerModelId` is a verified-only fact.** It is an executable address —
where a paid request would be sent — not a naming one, so it sits on the
verified arm rather than the shared identity. Veo 3.1 makes the point concrete:
fal publishes standard, Fast and other 3.1 routes, and freezing one id before
the product has chosen which variant it verifies would present an unmade
decision as a made one. There is deliberately no `candidateProviderModelId` and
no metadata bag to hold one indirectly; a "candidate" id is the same claim with
a hedge in front of it, and it would be copied into a request the first time
someone needed an address.

Knowing a route exists is research evidence, not a product contract. Both
unverified entries name none, and their `missing` lists say what is genuinely
unresolved — the capability contract this product would use, the native
resolution policy, duration/aspect-ratio/feature delivery, the target-output
plan, and verified pricing — rather than claiming the endpoint is unknown.

This replaces a first attempt that filled unverified entries with placeholders
(`heightPx: 0`, a 1-to-1-second duration range, a literal `"unverified"` token)
purely to satisfy one wide interface, on the argument that they were unreachable
because `planGenerationResolution` refused the entry. **Unreachable fabricated
data is still fabricated data**: it reads as fact to the next person, and the
type system should make it impossible rather than a convention.

### 5. `SELECTABLE` is selection eligibility, not execution readiness

`SELECTABLE` means **eligible for product-level model selection against a
verified capability contract**. It does *not* mean paid execution is reachable.
Execution readiness is independently blocked by adapter availability, provider
configuration, verified pricing, the future paid gate, and orchestration
readiness — none of which exist. H3 Max is `SELECTABLE` and has no fal adapter
at all, and its pricing is `null`.

Today:

| Model | Tier | Provider | Native | Availability |
| --- | --- | --- | --- | --- |
| **MiniMax H3 Max** | RECOMMENDED (default) | fal | `768P` fixed | SELECTABLE |
| MiniMax H3 | HIGH_RESOLUTION | fal | — | UNVERIFIED |
| Veo 3.1 | PREMIUM | fal | — | UNVERIFIED |
| WaveSpeed OpenVideo | ECONOMY | wavespeed | `720p` / `1080p` per target | SELECTABLE |

Neither unverified entry names a native token, a duration or a target policy at
all — the type gives them nowhere to live. Their `missing` lists say what has to
be read from the provider's documentation first: for MiniMax H3 that includes
its native generation resolution tokens; for Veo 3.1, its endpoint and variant,
resolution variants, duration, audio behaviour, aspect-ratio behaviour and
pricing. `planGenerationResolution` refuses both.

**H3 Max is the default, not a vendor lock-in.** The catalog exists precisely so
the default can move, and WaveSpeed is retained as a supported economy path with
its ADR-0019 descriptor reused *by reference* so this catalog cannot drift from
it.

### 6. Catalog data is deeply immutable at runtime

`Object.freeze` is one level deep, so a "frozen" entry would still hand out a
live `resolutions` array. `readonly` is a compile-time courtesy that disappears
at runtime, does not survive a cast, and does not apply to a JavaScript consumer
at all. A `deepFreeze` helper freezes the whole graph, and
`OPEN_VIDEO_CAPABILITY` is deeply frozen **at its source** — it is shared by
reference between the capability provider and the catalog precisely so the two
cannot drift, which also means one mutation through either reference would
poison both, and that descriptor decides what a paid request may ask for.

Not implemented by serializing and re-parsing: that would produce a copy, which
defeats the shared-reference identity the catalog depends on.

### 7. Pricing is `null` until verified, and no boolean stands in for it

Every entry carries `pricing: null` today. A placeholder number reserves the
wrong number of credits while looking exactly like a real one, and a `verified:
boolean` flag does not make a wrong shape right — the same reasoning that
refused such a flag in ADR-0032. `VerifiedModelPricing` is per-native-resolution
with a documented `maxBilledSeconds` and a provenance note, because the one
pricing contract already verified (OpenVideo) is resolution-dependent and the
current `costPerSecondMinor` cannot represent it.

### 8. `fal` is a catalog identity, not a wired adapter

`ProviderName` gains `"fal"`. `VIDEO_PROVIDER` deliberately does **not**: the env
enum still accepts only `fake` and `wavespeed`, `createVideoProvider` has no fal
branch, and a test asserts that `VIDEO_PROVIDER=fal` fails validation. No
configuration can point execution at an adapter that does not exist, and no
startup path can contact fal.

**Being the default model and being an executable request are different things,
and only the second costs money.** This ADR enables no paid provider execution.

### 9. Existing generations are never retargeted

`SceneGeneration.providerName` and `providerModelId` are part of the immutable
request snapshot, and request identity is computed from those persisted facts —
never from a catalog lookup. Changing the default therefore cannot move an
admitted generation onto H3 Max, and a test pins it.

## What this milestone deliberately does not do

**No persistence or request-identity change.** `VideoProject.resolution`,
`SceneGeneration.requestResolution`, `GenerationRequestFacts.resolution` and
`ProviderGenerationInput.resolution` are untouched, and the request hash is
unchanged. Under today's single-field contract those values are
**LEGACY_AMBIGUOUS**: each is simultaneously the product target and the native
token, because for the only wired model they coincide.

Separating them changes what is hashed and what a persisted row means, and it
must fail closed for legacy rows whose native resolution cannot be reconstructed
— today's stored `"720p"` provably meant "OpenVideo native 720p", but only
because OpenVideo was the only model. That migration is **Phase 4C-3B-2B**, and
mixing it into catalog design is exactly the combination the scope discipline
warns against. The semantic ledger classifying every occurrence is in
`docs/phase-4c3b2a-completion.md`.

Also absent: any fal adapter, paid generation, real submission, worker loop,
submission audit, polling, output ingestion, upscaling, composition, billing,
automatic fallback, automatic retry, and automatic cost/quality routing.

## Consequences

- The catalog and the wired execution provider now disagree by design: the
  default *model* is fal-hosted while the default *provider* is `fake`. That is
  the intended state until a fal adapter and the paid gate exist, and it is
  visible rather than implicit.
- `planGenerationResolution` refuses two of four entries. Callers must handle
  refusal, which is the point — an unverified model cannot slip into a paid path.
- Two capability vocabularies now coexist: `capability.resolutions` lists
  **native** tokens (`480P`, `768P` for H3 Max), while the policy keys list
  **product** outputs. The overlap for OpenVideo (`720p`, `1080p` in both) is a
  coincidence of that model, not a rule.
- Actual raster normalization remains composition's (Phase 5). This milestone
  records what would be required and performs none of it.
- The WaveSpeed-centric Phase 4C-3B-2 branch is **superseded and read-only**. It
  is not merged, rebased or cherry-picked; after 3B-2B a new provider-agnostic
  submission-certainty milestone will salvage individually revalidated ideas
  from it, and no commit is accepted merely because it existed there.
- Production remains dormant: `createGeneration` has zero production callers, and
  there is no paid gate, submission audit, worker loop or provider POST.

## Still blocking paid generation

Unchanged and cumulative: ADR-0032's submission-certainty contract is not
implemented; the paid gate may not be enabled until pricing is resolution-aware
and verified **for every selectable model**, which now includes H3 Max, whose
pricing is `null`.
