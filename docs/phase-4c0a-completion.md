# Phase 4C-0a — Execution prompt freeze

Status: **awaiting CTO review. Not merged.**

Branch: `claude/real-estate-virtual-tour-phase-4c0a-hga252`
Base: `35970da89996fe34e5c9439b50b4fabd7bba711f` (merged Phase 4C-0b, PR #36)

## Why this milestone exists

The last of the two hard prerequisites before Phase 4C may implement real provider
submission.

Phase 4B-1c froze *what was asked for*. Phase 4B-2b built the single renderer that
turns that into the string a provider receives, and its review recorded the gap
this milestone closes: the submitted bytes depend on the hashed structure **and
the renderer's code**, and the renderer version was recorded nowhere. A generation
admitted under one renderer and executed after a deploy would submit text the
customer's approved request never described, under a `requestHash` that still
validated.

Phase 4C-0b then demonstrated how real that is by *changing the renderer* — the
camera-motion section lost its caveat and gained a token→sentence mapping, so
identical stored structures render differently either side of that merge.

## What shipped

### A sixth request-snapshot field

`SceneGeneration.requestRenderedPrompt` — the exact positive provider prompt
produced at admission. The five existing fields fix what was asked for; this one
fixes what will be sent, and they are not the same guarantee.

### Rendered once, after the reuse lookups, immediately before create

Placement is load-bearing. Rendering earlier would let a corrupt snapshot stop a
caller from being handed an attempt that **already exists** — reuse needs no
renderer, because a reused row carries its own frozen prompt.

It also means `renderPrompt`'s fail-closed validation runs before anything
durable: an unrenderable compiled prompt refuses **before** the row, the enqueue,
and the audit. A defect previously discoverable only at submission time is now
caught at admission.

### Fail closed, never re-render

`frozenExecutionPromptFrom` returns the stored bytes verbatim or throws
`INTERNAL_ERROR`. `null` means "predates the contract and cannot be submitted",
never "compute it now" — re-rendering is precisely the drift the field prevents.
It mirrors `generationRequestFactsFrom`'s refusal for pre-snapshot rows.

### The hash is deliberately untouched

Adding rendered bytes to the 8-fact tuple would make every renderer change
invalidate reuse and **duplicate paid work for identical customer requests**.
ADR-0023 §2 records the consequences that follow instead: two rows may share a
hash and carry different frozen prompts; succeeded reuse crosses renderer
versions; a terminal retry re-renders because it is a re-admission.

### Additive migration, no backfill

One nullable `TEXT` column. Backfilling would render historical rows with today's
renderer — fabricating the very bytes the column exists to pin down.
`tests/schema/execution-prompt-freeze-column.test.ts` parses the SQL and asserts
the shape *and* the absence of `UPDATE`/`INSERT`/`DELETE`/`TRUNCATE`, any index,
and any reference to `requestHash`.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm test` | **1147 passed**, 58 files (baseline 1124 / 56; **+23 tests, +2 files**) |
| `pnpm build` | clean |
| `pnpm test:db` | **125 passed**, 6 files (+2) |
| `prisma migrate diff --from-migrations` | `No difference detected.` (exit 0) |

### Mutation verification

| Mutation | Result |
| --- | --- |
| Admission persists `null` instead of the frozen prompt | **3 fail** |
| `frozenExecutionPromptFrom` stops failing closed | **4 fail** |
| The frozen bytes differ from what the renderer produces | **1 fail** |

Each restored and re-verified green (1147/58).

### Infrastructure note

The local PostgreSQL cluster was down (stale pid file) when the DB suite first
ran, and the new migration had not been applied to the verify database. Both are
environment steps, not code defects: the cluster was restarted with
`pg_ctlcluster 16 main start`, the `revt` role password reset, and
`prisma migrate deploy` run against the verify database. **No repository file was
modified**, and the rerun passed 125/125.

## Invariants held

8-fact `requestHash` tuple **unchanged**, same order · the five Phase 4B-1c
snapshot fields **unchanged** · `SceneGenerationUpdate` still cannot name the new
field, so a worker writing state cannot alter what will be submitted · queue
payload still `{ generationId }` · audit metadata allowlist unchanged · no
provider submission, worker, queue consumer, polling, or retries · no renderer
version or registry · no multi-model routing · no WaveSpeedAI call.

## Findings

**Three test fixtures were not renderable.** Placeholder compiled prompts such as
`{"preservation":[],"sceneFacts":{}}` were adequate while nothing rendered them;
admission now does, so they are refused. They were rebuilt from the frozen
constants. This is the strictness working as designed, and it is a real cost worth
naming rather than hiding.

**One residual case remains, and it is not an application concern.** An operator
editing `requestRenderedPrompt` directly in the database would change what is
submitted without changing any hash. No application path can express it —
`SceneGenerationUpdate` cannot name the field — so it is database-access control,
recorded in ADR-0023 rather than papered over.

## Deliberately not done

- No provider submission, worker, or queue consumer — Phase 4C proper.
- No renderer-version registry. Keeping the *result* rather than the *recipe* is
  simpler and stronger; ADR-0023 §5 records why.
- No hash change, no backfill, no index.

## Size

See the pull request body for the final measured production/test/docs figures,
taken from `git diff --numstat 35970da..HEAD` after the final commit exists.
