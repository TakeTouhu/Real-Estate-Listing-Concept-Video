# Phase 4A-1 Completion Report — Generation state model and request identity

Milestone: Phase 4A-1 (first milestone of Phase 4)
Scope: pure domain only — no persistence, no provider call, no worker, no HTTP or UI

## What this milestone is

The vocabulary that Phase 4A-2's database invariants, Phase 4B's orchestration,
and Phase 4C's worker all have to agree on, established **before** any of them
exist. The split was approved for exactly this reason: the partial unique index
in 4A-2 depends on which states hold the generation identity, so that set should
be reviewed as a decision rather than discovered inside a migration.

Nothing here is reachable. There is no service, no route, no queue consumer, and
no provider call.

## State vocabulary

Eight states. Each exists because the *external* call has that semantic.

| State | Meaning |
| --- | --- |
| `QUEUED` | local job exists; the provider POST has not begun |
| `SUBMITTING` | the submission POST is in progress |
| `PROCESSING` | a prediction id is known, so status may be polled |
| `SUCCEEDED` | terminal |
| `FAILED_RETRYABLE` | failure *known* to be safe to retry |
| `FAILED_TERMINAL` | terminal |
| `SUBMISSION_UNKNOWN` | the POST may have been accepted and billed; no prediction id obtained |
| `CANCELLED` | pre-submission cancellation only |

## Transition contract

```
QUEUED             → SUBMITTING, CANCELLED
SUBMITTING         → PROCESSING, FAILED_RETRYABLE, FAILED_TERMINAL, SUBMISSION_UNKNOWN
PROCESSING         → SUCCEEDED, FAILED_TERMINAL
FAILED_RETRYABLE   → QUEUED
SUBMISSION_UNKNOWN → (nothing)
SUCCEEDED          → (nothing)
FAILED_TERMINAL    → (nothing)
CANCELLED          → (nothing)
```

Four consequences worth stating, because each is a decision rather than an
omission:

- **`FAILED_RETRYABLE → SUBMITTING` is absent.** A retry re-enters through
  `QUEUED`, so there is one path into a POST rather than two.
- **`PROCESSING` has no failure-retry edge.** A failing status GET is retried in
  place, not recorded as a state change: GET is idempotent, and an edge here
  would invite resubmitting a prediction that already exists.
- **Post-submission cancellation is absent.** `SUBMITTING → CANCELLED` and
  `PROCESSING → CANCELLED` are refused; whether the provider offers useful
  cancellation semantics is not yet known.
- **Terminal states have no outgoing edges at all.** A deliberate regeneration
  is a new job, so a previous attempt's record — possibly of a paid call — is
  never overwritten.

## Active and terminal sets

| Set | Members |
| --- | --- |
| **Active** (holds the local generation identity) | `QUEUED`, `SUBMITTING`, `PROCESSING`, `FAILED_RETRYABLE`, `SUBMISSION_UNKNOWN` |
| **Terminal** (releases it) | `SUCCEEDED`, `FAILED_TERMINAL`, `CANCELLED` |

Both are declared explicitly rather than one being derived from the other, and a
test proves they partition the vocabulary — so the agreement is checked, not
assumed.

`ACTIVE_SCENE_GENERATION_STATES` is exported specifically so Phase 4A-2's
hand-written `WHERE state IN (…)` predicate has a single source, and a test pins
its exact contents so the SQL and the domain cannot drift apart silently.

## `SUBMISSION_UNKNOWN` behaviour

- **Reachable** from `SUBMITTING` when acceptance cannot be ruled out — timeout,
  connection reset, a drop before a prediction id arrives, or a response that
  does not establish the outcome.
- **No automatic exit whatsoever.** `→ QUEUED` and `→ SUBMITTING` are refused
  because the provider may already hold a billed prediction. `→ PROCESSING` is
  refused too, because asserting a prediction id we never received would be
  worse than stopping.
- **Active for identity purposes.** It continues to hold
  `(videoProjectId, requestHash)`, which is what stops a second job — and so a
  second paid POST — being created for the same request.
- **Active is not "automatically retryable".** Those are two properties, and the
  tests assert them separately; conflating them would either strand the identity
  or authorise a duplicate POST.

No operator reconciliation transition was invented. The operational consequence
— a single dropped connection blocks that scene until a human resolves it — is
recorded in ADR-0016 §11 and as a focused entry in `docs/decisions/TODO.md`.

## Request-hash input contract

`computeGenerationRequestHash(facts) → "sha256:<64 hex>"`

Hashed, as a fixed-order tuple then `JSON.stringify` then SHA-256, following the
`computeCompositionFingerprint` discipline:

`assetId` · `compiledPrompt` · `durationSeconds` · `cameraMotion` ·
`aspectRatio` · `resolution` · `providerName` · `providerModelId`

Not hashed: scene position, `sourceAnalysisRevision`, `storyboardSceneId`,
timestamps, tenant and user ids, prediction id, temporary output URL. The type
does not carry any of them, so the exclusion is structural — the tests pass
contaminated objects and prove the digest does not move.

`compiledPrompt` is the persisted canonical structure, compared textually. No
semantic equivalence, and no renderer-versioning framework; if Phase 4B finds a
renderer change can alter provider input while the stored prompt is identical,
it may add a narrowly justified request-version fact.

The tuple is positional, so property arrival order on the input object cannot
reach the digest — asserted directly.

## Provenance facts

`SceneGenerationProvenance` names the minimum a persisted attempt carries so it
is understandable **without** the storyboard scene it came from:
`sourceStoryboardSceneId`, `assetId`, `sourceAnalysisRevision`, `requestHash`,
`providerName`, `providerModelId`.

The field name says what the type is: `sourceStoryboardSceneId` is provenance,
**not** a foreign key. `replaceForProject` deletes every scene row and re-inserts
with fresh ids on each compose, so an attempt that may represent a paid call
cannot depend on that row existing. Tenant ownership comes through the
persistent `VideoProject`; no `organizationId` is denormalized.

No scene snapshot: position, room type, and duration are not copied, because
`requestHash` already fixes everything that decides what would be generated.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors |
| `pnpm lint` | clean |
| `pnpm test` | **795 / 795**, 47 files (737 before, +58 new) |
| `pnpm build` | clean production build |
| `pnpm test:db` | **27 / 27**, unchanged — this milestone has no persistence |

No migration or drift run is reported as a milestone gate: the Prisma schema is
untouched.

## Size

| | Lines |
| --- | --- |
| Production | 310 |
| Tests | 345 |
| **Total** | **655** |

**Estimated 517, actual 655 — a 27% overrun, and above the approved ~450–550
range.** Reported, not trimmed. The pre-implementation re-cost was 517, below
the ~650 stop threshold, so implementation proceeded correctly; the miss is in
the estimate, not the gate.

Where it went: the state machine and its tests came in ~90 lines heavier than
projected, mostly in the `SUBMISSION_UNKNOWN` cases and the active/terminal
partition proof, and the request-hash tests ~45 heavier because the
"does not participate" contract is proved by passing contaminated objects for
each excluded fact rather than asserted once in prose.

This is the fifth consecutive milestone where my estimate ran low (3C-6a, 3C-6b,
3D-2, 3D-4b, now 4A-1), consistently by 25–60%. The pattern is stable enough
that I should be applying a standing multiplier to my own figures rather than
reporting the miss each time; I will do so from Phase 4A-2. Documentation is
excluded from the count, as in every prior milestone.

## Scope boundaries

Unchanged in this PR: Prisma schema, migrations, `packages/database`,
`packages/queue`, `apps/worker`, `apps/web` (routes and UI),
`packages/video-providers`, `packages/storage`, and all Phase 3 code.

The only non-new production line is one export added to
`packages/domain/src/index.ts`.

## Known limitations

- **Nothing calls any of this yet.** It is a contract awaiting its first
  consumer in Phase 4A-2.
- **`SUBMISSION_UNKNOWN` has no resolution path.** Deliberate, and tracked.
- **The production model is not selected.** Whether a WaveSpeedAI model can
  satisfy the aspect-ratio, negative-prompt, and duration contracts is Phase
  4B's provider-fit review. No capability constants appear here.
- **No credit ledger.** Duplicate-paid-call protection is not billing
  settlement; accounting stays in Phase 6.
