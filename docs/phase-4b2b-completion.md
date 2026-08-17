# Phase 4B-2b — The prompt renderer

Status: **awaiting CTO review. Not merged.**

Branch: `claude/real-estate-virtual-tour-phase-4b2b-hga252`
Base: `be9259681ba3caf179f8ec73aee98943a9672cd8` (merged Phase 4B-2a, PR #34)

## Why this milestone exists

ADR-0014 made a compiled prompt **structure** rather than a string, and ADR-0018
kept it structured through persistence so that "exactly one [renderer] can be
built later at the provider boundary". ADR-0019 then verified the selected
model and found it exposes one text input: `prompt`. It nevertheless declared
`cameraMotion: PROMPT_RENDERED`, and said plainly that this was a promise about
a renderer that did not exist and that nothing verified.

This milestone writes that renderer, and pins the declaration to it.

## What shipped

### `renderPrompt` — one function, in the domain

`packages/domain/src/generation/prompt-render.ts`. Pure, total, one-way:
`CompiledPrompt` in, string out; nothing mutated, no clock, environment, or
network. It lives in the domain because *what the model is told* is product
policy — the preservation rules are quoted from `docs/AIVideoPipeline.md` and a
second provider must inherit them rather than invent its own phrasing.

Sample output:

```
Room: living room

Preservation rules:
- Preserve visible structure, windows, doors, equipment, materials, and finishes as far as technically possible.
- Do not add nonexistent furniture, equipment, views, openings, or rooms.
- Do not change material or apparent room size.
- Do not add people or fictional logos.

Avoid:
- people
- fictional logos or branding
- invented windows, doors, or rooms
- text overlays claiming measurements or floor plans

Camera motion requested by the customer (the rules above take precedence):
slow dolly forward

Styling requested by the customer (the rules above take precedence):
warm evening light, calm pace
```

The format, its costs, and its reversal conditions are ADR-0020.

### The user's negative prompt is structurally excluded

`renderPrompt` projects onto a narrow internal type with **no field capable of
carrying** `negativeConstraints.user`, and `CompiledPrompt` is not assignable to
that type, so it cannot be forwarded wholesale by accident. The same type omits
`assetId`, `position` and `durationSeconds`, so an internal identifier has no
route into a provider payload.

This is a review affordance, not an impossibility proof — a caller could build
the narrow type by hand and put the wrong text in the wrong field. What it buys
is that the mistake must be written down where a reviewer reads it, and a
sentinel-string test fails if it ever is. ADR-0020 §5 states that limit rather
than overclaiming.

### The `PROMPT_RENDERED` pinning test — the completion condition

`capability.test.ts` asserts `OPEN_VIDEO_CAPABILITY.cameraMotion` equals
`PROMPT_RENDERED` **only if** the renderer demonstrably carries the requested
motion *and* omits it when there is none. A renderer that stopped carrying
motion would not fail this loosely — it would demand the descriptor become
`UNSUPPORTED`. The declaration follows the behaviour.

A second test submits the rendered string through `mapToWaveSpeedRequest` and
asserts the motion is inside `body.prompt`, so the linkage covers the actual
provider payload rather than the renderer in isolation. A third asserts that
`negativePrompt: UNSUPPORTED` stays honest — the renderer never delivers a user
negative by another route.

### Two unread fields removed from the type that describes a paid request

`negativePrompt` and `cameraMotion` are gone from `ProviderGenerationInput`.
Neither was read: Phase 4B-2a stopped sending `negative_prompt` and
`camera_motion` because the model documents neither, and motion now travels
inside `prompt`. An unread optional field there reads as a capability the system
has — which is how the earlier undocumented-field defect stayed invisible.

### The self-check asked for a duration the model would reject

`health.ts` and `bootstrap.ts` used `durationSeconds: 1`, outside the
descriptor's documented 3–20s range. `estimateCost` never validates, so nothing
failed and the check exercised the adapter with a request admission would
refuse. Both now use 5, and a worker test reads the accepted range **from the
descriptor** rather than restating 3 and 20.

### The README claimed Phase 2

Rewritten to state Phase 4 in progress, and — more usefully — to say what the
product still cannot do: no worker, no queue adapter, no managed-storage copy,
so no video is generated yet.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm test` | **1052 passed**, 55 files (baseline 1031 / 54; **+21 tests, +1 file**) |
| `pnpm build` | clean |
| `pnpm test:db` | **123 passed**, 6 files (pure regression) |
| `prisma migrate diff --from-migrations` | `No difference detected.` (exit 0) |

Explicitly re-verified: the 8-fact `requestHash` tuple unchanged, same order;
all five Phase 4B-1c snapshot fields unchanged; **zero** Prisma/schema/migration
diff; no provider call added; no worker, queue adapter, or storage
implementation; no moderation change; no HTTP route, DTO, or UI change;
`CompiledPrompt` is not exposed over HTTP.

### Mutation verification

Each mutation was applied to the merged implementation, the suite run, and the
implementation restored and re-verified green (1052/55).

| Mutation | Result |
| --- | --- |
| Renderer stops emitting the camera-motion section | **5 fail**, including both pinning tests |
| Renderer folds `negativeConstraints.user` into the `Avoid:` list | **2 fail** |
| Self-check duration reverted to 1 | **1 fail** |

The first is the one that matters: it fails the descriptor-linkage test, which
is the assertion that would otherwise have been a tautology.

### Infrastructure note

`pnpm test:db` first failed with `Environment variable not found: DATABASE_URL`,
and the local PostgreSQL cluster was also down (`pg_lsclusters` → `down`, stale
pid file). Both are environment faults, not code defects: the cluster was
restarted with `pg_ctlcluster 16 main start`, the `revt` role password reset, and
`DATABASE_URL` supplied to the run. **No repository file was modified**, and the
rerun passed 123/123. Recorded because a failed local dependency is not a
finding about this change.

## Findings

**`sceneFacts.cameraMotion` is unmoderated customer free text, and ADR-0019 §8
described it as system-derived.** It is typed into the create panel, flows
project → scene → `SceneFacts`, and `compileScenePrompt` moderates `prompt` and
`negativePrompt` but not this. `SceneFacts`' own doc comment says
"System-derived, never user text", which for this field is wrong.

Constraint 2 required rendering it, so it is rendered — but **under a customer
heading below the rules**, alongside the styling request, rather than laundered
as a system fact above them. Moderation was deliberately **not** widened here:
changing what admission accepts belongs in its own reviewable change. ADR-0019
§8 carries a dated amendment correcting the claim, and the gap is recorded in
`docs/decisions/TODO.md`.

**The rendered string is not covered by the request hash.** Request identity
hashes the compiled prompt *structure*; the submitted string is a function of
that structure **and the renderer's code**, and the renderer version is recorded
nowhere on the row. A generation admitted under one renderer version and executed
after a deploy that changed a heading would submit text the approved request
never described, under a hash that still validates.

Nothing detects this today only because nothing submits yet. It is recorded as a
**Phase 4C prerequisite** with two candidate shapes — pin a renderer version into
the request identity, or freeze the rendered string at admission — and the choice
is left to that phase rather than pre-empted here. The renderer was kept minimal
partly because of this: it authors headings and bullet characters and no prose.

**Three documentation sites carried the now-false "nothing verifies this yet"
claim** — the domain `FeatureDelivery` doc, the OpenVideo descriptor comment, and
ADR-0019 §2/§8. These were corrected in Task A to state the declaration was
*unpinned*; leaving them would have inverted the same defect. All three now state
what actually holds, and ADR-0019 gets dated amendments rather than a rewrite.

## Deliberately not done

- **No moderation change.** See above.
- **No renderer-version pinning.** Phase 4C owns the shape; guessing it here
  would add a column or a hash input nobody has reviewed.
- **No prompt-length budget.** The vendor publishes no limit, and no paid call
  may be made to discover one. ADR-0020 names the reversal condition instead.
- **No `CompiledPrompt` over HTTP**, no DTO change, no worker, no queue adapter,
  no provider call, no Phase 4C work.

## Size

| Category | Lines changed |
| --- | --- |
| Production | 220 |
| Tests | 302 |
| Docs | 510 |
| **Total** | **1,032** |

Above the ~500 reviewability guideline, and roughly half of it is documentation —
ADR-0020 is 285 lines on its own. **Production is 220 lines** across five files.
The split that would reduce the number is not available: the renderer, the
pinning test that makes the descriptor honest, and the removal of the two fields
the renderer supersedes are one change; shipping the renderer without the pin
would re-open exactly the gap this milestone closes.

## Obligations created

Recorded in `docs/decisions/TODO.md`:

1. **Phase 4C prerequisite** — the rendered prompt is not covered by the request
   hash.
2. Camera motion reaches the model as unmoderated customer text; the
   `SceneFacts` comment is wrong for that field.
3. Prompt length is unbounded and unmeasured; measurable in Phase 4C/4D.

Two earlier obligations are **closed** by this milestone: the `PROMPT_RENDERED`
pinning test, and the adapter-sends-undocumented-fields item (closed by 4B-2a's
merge, with 4B-2b removing the unread type fields).
