# Phase 3D-1 Completion Report — Review-correction persistence

Status: **implemented, awaiting review**
Branch: `claude/real-estate-virtual-tour-phase-3d1-hga252`
Base: `main` at `235783b329dba160df7b6edbb7ea63310fa4481a` (merged Phase 3C-6b)

Infrastructure only: somewhere to record that a human corrected the analyzer,
and the one rule for resolving the two. Nothing can write a correction yet.

## Milestone size — inside the approved envelope

| File | Changed code lines |
| --- | --- |
| `effective.test.ts` | 103 |
| `analysis-repository.db.test.ts` | 90 |
| `analysis-service.test.ts` | 80 |
| `effective.ts` | 40 |
| `types.ts` | 23 |
| `00000000000005_phase3d1_review_corrections/migration.sql` | 19 |
| `analysis-service.ts` | 16 (−5) |
| `analysis-repositories.ts` | 12 |
| `schema.prisma` | 10 |
| Seven test fixtures + `analysis/index.ts` | 33 |
| **Total** | **426** — 121 production + 305 tests |

Approved at ~460; I re-cost to **~351 before implementation and reported it**.
The actual is 426 — 21% above my re-cost, entirely in the two new test files,
and **under the approved figure**. No scope was added beyond the approved
infrastructure.

33 of those lines are mechanical: making the four fields required-and-nullable
(the codebase's style — every other field on `AssetAnalysis` is `T | null`, none
is optional) means every `AssetAnalysis` literal must state them. That is eight
fixtures × four lines. The alternative, optional fields, would have saved the
lines and introduced an `undefined`-versus-`null` ambiguity in a model that has
none.

## What was built

**Four nullable columns** on `asset_analyses` — `roomTypeOverride`,
`orderOverride`, `correctedBy`, `correctedAt` — with a purely additive
migration: no backfill, no index, no constraint, no change to any existing
column. `NULL` everywhere is exactly today's behaviour.

**`effectiveRoomType(analysis)`** in `packages/domain/src/analysis/effective.ts`
is the single resolution point: `roomTypeOverride ?? roomType`. Reading
`analysis.roomType` where the corrected value is meant is now an identifiable
mistake rather than an easy one. `isCorrected(analysis)` reads the overrides
rather than `correctedBy`, so a row corrected and then cleared within a revision
correctly reads as uncorrected.

**There is deliberately no `effectiveOrder`.** `orderOverride` is the reviewer's
priority as stored — there is nothing to resolve, a pass-through wrapper would
imply a derivation that does not exist, and a wrapper falling back to
`suggestedOrder` would move an ordering decision into the analysis model where
it does not belong. The module says so in a comment so the next person does not
add one. Callers read the field. **Flagging this** in case you expected a second
helper: I judged the honest minimum to be one function, not two.

**Refresh clears all four fields** at reservation, beside the review state that
was already cleared there. A correction belongs to the revision it was made
against; once the analyzer has re-run, "this is a living room, not a kitchen"
describes a classification that no longer exists.

## What was deliberately not built

No `AnalysisService.correct`, no audit event, no HTTP endpoint, no DTO exposure,
no UI, no `orderScenes` change, no `EligibleInput` change, **no fingerprint
change**, no storyboard integration. Nothing in this milestone can write a
correction, so the columns stay `NULL` in production until Phase 3D-2.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — **565/565** in 42 files (14 new) |
| `pnpm build` | **pass** |
| `pnpm test:db` | **pass** — **27/27** (was 24; 3 new) |
| `prisma migrate deploy` from a **dropped and recreated** database | **pass** — all six migrations applied |
| Drift check (`migrate diff --exit-code`) | **pass** — `No difference detected.` (exit 0) |

No defect was discovered. Existing analysis, review, and storyboard behaviour is
unchanged — every prior test still passes with no assertion altered.

### Coverage (14 new cases)

**`effectiveRoomType` / `isCorrected` (10):** the analyzer's value with no
correction; the correction when present; back to the analyzer's when cleared;
the analyzer's field is not mutated; a reviewer can classify what the analyzer
could not (`roomType: null` → `STUDY`); a correction agreeing with the analyzer
is not special-cased; `isCorrected` false when untouched and true for either
override; a cleared row with surviving `correctedBy` reads uncorrected; an
`orderOverride` of `0` counts as a correction, because whether zero is *valid*
is 3D-2's rule and this module must not silently swallow it.

**Refresh (4):** a successful refresh clears all four fields, advances the
revision, and restores the analyzer's own output; a **failed** refresh clears
them too — clearing happens at reservation, so a correction can never outlive
the result it was made about — while keeping existing semantics (revision does
not advance, review state cleared); a new analysis starts uncorrected; an
idempotent re-request **without** refresh leaves a correction intact, so a
reviewer's work is not lost to a repeated analyze call.

**Live PostgreSQL (3):** the four columns round-trip as values and back to
`NULL`, with the analyzer's `roomType` and `suggestedOrder` surviving in the
database and not merely in memory; an unrelated update (an approval) preserves
corrections, because the repository writes the whole row; and `0`, `-3`, and
`999999` all persist unchanged, proving persistence stores what it is given and
encodes no product rule.

## Documentation

**ADR-0015** records the full decision — preserved AI output versus mutation
with the four reasons; the lifecycle; `orderOverride` as a global sort priority
rather than an absolute position; the approved 3D-3 precedence rule; the
fingerprint payload change and its one-time stale consequence; per-asset
correction with batch reorder deferred; and why `suggestedOrder` is retained
despite being inert.

Also updated: `docs/migration-notes.md` (migration 6, with rollback and the
explicit note that the `"RoomType"` enum must not be dropped),
`docs/er-diagram.md` (four columns plus the no-index and no-constraint
rationale), `CHANGELOG.md`, `docs/progress.md`.

## Known limitations

- **Nothing can write a correction yet.** The columns exist and are unreachable
  until Phase 3D-2 adds `AnalysisService.correct`.
- **Composition still ignores corrections**, by design — Phase 3D-3. **3D-4 must
  not precede 3D-3**: a correction UI over composition that still ignored
  corrections would let a reviewer record a fix that silently does nothing.
- The fingerprint still uses `[assetId, analysisRevision]`. When 3D-3 widens it,
  every storyboard composed under the old format reads stale once and must be
  recomposed — fail-safe, no migration.
- `suggestedOrder` remains inert in ordering, before and after this milestone.
- Phase 3 cannot be closed and `phase-3-complete` cannot be created until 3D-4
  ships the reviewer-facing path.
- Remote publication of all twenty-one `phase-*-complete` tags remains blocked
  by `HTTP 403`. They exist locally only and are **not** claimed to exist on
  GitHub.
