# Phase 4B-2a — Honest provider contract

Status: **awaiting CTO review. Not merged.**

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

`COMPOSITION_OWNED` accepts without provider-value validation — the provider is
never asked, so its opinion is irrelevant to a guarantee it does not make.
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
| `pnpm test` | **999 passed**, 54 files (+47) |
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

## Obligations created

Recorded in `docs/decisions/TODO.md`:

1. **Phase 5 HARD PREREQUISITE** — normalize the delivered video to the admitted
   `requestAspectRatio`. Phase 5 is not complete while the product can accept a
   requested ratio and silently deliver another one.
2. **Phase 4B-2b** must render camera-motion intent into the positive prompt, or
   the `PROMPT_RENDERED` declaration becomes a lie and must change.
3. `preset` contract unresolved.
4. Earlier duration validation as a UX follow-up.
