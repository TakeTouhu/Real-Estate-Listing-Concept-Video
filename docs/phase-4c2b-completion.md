# Phase 4C-2B — Durable pre-provider refusal parking

Milestone: Phase 4C-2B
Base: `70e331359a986e25fa7e882622c39e2324b890a2` (merged Phase 4C-2A, PR #40)
Decision record: ADR-0027

> This report is an immutable technical snapshot and carries no lifecycle
> status. The GitHub pull request is the authoritative lifecycle source.

## What shipped

A refusal from Phase 4C-2A now has somewhere durable to go.

```ts
preflightFailureStateFor(reason): "FAILED_RETRYABLE" | "FAILED_TERMINAL"

failQueuedPreflight(
  generationId: string,
  reason: PreflightRefusalReason,
): Promise<FailedSceneGeneration | null>
```

**ADR-0027 carries the reasoning in full.** In one line each: `QUEUED` gains
exactly two legal failure edges, safe because nothing has been submitted; the
target is derived from the existing disposition rather than a second
thirteen-reason table; the port gains one method and no tenant argument; the
write is the same expected-state CAS the claim uses, with an authoritative
re-read inside the transaction; the exact reason is persisted with an explicit
`null` message; and nothing calls any of it.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm test` | **1246 passed**, 61 files (baseline 1219 / 60) |
| `pnpm build` | exit 0 |
| `pnpm test:db` | **184 passed**, 8 files (baseline 154 / 8) |
| `prisma migrate diff --from-migrations` | `No difference detected.` exit 0 |

### Where each property is proven

27 new unit tests and 30 new PostgreSQL tests. No new test file on the database
side: the failure CAS extends the suite that already owns this port, because it
competes with the claim and the two must be raced against each other in one
place.

| Property | Proven by |
| --- | --- |
| All 13 reasons park correctly | An independent reason→**state** table, so both derivation chains are checked separately; plus all 13 against real PostgreSQL |
| The mapping partitions | 4 retryable / 9 terminal asserted by count — a mapping sending all 13 one way would pass every unnamed assertion |
| Only `QUEUED` widened | Every other row of the table re-pinned against the independent `EXPECTED` map |
| The two new edges, and no third | `allowedTransitionsFrom("QUEUED")` pinned as a literal; `PROCESSING`, `SUCCEEDED`, `SUBMISSION_UNKNOWN` and self explicitly refused |
| Membership unchanged | Both sets pinned as sorted literals |
| Legal ≠ automatic | `FAILED_RETRYABLE -> QUEUED` characterized as legal and unperformed |
| No state argument exists | Type-level: the signature takes exactly two parameters, the second not an open `string` |
| Exact reason persisted | Unprefixed and untransformed, all 13 against the database |
| Stale message cleared | A row seeded **with** a message — the case admission defaults cannot produce |
| Only four fields move | Whole-row comparison normalized on exactly those four, against a row seeded with real execution history |
| Refusal preserves everything | All seven non-`QUEUED` states, whole-row equality including `updatedAt` |
| `updatedAt` advances | Known-old-timestamp fixture, no sleep, with the fixture itself guarded |
| Exactly one winner | 2 racing refusals with **different** reasons, 8-way contention, and park-vs-claim |
| The winner's result is the truth | The durable row's state and code are asserted to equal the returned winner's |
| Tenant is resolved, not supplied | `organizationId` through `VideoProject`; the other tenant's scoped read still returns `null` |

The park-vs-claim test asserts asymmetrically on purpose. If the claim wins, no
refusal code was written against a row someone may now be paying for; if the park
wins, `submittedAt` and `providerPredictionId` are still null, so no submission
licence was issued.

### Mutation verification

| Mutation | Result |
| --- | --- |
| **M1** — `state = 'QUEUED'` dropped from the CAS predicate | **10 DB fail** |
| **M2** — disposition→state mapping inverted | **15 unit fail** |
| **M3** — `normalizedErrorCode` not persisted | **21 DB fail** |
| **M4** — explicit `normalizedErrorMessage: null` omitted | **2 DB fail** |
| **M5** — pre-write row returned instead of the authoritative re-read | **21 DB fail** |
| **M6** — the two `QUEUED` edges removed, adapter untouched | **30 DB fail**, throwing `Illegal scene-generation transition QUEUED -> FAILED_*` |

Every mutated file restored byte-identically, confirmed by `diff` against
pre-mutation copies. No mutation-only code is committed.

**M4 is worth recording as the narrow one.** It fails only the two tests seeded
with a pre-existing message — which is precisely what makes those fixtures
discriminating: seeded from the default admission path, where the column is
already null, an adapter that omitted the write would pass.

**M6 is the `assertTransition` evidence**, and it is a real discriminator rather
than a manufactured one. Reverting the domain table while leaving the adapter
alone makes the adapter refuse and write nothing — which is only possible if it
genuinely asks the state machine instead of restating the pair. No unsafe
writer, fake cancellation race, or production injection seam was created to
produce it.

**The re-read's position has no natural discriminating test**, and none was
manufactured. Proving it would require a competing writer interleaving between
the update and the read, and the only available competitor —
`SceneGenerationRepository.update` — carries no state predicate, so racing
against it would model unconditional cancellation as a safe primitive. That was
the Phase 4C-1b mistake and it is not repeated. Verified by source inspection
instead: `prisma.$transaction` opens the block, and both
`tx.sceneGeneration.updateMany` and `tx.sceneGeneration.findUnique` use the
transaction client `tx` rather than `prisma`, with the transaction closing after
the return.

## Invariants held

8-fact `requestHash` **unchanged** · `ACTIVE_SCENE_GENERATION_STATES` and
`TERMINAL_SCENE_GENERATION_STATES` **unchanged** · partial unique index
**unchanged** · migrations **unchanged** and none generated · Prisma schema
**comment-only** · `GenerationService` untouched · `SceneGenerationRepository`
public contract untouched · provider adapters untouched · worker runtime
untouched · audit runtime untouched · no requeue actor, cancellation, worker
loop, paid-call gate, URL freshness check, submission audit, provider POST,
polling, sweep, or output ingestion.

## Known limitations

- **Nothing calls this yet.** Production-dormant, like 4C-1b and 4C-2A. Zero
  production callers of `prepareQueuedGeneration`,
  `findNextQueuedForPreparation`, `failQueuedPreflight`, `claimQueuedForSubmission`.
- **`FAILED_RETRYABLE` is a parking spot, not a queue.** No actor returns a row
  to `QUEUED`, and adding one requires an expected-state CAS.
- **A contested row records whichever refusal was written first.** No reason
  priority exists; with two refusals both true, either is a correct record.
- **No audit entry** for a parked refusal. Deferred to orchestration.
- **Capability-table revision gap** from Phase 4C-2A remains open.

## Size

| Category | Lines changed |
| --- | --- |
| Production | see the PR body |
| Tests | see the PR body |
| Docs | see the PR body |

Measured from `git diff --numstat 70e3313..HEAD` after the final commit exists;
the PR body carries the reconciled figures.
