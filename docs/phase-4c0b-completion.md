# Phase 4C-0b — Camera motion safety

Status: **awaiting CTO review. Not merged.**

Branch: `claude/real-estate-virtual-tour-phase-4c0b-hga252`
Base: `cd9d1365682dcf619b07dc184ef335f7d4de65a7` (merged Phase 4B-2b, PR #35)

## Why this milestone exists

One of the two hard prerequisites before any Phase 4C provider submission.
Camera motion was arbitrary customer text on a path that ends at a paid model,
and it was the one field on that path `compileScenePrompt` never moderated. The
full trace is in ADR-0022; it was verified again here from committed code rather
than from comments.

Phase 4B-2b's mitigation was placement below the preservation rules. ADR-0020 §4
said plainly that this is a mitigation, not a control. This milestone replaces it
with a boundary.

## What shipped

### A closed vocabulary

`STATIC`, `SLOW_DOLLY_FORWARD`, `SLOW_PAN_LEFT`, `SLOW_PAN_RIGHT`; `null` means
unspecified. Backward dollies, tilts and zooms are excluded — a single still
photograph cannot support them without inventing geometry.

**Classification: customer-selected, system-constrained intent.** Not free text,
and deliberately not "system-derived" either — the customer still decides what
the scene does; only the phrasing became ours.

### Enforced in the domain, at three moments

`assertApprovedCameraMotion` is called from `createProject`, from `compose`, and
from `startScene`. Not from the HTTP route and not from the form: the same route
serves API callers who never load the page, so a control the UI hides is not a
control. The renderer validates independently, so what gets *sent* is checked
even if what got *written* somehow was not.

### A reviewed sentence per token

Typed as a total `Record<CameraMotion, string>` in the renderer, so adding a
token without phrasing is a compile error. The token is never emitted —
`SLOW_DOLLY_FORWARD` is an internal identifier, not prose. The mapping lives with
the renderer because *which intents exist* is product and *how one is worded to a
model* is rendering policy.

### Ordering unchanged, heading corrected

Camera motion was **not** promoted above the preservation rules. The words are
ours; the intent is the customer's, so the safety rules stay structurally prior.
The heading drops its "the rules above take precedence" caveat — there is no
customer text left in the section to caveat — and becomes
`Camera motion (customer-selected):`.

### The type narrows, and the compiler found the rest

`SceneFacts.cameraMotion` becomes `CameraMotion | null`. That surfaced every
fixture in the repository still assuming free text — seven files — and makes the
module's own "never user text" comment true rather than aspirational.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm test` | **1112 passed**, 56 files (baseline 1067 / 55; **+45 tests, +1 file**) |
| `pnpm build` | clean |
| `pnpm test:db` | **123 passed**, 6 files (pure regression) |
| `prisma migrate diff --from-migrations` | `No difference detected.` (exit 0) |

### Mutation verification

| Mutation | Result |
| --- | --- |
| Drop the admission check | **2 fail** |
| Drop the `createProject` and `compose` checks | **4 fail** |
| Renderer emits the raw token instead of the sentence | **8 fail** |

Each restored and re-verified green (1112/56).

## Invariants held

8-fact `requestHash` tuple **unchanged** — a token is a string, so historical
hashes stay interpretable, and `GenerationRequestFacts.cameraMotion` stays
`string | null` on purpose · all five snapshot fields **unchanged** · **zero
diff** in Prisma schema, migrations, `packages/database`, `packages/queue`,
`packages/storage` · **no migration** · no moderation change · no provider
submission, worker, or queue consumer · no multi-model routing · no WaveSpeedAI
call.

## Deliberately not done

- **Phase 4C-0a** — `requestRenderedPrompt` is not added. The rendered prompt is
  still not covered by the request hash, and that remains a hard prerequisite.
- **No moderation for camera motion.** With a closed set the moderator would see
  only strings we wrote. ADR-0022 records why this is not defence in depth.
- **No legacy backfill.** Old free-text values are not mapped onto tokens; doing
  so would invent an intent the customer never chose.

## Size

| Category | Lines changed |
| --- | --- |
| Production | 295 |
| Tests | 418 |
| Docs | 309 |
| **Total** | **1,022** across 24 files |

Measured from `git diff --numstat cd9d136..HEAD` at the committed head. Above the
~800–950 estimate in the approved plan: production came in at 295 against ~150,
because narrowing `SceneFacts.cameraMotion` propagated into the UI prop chain
(server page → projects view → create panel) rather than staying inside the
domain. Tests ran to 418 against ~280 for the same reason — the fixture updates
were spread across seven files. Docs came in *under* estimate at 309 against
~420.

## Known gaps

1. Legacy projects and scenes holding free text can be read and displayed but
   cannot be composed or admitted until the field is set to an approved value.
   No generation has ever executed, so there is no production data affected.
2. The rendered prompt is still not covered by the request hash — **Phase 4C-0a**.
