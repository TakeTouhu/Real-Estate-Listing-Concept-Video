# Phase 3B-2 Completion Report — Review HTTP endpoints

Status: **implemented, awaiting review**
Branch: `claude/real-estate-virtual-tour-phase-3b2-hga252`
Base: `main` at `2f2f3d76d54bc0a6a0d9e8a0f60c3713d3a8cc05` (merged Phase 3B-1b)

Exposes `AnalysisService.approve` / `.reject` over HTTP as thin adapters. No UI —
that is Phase 3B-3.

## Milestone size — within target

| File | Changed code lines |
| --- | --- |
| `tests/api/review-routes.test.ts` | 346 |
| `.../analysis/approve/route.ts` | 41 |
| `.../analysis/reject/route.ts` | 37 |
| `apps/web/src/lib/request.ts` | 32 |
| `apps/web/src/lib/analysis.ts` | 29 |
| `tests/api/analysis-routes.test.ts` (superseded assertion) | 12 |
| **Total** | **497** |
| — of which production | **139** |
| — of which tests | **358** |

Estimated ≈418 (118 production + 300 tests) against a ~500 target. Delivered
497 — inside the target. Production landed at 139 against 118; the tests came to
358 against 300, mostly the duplicate-group scenarios, which need four assets
analyzed before a conflict can be provoked through the HTTP layer.

Costing authorization, audit, transaction, and invariant enforcement separately —
the rule adopted after 3B-1b — brought this estimate within 20% instead of 100%.

## The four decisions, as implemented

### 1. `reviewedBy` exposed — id only

`review.reviewedBy` carries the reviewer's user id and nothing else. It is not
expanded into name or email: that would make every review response a directory
lookup and disclose more about members than a review client needs. A test
asserts no user name or email appears in the serialized body.

### 2. Duplicate conflict stays `422`

The domain maps the conflict to `VALIDATION_FAILED` and the route does not
reinterpret it. A test asserts the response is `422` **and explicitly not
`409`**, so the decision cannot drift silently if someone later adds a conflict
error kind.

### 3. Review fields nested under `review`

```jsonc
"review": {
  "status": "APPROVED",
  "note": "Looks good",
  "reviewedAt": "2026-07-31T…Z",
  "reviewedBy": "usr_…",
  "analysisRevision": 1
}
```

The mapper builds this object; nothing review-related is top-level. A test
asserts `reviewStatus`, `reviewedBy`, and `analysisRevision` are all `undefined`
at the top level, so a future mapper change cannot quietly flatten them.

**Compatibility:** the `review` object also appears on the Phase 3A-3 analysis
endpoints, since they share one representation. That is purely additive — no
previously returned field changed name, type, or position.

### 4. Revision asserted on both decision responses

Both the approve and the reject test assert `review.analysisRevision`, and a
further test approves *after a refresh* and asserts the response reports
revision 2 — so the assertion covers the value changing, not just being present.

## Thin-adapter compliance

**`AnalysisService` has a zero-line diff** — `git diff main -- packages/domain/`
is empty. The handlers only authenticate, validate body shape, delegate, and map;
the shared `AppError` mapper does status translation.

Specifically, the routes do **not** decide: whether a reason is required, whether
`primaryAssetId` is needed or matches, whether the revision was already reviewed,
whether a blocking finding bars approval, or whether another group member already
holds the approval. `optionalString` checks only that a field is a string of
bounded length; `readJsonBody` checks only that `organizationId` is
plausibly-shaped.

## One superseded assertion, corrected rather than deleted

`tests/api/analysis-routes.test.ts` asserted that `reviewedBy` never appears in a
response. That was correct in 3A-3 and is **superseded by decision 1**, not a
regression. Rather than removing the check, it now asserts what still matters:
an unreviewed analysis reports `review.status === "UNREVIEWED"` with
`reviewedBy: null` — a placeholder identity would be a real defect — and no user
name or email appears anywhere in the body.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — root + 11 workspaces, 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — **272/272** in 23 files (15 new) |
| `pnpm build` | **pass** — both routes present in the build output |
| `pnpm test:db` | **pass** — 15/15 against live PostgreSQL 16 |
| Domain diff | **zero** — `git diff main -- packages/domain/` empty |
| Prisma schema / migrations | **untouched** |

### Route test coverage

| Area | Coverage |
| --- | --- |
| Approve | `200` with the nested review object; `review.analysisRevision` asserted; revision 2 reported after a refresh; review fields absent from the top level |
| Approve refusals | blocking finding → `422`; already reviewed → `422`; duplicate group without a primary → `422`; `primaryAssetId` naming another asset → `422` |
| Duplicate conflict | second approval in the group → **`422`, asserted not to be `409`** |
| Reject | `200` with `review.status === "REJECTED"` and `review.analysisRevision`; missing or blank reason → `422` |
| Authentication | `401` on both routes |
| Authorization | **CREATOR → `403` on both**; non-member → `403` |
| Tenant isolation | unknown asset → `404`; another organization's asset → `404` for a member of both |
| Validation | missing, empty, non-JSON, and wrong-typed fields → `422`, never a 500 |
| Response hygiene | reviewer id present; no user name, email, storage key, organization id, or provider name |

## Documentation

| Item | Status |
| --- | --- |
| Completion report | This document |
| API change summary | **New** — `docs/api-changes-phase-3b2.md` |
| Change log | Updated — `CHANGELOG.md` |
| Progress | Updated — `docs/progress.md`, incl. the 3B-1b merge commit and tag record |
| Sequence diagram | Updated — `docs/sequence-analysis-lifecycle.md` v1.5, HTTP entry to the review flow |
| Architecture diagram | **Unchanged** — no new module or boundary |
| ER diagram | **Unchanged** — no schema change |
| Migration notes | **Unchanged** — no migration |

## Known limitations

- **No rate limiting.** The two decision routes are unlimited, like every other
  endpoint; still the cross-cutting item in `docs/decisions/TODO.md`.
- **No review UI** — Phase 3B-3. The endpoints are reachable only by a client
  that constructs the requests itself.
- Audit atomicity remains outside the review transaction (TODO).
- A future `409` for duplicate conflicts needs a distinct domain error kind, out
  of scope here and recorded in the API summary.
- Remote publication of all ten `phase-*-complete` tags is still blocked by
  `HTTP 403` on tag refs. They exist locally only and are **not** claimed to
  exist on GitHub.
