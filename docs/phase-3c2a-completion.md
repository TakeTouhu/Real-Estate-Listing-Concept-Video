# Phase 3C-2a Completion Report — Eligible-input selection and fingerprint

Status: **implemented, awaiting review**
Branch: `claude/real-estate-virtual-tour-phase-3c2a-hga252`
Base: `main` at `f7419bcbaf1b96408fd4e5d5700eb6a539594eac` (merged Phase 3C-1)

Two pure functions and their tests. No I/O, no repositories, no service, no HTTP,
no UI, no duration allocation, no ordering, no prompt compiler, no moderation,
no Phase 4 work.

## Milestone size — within target

| File | Changed code lines |
| --- | --- |
| `packages/domain/src/storyboard/eligibility.test.ts` | 151 |
| `packages/domain/src/storyboard/fingerprint.test.ts` | 96 |
| `packages/domain/src/storyboard/eligibility.ts` | 71 |
| `packages/domain/src/storyboard/fingerprint.ts` | 34 |
| `packages/domain/src/storyboard/index.ts` | 2 |
| **Total** | **354** — 107 production + 247 tests |

Estimated ~250 at plan time. The production side landed close (107 against ~95);
the tests came to 247 against ~155, because the refinements added cases the plan
had not costed — the duplicate-group invariant, the 0/1/2 sizes, and the
encoding-collision family.

## The three refinements, as implemented

### 1. Fingerprint encoding — canonical structure, not concatenation

```ts
const canonical = inputs
  .map((i) => [i.assetId, i.analysisRevision] as const)
  .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
return `sha256:${sha256Hex(JSON.stringify(canonical))}`;
```

Sorted by `assetId`, serialized as a tuple array, hashed with the existing
`sha256Hex` from `@app/shared` — no new dependency — and returned in the
documented `sha256:<hex>` form. Ordering and duration are **not** part of the
payload: the digest identifies the input set, so reordering a storyboard does
not make it stale.

Three tests pin the required changes (asset added, asset gone, revision
changed), one pins order-independence, and one pins that room type and suggested
order do **not** affect it. Three more pin that the encoding is unambiguous
where a delimiter-joined string would collide — including ids containing `|`,
ids containing quotes and backslashes, and `("ast_a1", 2)` versus
`("ast_a", 12)`.

### 2. Duplicate invariant — rejected, not resolved

`selectEligibleAnalyses` raises `VALIDATION_FAILED` when two **approved**
analyses share one non-null `duplicateGroup`. It does not pick a winner: the
partial unique index makes that state impossible in the database, so reaching it
means a guarantee has been violated somewhere, and quietly choosing one would
hide the defect. Several approved analyses with `duplicateGroup = null` remain
valid, and collisions among *unapproved* analyses are ignored because they never
enter the eligible set.

### 3. No minimum here

Selection and fingerprinting are defined for **0, 1, and 2** eligible analyses,
each covered by a test. `MIN_STORYBOARD_SCENES` is still referenced nowhere
outside its declaration; the minimum-three rule stays with composition in
Phase 3C-2b.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — **326/326** in 28 files (24 new) |
| `pnpm build` | **pass** |
| `pnpm test:db` | **pass** — 24/24, unchanged |
| `packages/database/` diff | **zero** |
| `apps/` diff | **zero** |
| Prisma schema + migrations diff | **zero** |

Every changed file is under `packages/domain/src/storyboard/`.

### Test matrix (24 cases)

| Area | Cases |
| --- | --- |
| Approval filter | only succeeded + approved admitted; unapproved never used to pad the count; an unapproved analysis in a duplicate group is still excluded |
| Sizes | empty set; one; two — no minimum enforced |
| Duplicate invariant | two approved in one group rejected; one per group across groups accepted; many null groups accepted; collisions among unapproved ignored |
| Projection | sorted by `assetId` regardless of input order; exactly four fields projected; null room type and null suggested order preserved |
| Fingerprint form | `sha256:<64 hex>`; empty set defined and distinct |
| Fingerprint sensitivity | asset added; asset removed; revision changed; asset swapped |
| Fingerprint insensitivity | input order; room type and suggested order |
| Encoding | delimiter-collision pair; JSON-escaped characters; digit-boundary pair; stable across equal objects |

## Documentation

| Item | Status |
| --- | --- |
| Completion report | This document |
| ADR | **New** — `docs/decisions/0012-composition-input-set-and-fingerprint.md` |
| Change log | Updated — `CHANGELOG.md` |
| Progress | Updated — `docs/progress.md` |
| ER diagram | **Unchanged** — no schema change |
| Migration notes | **Unchanged** — no migration |
| Architecture diagram | **Unchanged** — no new module; these are functions in the existing `storyboard` module |
| API summary | **Unchanged** — nothing is exposed |
| Sequence diagram | **Unchanged** — no interaction between components |

## Known limitations

- **Nothing calls these functions yet.** They are exercised only by their unit
  tests until `StoryboardService` arrives in 3C-4.
- The fingerprint reports *that* the input set moved, never *which* asset moved.
  That is deliberate — see ADR-0012 — but it means a future "what changed?"
  feature needs more than this value.
- Changing what the fingerprint covers would invalidate every stored value, so
  ADR-0012 marks that a breaking change requiring its own decision record.
- Remote publication of all thirteen `phase-*-complete` tags remains blocked by
  `HTTP 403` on tag refs. They exist locally only and are **not** claimed to
  exist on GitHub.
