# ADR-0019: Provider capability ownership and the verified OpenVideo contract

Status: Accepted (Phase 4B-2a)
Date: 2026-08-15

## Context

Phase 4B-1a shipped a capability contract with deliberately no real values, and
Phase 4B-1b made admission depend on it. Phase 4B-2 finally checked the selected
model against the official WaveSpeedAI documentation for
`wavespeed-ai/open-video/image-to-video`, verified during CTO review.

The documented request parameters are `image` and `prompt` (required),
`resolution` (`480p` / `720p` / `1080p`, default `480p`), `duration` (integer
seconds `3`–`20`, default `5`), and `seed` (optional, default `-1`). The
parameter table lists **no** `aspect_ratio`, **no** `negative_prompt`, and **no**
`camera_motion`. The documentation does state that the prompt controls
motion and scene, which is not the same as a dedicated field.

Two problems followed, and the second is what forced a type change.

**The adapter was sending three fields the endpoint does not document.**
`mapToWaveSpeedRequest` sent `aspect_ratio`, `negative_prompt` and
`camera_motion`, and `mapping.test.ts` asserted it did — the test froze a
shape nobody had verified.

**The obvious honest descriptor would have blocked the entire product.**
`AspectRatioSupport` was binary. With no `aspect_ratio` parameter, the only
non-lying value was `UNSUPPORTED`, and `assertSettingsSupported` refuses
*unconditionally* on `UNSUPPORTED` — before it even reads the requested value.
Every `VideoProject` carries an aspect ratio (`String` NOT NULL in Prisma,
non-nullable in the domain, `requiredString` in the API, required in the create
form), so **100% of `startScene` admissions would have failed.** A boolean forced
a choice between claiming support the provider does not offer and refusing all
work.

## Decision

### 1. Capability declares *who guarantees* delivery, not whether a field exists

`AspectRatioSupport` becomes three-way:

- `PROVIDER_HONORED { ratios }` — the model accepts a ratio and delivers it;
  the request is validated against the listed values.
- `COMPOSITION_OWNED` — the provider is never asked. Admission accepts without
  provider-value validation, because the provider's opinion is irrelevant to a
  guarantee it does not make.
- `UNSUPPORTED` — nothing in the system can deliver one; refuse.

This is not "ignore the request". It moves the obligation and records where it
landed (§6).

### 2. Optional inputs declare *how* they are delivered

`FeatureSupport` (`"SUPPORTED" | "UNSUPPORTED"`) becomes `FeatureDelivery`:

- `PROVIDER_FIELD` — a documented dedicated parameter carries it.
- `PROMPT_RENDERED` — no dedicated parameter, but the approved renderer
  expresses the intent faithfully through the documented `prompt` input.
- `UNSUPPORTED` — cannot be expressed; refuse.

`PROMPT_RENDERED` is a **promise about the renderer** that the type system
cannot check.

**As of Phase 4B-2a that promise is unpinned.** No renderer exists yet, so no
test can tie the declaration to any behaviour — the only test writable today
would assert that the constant equals `PROMPT_RENDERED`, which restates the
declaration rather than verifying it. Writing the pinning test is a **completion
condition of Phase 4B-2b**, alongside the renderer itself: if that phase's
renderer does not carry camera-motion intent, this declaration is false and must
become `UNSUPPORTED`. Nothing can submit to a provider before then (§8), so the
gap admits no paid work in the interim.

### 3. The verified OpenVideo descriptor

```
providerName:    wavespeed
providerModelId: wavespeed-ai/open-video/image-to-video
durationSeconds: RANGE 3–20 (integer)
resolutions:     480p, 720p, 1080p
aspectRatios:    COMPOSITION_OWNED
negativePrompt:  UNSUPPORTED
cameraMotion:    PROMPT_RENDERED
```

Every value is transcribed from the official documentation. It lives in
`@app/video-providers` beside the adapter: the domain owns the *shape* of a
capability and the rule applied to it, the adapter package owns the *values*.

### 4. OpenVideo receives only documented fields

The request body is `image`, `prompt`, `duration`, `resolution`, and `seed` when
supplied. `aspect_ratio`, `negative_prompt`, `camera_motion` and `preset` are
**not sent**. An exact key-set assertion — not `toMatchObject` — makes an
undocumented field impossible to reintroduce quietly.

Tests follow the provider contract; they do not freeze a shape the vendor never
accepted.

### 5. Aspect ratio remains a request, identity, and snapshot fact

`aspectRatio` stays on `VideoProject`, in `GenerationRequestSettings`, in the
**unchanged** 8-fact `requestHash` tuple, and as `requestAspectRatio` in the
immutable Phase 4B-1c snapshot. Nothing about request identity changes, no
persisted hash is invalidated, and no migration is required.

### 6. Phase 5 owns final aspect-ratio normalization

**Phase 5 MUST normalize the delivered video to the admitted
`requestAspectRatio`.** Phase 5 is not complete while the product can accept a
requested ratio and silently deliver another one. This is not an OpenVideo
guarantee and must never be described as one.

### 7. A user negative prompt is unsupported for OpenVideo

A project carrying non-blank user negative text is refused at admission. Blank
and whitespace-only text remains *absent* under the existing normalization, so
such projects are unaffected.

The text is **never** folded into the positive prompt: that inverts its meaning,
and ADR-0014 keeps system and user negatives structurally distinct precisely so
this cannot happen silently.

The provider-neutral `negativePrompt` field stays in the HTTP, domain, and
database contracts — a future model may honour it — but the **project-creation
UI no longer offers it**, so customers are not invited to configure a feature the
only production model cannot honour and then failed later.

### 8. Camera-motion intent is approved for prompt rendering

`cameraMotion` is `PROMPT_RENDERED`. `CompiledPrompt.sceneFacts.cameraMotion` is
a *system-derived scene fact*, not user negative text, so expressing it in the
positive prompt is consistent with the existing semantic contract rather than a
workaround. **Phase 4B-2b must satisfy that obligation.** No dedicated
`camera_motion` field is sent regardless.

The renderer's textual format is deliberately **not** defined here — Phase 4B-2b
owns it, and freezing it prematurely would constrain a design not yet written.

### 9. `preset` remains unresolved

It appears in a Quick Start example but not in the parameter table. An example is
not a specification, so it is not sent and its contract stays recorded as
unresolved provider evidence.

### 10. One authoritative model identity, with the frozen model still winning

`WAVESPEED_OPEN_VIDEO_MODEL_ID` in `@app/shared` is the single source: the env
schema's default reads it and the capability descriptor reads it. It lives in
`@app/shared` because `@app/video-providers` depends on `@app/shared` and not the
reverse, so a constant in the adapter package could not supply the schema default.

`WaveSpeedConfig.modelId` is **removed**. Nothing read it — the adapter builds
every submit URL from `input.modelId` — and a second, unread identity let the
descriptor and the configured default drift apart unnoticed.

The stronger execution invariant is unchanged and now tested: **`input.modelId`
is authoritative for an already-admitted generation.** The configured default
applies to *new* admissions only and can never retarget work already admitted
under a frozen `providerModelId`.

### 11. Amended after review: one model identity is enforced, not merely defaulted

Review found that `WAVESPEED_VIDEO_MODEL_ID` accepted any non-empty string while
the capability descriptor hard-coded the constant. Setting it to a different id
split the system in two: the health and worker self-checks exercised the
configured model, while admission validated against OpenVideo's capabilities and
froze OpenVideo's id onto the row — so a later submission would have paid
OpenVideo for work the operator had configured elsewhere.

**Production has exactly one model identity, and an arbitrary override cannot
switch models during Phase 4B-2a.** The variable stays for compatibility but may
only *restate* the supported id; any other value fails closed at configuration
resolution, so a misconfigured deployment cannot start and admit anything.
Supporting a genuinely different model requires a verified capability descriptor
for it — a deliberate decision, not an environment override. This is not
multi-model routing, and none is introduced.

**This is a deviation, and it is recorded as one.** `WAVESPEED_VIDEO_MODEL_ID`
remains a configuration variable in name while accepting exactly one value, so
the schema now rejects inputs that are, in isolation, perfectly well-formed. An
operator reading only the variable's name would reasonably expect to be able to
select a model. That expectation is deliberately not met: a model id without a
verified capability descriptor is not a configuration choice, it is an
unvalidated request contract pointed at a paid endpoint. Failing closed is the
lesser cost. The variable is kept rather than deleted so existing deployments and
the two self-check call sites continue to resolve, and so the constraint is
visible where an operator would look for it.

**Exit path.** Nothing here is meant to be permanent, and the deviation should
not calcify into "one model forever". The shape that removes it is a **keyed
descriptor registry**: a map from model id to its verified `VideoModelCapability`,
with the environment variable validated against the registry's keys rather than
against a single constant. Adding a model would then mean adding a verified
descriptor — the evidence-gathering step this ADR exists to enforce — and the
schema check would relax on its own, with no further ADR needed. Admission would
select the descriptor by the configured id, and a persisted `providerModelId`
would resolve through the same registry, preserving the frozen-model invariant of
§10 unchanged.

That registry is **not built here**. It has no second model to hold, so building
it now would be speculative structure around a set of one, and the honest state
today is a single verified descriptor plus a check that says so. The work is
recorded in `docs/decisions/TODO.md` and belongs to whichever phase first has a
second verified model to add.

### 12. Amended after review: `COMPOSITION_OWNED` still requires valid syntax

Review also found that `COMPOSITION_OWNED` skipped **every** aspect-ratio check,
so an arbitrary non-empty string such as `wide` or `banana` passed admission,
entered the request hash, was frozen into the immutable snapshot, and became
billable work the composition stage could never normalize to.

`COMPOSITION_OWNED` means *the provider does not validate or honour the requested
ratio*. It does **not** mean any string is a ratio.

Aspect-ratio **syntax validation is mandatory for every ownership kind** and runs
*before* the ownership branch:

| Case | Behaviour |
| --- | --- |
| blank or syntactically invalid | reject, whatever the ownership |
| `COMPOSITION_OWNED` + valid syntax | accept; no provider allowlist applies |
| `PROVIDER_HONORED` + valid syntax | accept only if also in the provider's list |
| `UNSUPPORTED` | reject |

Only the provider *allowlist* is skipped under `COMPOSITION_OWNED`; system-level
syntax validation is never skipped. Accepted form is `width:height` with positive
numbers, integer or decimal — `16:9`, `9:16`, `1:1`, `4:3`, `2.39:1`. Zero,
negative, non-numeric, malformed-separator and multi-part values are refused.

The value is **read, never rewritten**: no trimming, rounding, or
re-representation, because the string is a request-hash fact and normalizing it
would silently change request identity. No new domain type or schema is
introduced — the existing string contract is unchanged and only admission is
strengthened.

### 13. Both amendments leave every durable contract untouched

The 8-fact `requestHash` tuple, all five Phase 4B-1c snapshot fields, the Prisma
schema, and the migrations are **unchanged**. No historical hash is rewritten.
Both fixes are admission- and configuration-time validation only.

## Consequences

- The product can generate again: `COMPOSITION_OWNED` unblocks the 100% refusal
  the honest binary descriptor would have caused.
- The adapter no longer guesses at the vendor's API on the one path that spends
  money.
- Phase 5 inherits a hard, recorded obligation; Phase 4B-2b inherits the
  camera-motion rendering obligation.
- Projects created through the API with a negative prompt still fail admission
  honestly rather than having their text silently dropped.
- `@app/video-providers` now depends on `@app/domain`, matching `@app/database`,
  `@app/storage` and `@app/ai-providers`. It was the only adapter package that
  did not, because it predates the domain's ports.
- No schema, migration, request-hash, or snapshot change.

## Alternatives rejected

**Mark aspect ratio `SUPPORTED` anyway.** A lie, and exactly what the capability
contract exists to prevent.

**Mark it `UNSUPPORTED` and ship.** Honest, and blocks every admission.

**Assume OpenVideo preserves the source image's ratio.** Plausible for
image-to-video, unevidenced in the documentation, and forbidden — a product
guarantee resting on an assumption is not a guarantee.

**Remove `aspectRatio` from the request hash.** Would invalidate the Phase 4B-1c
self-verification invariant for every persisted generation and rewrite history.

**Fold the user negative prompt into the positive prompt.** Inverts its meaning.

**Keep sending the three undocumented fields** because existing tests expected
them. Tests do not override a vendor contract.
