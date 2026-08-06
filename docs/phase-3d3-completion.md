# Phase 3D-3 Completion Report — Corrections reach composition

Status: **implemented, awaiting review**
Branch: `claude/real-estate-virtual-tour-phase-3d3-hga252`
Base: `main` at `3d5933239959981130d173c82210ecf93d9405f2` (merged Phase 3D-2)

Composition now uses what the reviewer decided, and freshness notices when they
change their mind. All correction knowledge stays at the `EligibleInput`
projection.

## Milestone size — 413, below the approved range

| File | Changed code lines |
| --- | --- |
| `ordering.test.ts` | 100 (−1) |
| `fingerprint.test.ts` | 89 (−11) |
| `storyboard-service.test.ts` | 78 |
| `eligibility.test.ts` | 54 (−1) |
| `ordering.ts` | 43 (−4) |
| `fingerprint.ts` | 27 (−10) |
| `eligibility.ts` | 22 (−1) |
| **Total** | **413** — 92 production + 321 tests |

Approved at ~445–560; the actual is **413**, under the nominal figure. The
comparator and the payload change are each a handful of lines, and the tests
stayed focused on the changed contract rather than restating the 3C matrix — as
directed. After two milestones of under-estimating, this one came in low.

## The integration seam

```
AssetAnalysis → selectEligibleAnalyses → EligibleInput → orderScenes
                                                       → computeCompositionFingerprint
                                                       → StoryboardService
```

`selectEligibleAnalyses` now projects `roomType: effectiveRoomType(a)` and
`orderOverride: a.orderOverride`. **That is the whole integration.** Nothing
downstream learns that overrides exist: `ordering.ts` never imports
`effectiveRoomType`, `fingerprint.ts` never reads an `AssetAnalysis`, and
**`StoryboardService` changed by zero lines** — a grep for `Override`,
`effectiveRoomType`, `isCorrected`, or `corrected` in it returns nothing.

Correction provenance is deliberately kept out of the projection: composition has
no use for who corrected a photo or when, and a test asserts `EligibleInput`'s
key set is exactly the five facts.

`EligibleInput.roomType` now means the **effective** room, and the type's doc
comment says so.

## The comparator

```ts
function primaryKey(input: EligibleInput): number {
  return input.orderOverride ?? rankOf(input.roomType);
}
```

Sorted ascending, then: an explicit priority beats an automatic rank on an exact
numeric tie → effective room rank → `suggestedOrder` (nulls last) → `assetId`.

The priority and the room ranks share **one numeric space**, which is what makes
it global. Each approved example is a test:

| Case | Keys | Result |
| --- | --- | --- |
| automatic `EXTERIOR` (1) vs priority `1` | 1 vs 1 | tie → **explicit wins** |
| automatic `LIVING_ROOM` (4) vs priority `2` | 4 vs 2 | priority first |
| automatic `EXTERIOR` (1) vs priority `8` | 1 vs 8 | **exterior stays first** |
| `ENTRANCE` (2), priority `3`, `LIVING_ROOM` (4) | 2, 3, 4 | priority *between* them |
| two photos at priority `3` | tie | room → `suggestedOrder` → `assetId` |
| priority `150` vs unclassified (99) | 150 vs 99 | unclassified first, **not clamped** |
| no priorities anywhere | room ranks | ordering unchanged from Phase 3C |

`suggestedOrder` keeps its tie-break role, and the duplicate-`assetId` refusal is
untouched — a test asserts duplicate *priorities* are accepted while a duplicate
*asset* still throws.

## The fingerprint

```
[ assetId, analysisRevision, roomType, orderOverride ]
```

`roomType` is the effective room the projection already resolved; this module
never calls `effectiveRoomType` and never re-reads an analysis. Canonical
`assetId` sort, `JSON.stringify`, SHA-256, and `sha256:<hex>` are unchanged, and
`analysisRevision` is not advanced by a correction — which is precisely why the
corrected values have to appear in the payload.

### One-time stale consequence

**The payload format changed.** Two extra members are serialized even when both
are null, so a digest computed under the Phase 3C format cannot match one
computed now. **Every storyboard composed before this milestone reads stale once
and must be recomposed.**

This is deliberate and fail-safe. There is **no** compatibility fallback, **no**
dual-format support, **no** backfill, and **no** migration — treating an old
digest as fresh would assert something the function can no longer verify. No
database change is required.

### A superseded 3C assertion, replaced rather than deleted

`fingerprint.test.ts` carried *"ignores room type and suggested order — it
identifies the input set only"*. Room type participating is exactly what this
milestone changes, so that test now fails by design. I replaced it with
*"ignores `suggestedOrder` — analyzer output nobody can correct"*, which is still
true and still worth asserting: `suggestedOrder` is derived from the analyzer's
own room type and cannot move without `roomType` or `analysisRevision` moving
too. The comment records why room type left that list.

Similarly, `eligibility.test.ts`'s "projects exactly the four facts" became
"…five facts" with `orderOverride: null` added to the expected object. Every
other 3C assertion is untouched and green.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — **645/645** in 42 files (28 new) |
| `pnpm build` | **pass** |
| `pnpm test:db` | **pass** — 27/27, unchanged |

**Scope boundaries — zero diff** across `packages/database/` (schema and
migrations), `packages/domain/src/analysis/` (`AnalysisService.correct` and the
correction audit), `packages/domain/src/identity/` (roles), `apps/web/` (HTTP
routes, DTOs, UI), and both provider packages. Seven files changed, all under
`packages/domain/src/storyboard/`.

No defect was found by the build or the tests. Two pre-existing assertions
required updating, both because the contract they described was the one this
milestone was approved to change — described above rather than quietly amended.

### Coverage (28 new cases)

**Eligibility (5):** the reviewer's room is projected when recorded; the
analyzer's when not; a reviewer can classify what the analyzer could not;
`orderOverride` is projected verbatim including `null`; the projected key set is
exactly the five facts, carrying no provenance.

**Ordering (11):** the seven approved cases above; equal priorities falling
through to `assetId`; duplicate priorities accepted while a duplicate `assetId`
still throws; a shuffled five-photo mixed set producing an identical order; the
full no-priority regression re-running the documented `SEQUENCE`.

**Fingerprint (7):** effective room change → different digest, with asset and
revision fixed; a room becoming or ceasing to be `null` → different; order
priority change → different; `null` versus a stated priority → different;
identical corrected inputs → stable; shuffled corrected inputs → identical;
corrected inputs still match `sha256:<hex>`.

**Storyboard service (5):** the corrected room type is stored on the scene, not
the analyzer's; a corrected room changes scene order and positions; an explicit
priority orders against the automatic ranks; a storyboard composed from
corrected inputs is immediately fresh under both `isFresh` and `assertFresh`;
scene count and the single composition audit event are unchanged.

## Documentation

Completion report, `CHANGELOG.md`, `docs/progress.md`, and dated supersession
notes appended to **ADR-0012** (fingerprint payload) and **ADR-0013**
(ordering comparator). Neither historical ADR was rewritten — each keeps its
original reasoning and gains a note stating what is no longer current and why,
pointing at ADR-0015.

`docs/progress.md`'s stale tag inventory was replaced with a durable statement:
no count, no ref list, the local/remote distinction preserved, and the git
commands to inspect and publish.

## Known limitations

- **No reviewer-facing path yet.** Corrections can be made only through the
  domain service; the HTTP endpoint and review-UI controls are Phase 3D-4.
- Phase 3 cannot be closed and `phase-3-complete` cannot be created until 3D-4
  ships.
- Every pre-existing composed storyboard reads stale once after deploy, as
  above.
- `suggestedOrder` remains inert in practice, as ADR-0015 records.
- Completion tags exist locally only; remote publication remains blocked by
  `HTTP 403` and is **not** claimed.
