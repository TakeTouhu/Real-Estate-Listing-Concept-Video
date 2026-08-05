# Phase 3D-2 Completion Report — The correction operation

Status: **implemented, awaiting review**
Branch: `claude/real-estate-virtual-tour-phase-3d2-hga252`
Base: `main` at `1ebe30ada17ee8d2f208d159d823a2d390d9293d` (merged Phase 3D-1)

`AnalysisService.correct` — the write path for the columns Phase 3D-1 added.
Domain and service only: nothing over HTTP, nothing in the UI, and composition
still ignores corrections.

## Milestone size — 708, over the approved range

| File | Changed code lines |
| --- | --- |
| `analysis-service.test.ts` | 519 |
| `analysis-service.ts` | 157 (−1) |
| `types.ts` | 30 |
| `audit.ts` | 2 |
| **Total** | **708** — 189 production + 519 tests |

Approved at ~481/~500. I re-cost to **~558 and reported that before writing
code**, flagging the mandated matrix as the driver. The actual is **708** — 27%
above my own re-cost and 42% above the approved ceiling.

**The production side landed close** (189 against ~158). The whole overrun is
the test file: the required matrix is **52 cases across ten groups**, and in
this codebase's style each `it` costs 8–12 lines with its arrange/act/assert,
even with `it.each` tables collapsing the nine order-validation rejects and the
five accepted priorities into two blocks. 519 ÷ 52 ≈ 10 lines per case, which is
the going rate here.

**No required test was removed**, per your instruction. The estimate was wrong,
not the scope: I priced 52 cases at ~7.7 lines each and should have priced them
at ~10.

## What was built

`AnalysisService.correct(actorUserId, organizationId, assetId, input)`.

**Input semantics** are structural, exactly as approved:

```ts
export type CorrectionField<T> = { readonly set: T | null };
export interface CorrectInput {
  readonly roomType?: CorrectionField<RoomType>;
  readonly order?: CorrectionField<number>;
}
```

Absent → unchanged; `{ set: null }` → cleared; `{ set: v }` → set. The wrapper
exists because `roomType?: RoomType | null` cannot distinguish `{}` from
`{ roomType: undefined }` without `exactOptionalPropertyTypes`, so a caller
forwarding an unset value would silently clear a reviewer's work.

**Lifecycle, authorization and tenancy are `requireReviewable`'s** — the same
guard approve and reject use, called unchanged. There is no parallel lifecycle
implementation, no second lookup path, and no role branching: `video:review`
admits OWNER, ADMIN and REVIEWER and excludes CREATOR through the existing role
map. A foreign or unknown asset is `NOT_FOUND`, never `FORBIDDEN`.

**Validation** lives in two small resolvers. Rooms accept only the existing
`RoomType` vocabulary via `isRoomType`. Order priorities require
`Number.isInteger(v) && v > 0`, which rejects `0`, negatives, fractions, `NaN`,
`Infinity`, `-Infinity`, and every non-number in one expression — with **no upper
bound**, because a ceiling would be a capability claim and priorities are
compared, never allocated.

**Change detection is on the stored override pair**, never on effective values —
the point you called out. `null → KITCHEN` when the analyzer already said
`KITCHEN` **is** a change: a person confirmed the classification, `isCorrected`
must become true, and the row's provenance must say who. The audit entry then
honestly reads `previousRoomType: KITCHEN, newRoomType: KITCHEN`, which is the
correct record of a confirmation.

**Provenance is self-consistent.** A change sets `correctedBy`/`correctedAt`; if
the resulting row has no overrides left, both are cleared too, so the row means
"currently uncorrected" and agrees with `isCorrected`. Who cleared it survives in
the audit log.

## The three no-op cases, kept distinct

| Input | Outcome |
| --- | --- |
| No fields at all | `VALIDATION_FAILED`, no write, no audit |
| Fields that restate the stored overrides | success, returns the analysis, **no repository write**, `updatedAt` and `correctedAt` unmoved, **no audit** |
| A real change | one write, exactly one `analysis.corrected` |

## Audit

One action, `analysis.corrected`, on the existing sink, emitted only on a real
change. `resourceType: "asset_analysis"`, `resourceId: analysis.id`, and metadata
carrying `analysisId`, `assetId`, `propertyId`, `analysisRevision`, the
**effective** room before and after, and the **stored** order override before and
after — plus `organizationId` and `actorId`, following the duplication convention
`recordDecision` already established rather than redesigning it. No storage key,
thumbnail key, provider name, review note, or image data.

## Atomicity

**No new infrastructure**, as directed. The correction is a single analysis-row
write followed by the audit write — simpler than `reject`, which already spans
two rows through `ReviewTransaction`. `ReviewTransaction` is deliberately not
used: there is no second row to keep consistent. The project's documented
persist-then-audit model applies unchanged and the transactional-outbox item
stays where it is in `docs/decisions/TODO.md`.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — **617/617** in 42 files (52 new) |
| `pnpm build` | **pass** |
| `pnpm test:db` | **pass** — 27/27, unchanged |
| Storyboard production · API routes · web UI · Prisma schema · migrations · `roles.ts` | **zero diff** |

Four files changed, all under `packages/domain/src/analysis/`. **No schema or
migration change was needed**, as expected.

One defect was found and fixed during development: I wrote `clock.advance(60_000)`
in three tests, but the test clock's method is `advanceSeconds`. Caught by the
first run of the new suite.

### Coverage (52 new cases)

**Input semantics (9):** set room; set order; absent room leaves the stored
override; absent order leaves it; explicit null clears room; explicit null
clears order; absent and cleared distinguished on one request; both fields in
one request; an empty input refused with nothing audited.

**Validation (11 blocks):** all fifteen `RoomType` values accepted; an unknown
room refused with a planted hostile string asserted **absent** from the
serialized error; five accepted priorities including `MAX_SAFE_INTEGER`; nine
rejected values — `0`, `-1`, `2.5`, `NaN`, `±Infinity`, a string, a boolean, an
object — each also asserting nothing was stored and nothing audited.

**Lifecycle (7):** succeeds and repeats while unreviewed; `PENDING`, `FAILED`,
`APPROVED`, `REJECTED` each refused with the existing message; `analysisRevision`
does not advance; a correction survives into the approval that follows it.

**Authorization and tenancy (6):** OWNER, ADMIN, REVIEWER each succeed and record
themselves as the corrector; CREATOR refused; an unknown asset and one in another
organization both `NOT_FOUND`.

**Provenance (4):** actor and timestamp recorded; provenance kept while an
override remains; cleared with the last override; `correctedAt` advances on a
later correction.

**No-op (2):** restating stored values moves neither `updatedAt` nor
`correctedAt` and emits nothing; clearing already-absent overrides is likewise
inert.

**Explicit confirmation (2):** `null → KITCHEN` over an analyzer `KITCHEN` is a
real change that writes, audits, and sets `isCorrected`, with both effective
audit values reading `KITCHEN`; repeating that same confirmation is then a no-op.

**Audit (4):** one entry with the exact metadata object asserted whole; a
room-only change still records the unchanged order pair; clearing the final
override records `BALCONY → KITCHEN` as the effective pair and `4 → null` as the
order pair; no storage key, provider name, review note, or thumbnail reference.

**Non-interference (2):** `roomType`, `suggestedOrder`, `confidence`,
`duplicateGroup`, `safetyFlags`, `analysisRevision`, and the review fields are
all untouched; a refresh after a correction still clears everything (regression
against 3D-1).

## Known limitations

- **No HTTP surface, no DTO exposure, no UI** — Phase 3D-4. Nothing outside the
  domain can call `correct` yet.
- **Composition still ignores corrections** — Phase 3D-3, which will project
  effective values into `EligibleInput`, apply the approved ordering precedence,
  and widen the fingerprint payload. None of that exists here.
- Phase 3 cannot be closed and `phase-3-complete` cannot be created until 3D-4
  ships the reviewer-facing path.
- Remote publication of all twenty-two `phase-*-complete` tags remains blocked by
  `HTTP 403`. They exist locally only and are **not** claimed to exist on GitHub.
