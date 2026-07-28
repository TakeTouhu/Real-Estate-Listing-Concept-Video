# Phase 3A-2c Completion Report — Refresh, duplicate grouping, ordering, reads

Status: **implemented, awaiting review**
Branch: `claude/real-estate-virtual-tour-phase-3a2c-hga252`
Base: `main` at `40580866469b3d891f719cb9d83f17bf8b692081` (merged Phase 3A-2b)

Completes `AnalysisService` to the full Phase 3A-2 contract by adding the four
items deferred from 3A-2b, and nothing else.

## Milestone size — within target

| File | Changed code lines |
| --- | --- |
| `packages/domain/src/analysis/analysis-service.test.ts` | 234 |
| `packages/domain/src/analysis/analysis-service.ts` | 99 |
| **Total** | **333** |

Estimated ≈285–295; delivered 333, against a ~500 target. Documentation and
generated SQL excluded. **No Prisma schema or migration change** — the
`duplicateGroup` and `suggestedOrder` columns already existed from 3A-2a, so
none was needed and none was made (`git status packages/database/` is clean).

## What was implemented

### 1. Refresh

`analyzeAsset(actor, org, assetId, { refresh: true })` recomputes an analysis
that already `SUCCEEDED`, reusing the same row.

- Without `refresh`, an existing `SUCCEEDED` row is still returned untouched and
  the provider is **not** called — idempotency is unchanged.
- With `refresh`, the provider **is** called again.
- The row is reset to `PENDING` **with every stale result field cleared** —
  `roomType`, `confidence`, `qualityScore`, `brightnessScore`, `blurScore`,
  `duplicateGroup`, `detectedObjects`, `safetyFlags`, `suggestedOrder`,
  `failureReason` — *before* the provider runs. A refresh that then fails
  therefore ends in `FAILED` with nothing from the previous run surviving.
- The reservation emits `analysis.refreshed` rather than `analysis.requested`.

Clearing on reservation rather than on failure is deliberate: it means there is
no window in which a crashed refresh could leave last run's values on a row that
is no longer `SUCCEEDED`.

### 2. Duplicate grouping

`resolveDuplicateGroup` (from 3A-1) is now wired into the success path and its
result persisted. Candidates are restricted to:

- **the same organization** — `assets.listWithPerceptualHash(organizationId)`
  and `analyses.listByAssetIds(organizationId, …)` are both tenant-scoped, so a
  cross-tenant photo can never influence a group;
- **assets carrying a perceptual hash** — that is what the repository method
  returns;
- **excluding the subject asset** — filtered before the analyses are fetched, so
  the asset cannot match itself.

An asset with no perceptual hash gets a null `duplicateGroup`.

### 3. Suggested order

`roomOrderRank(roomType)` (from 3A-1) is persisted as `suggestedOrder`, using the
documented sequence: exterior → entrance → hallway → living → dining → kitchen →
bedroom → wet areas → storage → balcony → other. `OTHER` is last in that list, so
it ranks after every recognized room type.

### 4. Read methods

- `listForProperty(actor, org, propertyId)` — analyses for a property's assets.
- `getForAsset(actor, org, assetId)` — one asset's analysis, `NOT_FOUND` when absent.

Both use **read-level authorization**: `authorizeOrganization` with no permission
argument, so any member may read — including `REVIEWER`, who cannot start or
refresh an analysis. Non-members are denied. Both reads are organization-scoped,
so another tenant's analysis is invisible.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — root + 11 workspaces, 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — **208/208** in 20 files (18 new) |
| `pnpm build` | **pass** — Next.js production build |
| `pnpm test:db` | **pass** — 5/5 against live PostgreSQL 16 |

### Required tests

| Requirement | Test |
| --- | --- |
| Refresh calls the provider again | *calls the provider again and reuses the same analysis row* — asserts `provider.calls === 2` |
| Refresh reuses the same row | same test — same row id, one row total |
| Refresh clears stale failure and result state | *ends in FAILED with no stale result surviving a failed refresh*; *clears a previous failure reason when a later refresh succeeds* |
| Failed refresh ends in FAILED | *ends in FAILED with no stale result surviving a failed refresh* — `roomType`, `confidence`, `qualityScore`, `duplicateGroup`, `suggestedOrder` all null, collections empty |
| Non-refresh remains idempotent | *remains idempotent without refresh, leaving the provider uncalled* — `provider.calls === 1`, no `analysis.refreshed` audit entry |
| Identical hashes form a duplicate group | *puts identical perceptual hashes in the same group* |
| Distant hashes do not | *keeps a distant perceptual hash in its own group* |
| Cross-tenant hashes are ignored | *ignores an identical hash owned by another organization* — same hash, different tenant, different group |
| `suggestedOrder` follows room ordering | *ranks by the documented room sequence* — exterior < living < bedroom |
| `OTHER` ranks last | *ranks OTHER after every recognized room type* — compared against `BALCONY`, the last recognized type |
| `listForProperty` is property- and organization-scoped | *returns only the requested property's analyses, organization-scoped*; *returns an empty list for a property in another organization* |
| `getForAsset` returns `NOT_FOUND` when absent | *throws NOT_FOUND when the asset has no analysis* |
| REVIEWER can read | *lets a REVIEWER read, though they may not start an analysis* — both reads succeed, refresh is denied with `lacks permission` |
| Non-member cannot read | *denies a non-member both reads* |
| Cross-tenant analysis is invisible | *keeps another tenant's analysis invisible* — actor is a member of both organizations, still `NOT_FOUND` |

Plus a null-hash case (*leaves duplicateGroup null when the asset has no
perceptual hash*) and a first-asset case (*starts a new group for the first
analyzed asset*).

## Documentation

Only documents whose content actually changed:

| Item | Status |
| --- | --- |
| Completion report | This document |
| Change log | Updated — `CHANGELOG.md` |
| Progress | Updated — `docs/progress.md`, incl. the 3A-2b merge commit and tag record |
| Sequence diagram | Updated — `docs/sequence-analysis-lifecycle.md` v1.2; refresh, duplicate grouping, and ordering move from "3A-2c" to implemented |
| Architecture diagram | **Unchanged** — no new module or boundary |
| ER diagram | **Unchanged** — no schema change |
| Migration notes | **Unchanged** — no migration |
| API summary / OpenAPI | **Unchanged** — no HTTP surface |

## Known limitations

- **No HTTP endpoint.** `AnalysisService` is complete but still not reachable
  from the web app; that is Phase 3A-3.
- **Duplicate grouping is order-dependent.** A group id is derived from the
  first asset in the group to be analyzed (`dup_<assetId>`), so analyzing the
  same set in a different order yields different group *ids* — the grouping
  itself is stable. Refreshing an asset recomputes its group against whatever
  siblings are analyzed at that moment, which can move it into a group formed
  since its first run. Both are acceptable for a review aid; neither is a
  correctness issue for the near-duplicate warning it feeds.
- **Near-duplicate UX undecided** — whether the review UI blocks or merely warns
  on duplicates remains open in `docs/decisions/TODO.md` (Phase 3B).
- Concurrent provider-call deduplication and the transactional outbox remain
  open TODO items, unchanged by this milestone.
- `reviewedBy` / `reviewedAt` stay unwritten until the review surface ships.
  Mandatory human review is unaffected: no AI output can be published in any
  phase implemented so far.
- Remote publication of all six `phase-*-complete` tags is still blocked by
  `HTTP 403` on tag refs from this environment. They exist locally only and are
  **not** claimed to exist on GitHub; see `docs/progress.md`.
