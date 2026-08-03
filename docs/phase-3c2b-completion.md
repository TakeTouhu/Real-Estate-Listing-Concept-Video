# Phase 3C-2b Completion Report — Ordering and duration allocation

Status: **implemented, awaiting review**
Branch: `claude/real-estate-virtual-tour-phase-3c2b-hga252`
Base: `main` at `75966994eafa9f6ec58c2243e34f66f89296f3d9` (merged Phase 3C-2a)

Three pure functions and their tests. No I/O, no repositories, no database
changes, no service, no HTTP, no UI, no prompt compiler, no moderation, no
Phase 4 work. **Every changed file is under `packages/domain/src/storyboard/`.**

## Milestone size — within target

| File | Changed code lines |
| --- | --- |
| `ordering.test.ts` | 176 |
| `duration.test.ts` | 140 |
| `duration.ts` | 103 |
| `ordering.ts` | 99 |
| `index.ts` | 2 |
| **Total** | **520** — 204 production + 316 tests |

Estimated ~415 (157 + 258). The 4% overshoot against the ~500 target came from
the two refinements: the structural-versus-range split needed eleven separate
validation cases, and the duplicate-`assetId` rule added its own three.

## The two refinements, as implemented

### 1. Structural failures quote no achievable range

`allocateDurations` validates in two stages. **Structural** problems —
`sceneCount < 1`, and any non-positive-integer total, minimum or maximum, and
`min > max` — throw with `AppError.details` carrying only the offending values.
**No `minimumAchievableDuration` or `maximumAchievableDuration` appears**, and
the message never says "can run between": with an invalid duration model,
`n × min … n × max` would be arithmetic over nonsense presented as advice.

Only once the model is sound does an out-of-range total report both figures, in
`details` as well as the message:

```
4 scenes can run between 8 and 40 seconds; 41 was requested
details: { minimumAchievableDuration: 8, maximumAchievableDuration: 40, totalSeconds: 41 }
```

Eleven parameterized tests assert the structural cases carry no range; two
assert the range cases carry both figures.

`requireMinimumScenes` stays a **separate function**, failing with
`{ sceneCount, minimumScenes: 3 }` and no duration vocabulary — a test asserts
the absence explicitly, and another shows allocation still works for two scenes,
proving the rules are independent.

### 2. Duplicate `assetId` is refused

`orderScenes` throws `VALIDATION_FAILED` naming the offending asset in
`details`. It neither picks a winner nor deduplicates. For valid input, three
tests assert the output is a complete permutation: same length, same multiset of
ids, no repeats, every input object carried through unchanged, and the caller's
array left unmutated.

## Ordering, as approved

`EXTERIOR → ENTRANCE → HALLWAY → LIVING_ROOM → DINING_ROOM → KITCHEN → BEDROOM →
CHILD_ROOM → STUDY → BATHROOM → WASHROOM → TOILET → STORAGE → BALCONY → OTHER`,
with `null` and any future unranked `RoomType` last. No new taxonomy: "wet
areas" resolves to the three members the enum already has. Ties break by
`suggestedOrder` ascending (nulls last), then `assetId` ascending.

## A determinism bug the tests caught

The first comparator ranked a missing `suggestedOrder` as
`Number.POSITIVE_INFINITY` and subtracted. For **two** nulls that yields
`Infinity - Infinity = NaN`; the comparator reported neither "less" nor
"greater", the `assetId` tie-break never ran, and the pair silently kept its
input order — non-deterministic for exactly the photos least likely to carry a
suggestion. The comparator now handles nulls explicitly, and the test that
exposed it (two stated orders plus two nulls in one room) stays as the guard.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — **365/365** in 30 files (39 new) |
| `pnpm build` | **pass** |
| `pnpm test:db` | **pass** — 24/24, unchanged |
| `packages/database/` diff | **zero** |
| `apps/` diff | **zero** |
| Prisma schema + migrations diff | **zero** |

### Test matrix (39 cases)

| Area | Cases |
| --- | --- |
| Sequence | full 15-room set from reversed input; `CHILD_ROOM` after `BEDROOM`; `STUDY` after `CHILD_ROOM`; wet areas in enum order; `OTHER` and null last; missing rooms simply absent |
| Tie-breaks | `suggestedOrder` ascending; null last; `assetId` fallback including two nulls; identical result from reversed input |
| Permutation | nothing added, dropped or repeated; objects carried through; caller's array not mutated; empty input |
| Duplicates | repeated `assetId` refused; offending id named; distinct assets sharing every other field accepted |
| Structural validation | eleven cases — scene count `0`, negative, fractional; total fractional, zero, negative; bounds fractional, zero, negative; `min > max` — each asserted to carry **no** range |
| Range validation | below minimum and above maximum both report both figures; no shortening; no reuse |
| Allocation | exact multiples; remainder front-loaded and repeatable; **sum equals request and every value within bounds across 12 scene counts × every achievable total**; both boundaries exact; caller-supplied tight bounds honoured |
| Minimum scenes | 0/1/2 refused with scene-count details and no duration vocabulary; 3 and 20 accepted; allocation unaffected |

## Documentation

| Item | Status |
| --- | --- |
| Completion report | This document |
| ADR | **New** — `docs/decisions/0013-deterministic-ordering-and-duration-allocation.md`; ADR-0012 untouched |
| Change log | Updated — `CHANGELOG.md` |
| Progress | Updated — `docs/progress.md` |
| ER diagram, migration notes, architecture diagram, API summary, sequence diagram | **Unchanged** — nothing persists, transacts, or is exposed |

## Known limitations

- **Nothing calls these functions yet.** `StoryboardService` (3C-4) is the first
  consumer; until then they are exercised only by their unit tests.
- Per-scene bounds have no defaults anywhere in the domain, by design — Phase 4
  supplies real ones. A caller must choose them today.
- Image reuse for long requests remains unimplemented and out of scope; an
  unachievable total fails with its range rather than being satisfied.
- Remote publication of all fourteen `phase-*-complete` tags remains blocked by
  `HTTP 403` on tag refs. They exist locally only and are **not** claimed to
  exist on GitHub.
