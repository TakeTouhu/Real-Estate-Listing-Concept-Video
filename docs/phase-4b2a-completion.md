# Phase 4B-2a — Honest provider contract

Status: **merged.** PR #34, merge commit `be9259681ba3caf179f8ec73aee98943a9672cd8`
(a merge commit, not a squash — the three-commit sequence is the record). Local tag
`phase-4b2a-complete`, tag object `2310161d7804388262744a39c344c3bded56e211`; the
tag is **not published** — see `docs/progress.md` for the blocked-publication record.

Branch: `claude/real-estate-virtual-tour-phase-4b2a-hga252`
Base: `e52d302d582f947cdb18df3799143dd4013a2ee8` (merged Phase 4B-1c, PR #33)

## Why this milestone exists

Phase 4B-1a shipped a capability contract with deliberately no real values.
Phase 4B-2 checked the selected model against the official WaveSpeedAI
documentation for `wavespeed-ai/open-video/image-to-video` (verified during CTO
review) and found two problems.

**The adapter was sending three fields the endpoint does not document** —
`aspect_ratio`, `negative_prompt`, `camera_motion` — and `mapping.test.ts`
asserted that it did. The test froze a shape nobody had verified against the
vendor.

**The obvious honest descriptor would have blocked the entire product.**
`AspectRatioSupport` was binary, the documented parameter table has no
`aspect_ratio`, and `assertSettingsSupported` refuses *unconditionally* on
`UNSUPPORTED` — before reading the requested value. Every `VideoProject` carries
an aspect ratio (`String` NOT NULL, non-nullable in the domain, `requiredString`
in the API, required in the create form), so **100% of admissions would have
failed**. A boolean forced a choice between claiming support the provider does
not offer and refusing all work.

## What shipped

### Capability declares *who guarantees* delivery

```ts
type AspectRatioSupport =
  | { kind: "PROVIDER_HONORED"; ratios: readonly string[] }
  | { kind: "COMPOSITION_OWNED" }
  | { kind: "UNSUPPORTED" };

type FeatureDelivery =
  | { kind: "PROVIDER_FIELD" }
  | { kind: "PROMPT_RENDERED" }
  | { kind: "UNSUPPORTED" };
```

`COMPOSITION_OWNED` skips the *provider allowlist* — the provider is never asked,
so its opinion is irrelevant to a guarantee it does not make. Aspect-ratio
**syntax** validation still applies to every ownership kind (see review blocker 2
below).
`PROMPT_RENDERED` is a real delivery: the intent reaches the model through its
documented `prompt` input.

### The verified descriptor

```
providerName:    wavespeed
providerModelId: wavespeed-ai/open-video/image-to-video
durationSeconds: RANGE 3–20 (integer)
resolutions:     480p, 720p, 1080p
aspectRatios:    COMPOSITION_OWNED
negativePrompt:  UNSUPPORTED
cameraMotion:    PROMPT_RENDERED
```

### Request body, exactly

Always `image`, `prompt`, `duration`, `resolution`; plus `seed` only when
supplied. Never `aspect_ratio`, `negative_prompt`, `camera_motion`, or `preset`.
Pinned by an exact key-set assertion rather than `toMatchObject`, so an
undocumented field cannot reappear quietly.

### Model identity

`WAVESPEED_OPEN_VIDEO_MODEL_ID` in `@app/shared` is the single source — the env
schema default reads it, the descriptor reads it. It lives in `@app/shared`
because `@app/video-providers` depends on `@app/shared` and not the reverse.

`WaveSpeedConfig.modelId` is **removed**: nothing read it (the adapter builds
every submit URL from `input.modelId`), and a second unread identity let the
descriptor and configured default drift apart. The execution invariant is
unchanged and now tested — **`input.modelId` is authoritative for an
already-admitted generation**, so a configuration change cannot retarget frozen
work.

### Product UI

The negative-prompt control is removed from project creation. The HTTP, domain,
and database contracts keep the provider-neutral field — a future model may
honour it, and API-created projects still fail admission honestly rather than
having their text silently dropped. Aspect ratio and camera motion stay, because
composition and the prompt input respectively deliver them.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm test` | **1031 passed**, 54 files (+79) |
| `pnpm build` | clean |
| `pnpm test:db` | **123 passed**, 6 files (pure regression) |
| `prisma migrate diff --from-migrations` | `No difference detected.` (exit 0) |

Explicitly re-verified: request-hash tuple unchanged (8 facts, same order); all
five Phase 4B-1c snapshot fields unchanged; **zero** Prisma/schema/migration
diff; no provider call added to `GenerationService`; no worker, queue, or storage
implementation; no Phase 4B-2b renderer.

## Implementation findings

**`@app/video-providers` now depends on `@app/domain`.** The production
descriptor implements a domain port, so it must see the domain's types. This was
the only adapter package without that dependency — `@app/database`,
`@app/storage` and `@app/ai-providers` all have it — because it predates the
domain's ports. The direction is adapter → domain, matching every sibling.

**Three pre-existing test-fixture surfaces needed migration** to the new types
(`capability.test.ts`, `generation-service.test.ts`,
`generation-reconstruction.test.ts`). Mechanical, no behaviour change.

**One stale comment corrected.** `create-panel.tsx` said the provider's supported
formats were "Phase 4's to establish, and this milestone invents no capability
table" — untrue as of this PR. Rewritten to state that capabilities now exist and
are enforced server-side at admission. This is accuracy in a file the milestone
already edits, not adjacent cleanup.

**The pre-existing UI assertion was not discriminating.**
`expect(body).not.toHaveProperty("negativePrompt")` passed before the removal
too, because blank optional fields were already omitted. Replaced with
assertions on the rendered control and an exact request-body key set.

## Deliberately not done

- **No prompt renderer** — Phase 4B-2b owns it, and ADR-0019 deliberately does
  not freeze its textual format.
- **No `preset`** — appears in a Quick Start example but not the parameter
  table; an example is not a specification. Recorded as unresolved.
- **No compose-time duration clamp** — coupling Phase 3 composition to one
  provider's limits needs provider-aware composition the architecture lacks.
  Recorded as a UX follow-up.
- No pricing/billing policy, no provider call, no Phase 4C work.

## Review blockers fixed

Independent pre-merge review of `863f8de` raised two P1 blockers. Both were
confirmed real against the committed code and fixed in place.

### Blocker 1 — a conflicting model override split the system in two

`WAVESPEED_VIDEO_MODEL_ID` accepted any non-empty string while the descriptor
hard-coded the constant. With `WAVESPEED_VIDEO_MODEL_ID=vendor/other-model`, the
health and worker self-checks exercised `vendor/other-model` while admission
validated against OpenVideo's capabilities and froze OpenVideo's id onto the row
— so Phase 4C would have paid OpenVideo for work configured elsewhere.

**Fix:** the env schema fails closed at configuration resolution when the value
is anything other than `WAVESPEED_OPEN_VIDEO_MODEL_ID`. The variable stays for
compatibility but may only restate the supported id. A misconfigured deployment
cannot start, so it cannot admit anything. No multi-model routing.

The original test asserted equality only at the schema *default* — precisely the
gap the finding exploited. New tests cover the override path directly.

### Blocker 2 — `COMPOSITION_OWNED` accepted any non-empty string as a ratio

`COMPOSITION_OWNED` skipped every aspect-ratio check, and nothing upstream
validated syntax (`createProject` checks only non-blank, the API uses
`requiredString`, the UI is free text). So `wide` or `banana` was admitted,
hashed into request identity, frozen into the immutable snapshot, and enqueued as
billable work the composition stage could never normalize to.

**Fix:** syntax validation runs for **every** ownership kind, *before* the
ownership branch. Accepted form is `width:height` with positive numbers, integer
or decimal. Only the provider *allowlist* is skipped under `COMPOSITION_OWNED`.
The value is read, never rewritten — it is a request-hash fact.

### Both fixes are mutation-verified

| Mutation | Result |
| --- | --- |
| Remove the aspect-ratio syntax check | **16 of 61** capability tests fail |
| Remove the model-override guard | **4 of 36** descriptor tests fail |

Each implementation was restored and re-verified green afterwards.

## Obligations created

Recorded in `docs/decisions/TODO.md`:

1. **Phase 5 HARD PREREQUISITE** — normalize the delivered video to the admitted
   `requestAspectRatio`. Phase 5 is not complete while the product can accept a
   requested ratio and silently deliver another one.
2. **Phase 4B-2b** must render camera-motion intent into the positive prompt, or
   the `PROMPT_RENDERED` declaration becomes a lie and must change.
3. `preset` contract unresolved.
4. Earlier duration validation as a UX follow-up.
