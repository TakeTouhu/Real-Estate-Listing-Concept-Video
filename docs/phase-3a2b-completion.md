# Phase 3A-2b Completion Report — AnalysisService orchestration

Status: **implemented, awaiting review**
Branch: `claude/real-estate-virtual-tour-phase-3a2b-hga252`
Base: `main` at `8d1bed31e4d3744865d1a09a1fc08feb3da3e16f` (merged Phase 3A-2a)

## Milestone size — target missed, disclosed

The pre-implementation estimate was **≈509 code lines**. The delivered milestone
is **826 code lines**, excluding documentation. The estimate was wrong: the test
file came to 515 lines against an estimated 230.

| File | Code lines |
| --- | --- |
| `packages/domain/src/analysis/analysis-service.test.ts` | 515 |
| `packages/domain/src/analysis/analysis-service.ts` | 238 |
| `packages/domain/src/testing/in-memory-analysis.ts` | 71 |
| barrel exports (2 files) | 2 |
| **Total** | **826** |

### Why this was not split further

The scope was already cut twice before implementation — `refresh`, duplicate
grouping, `suggestedOrder`, and the read APIs were all deferred to 3A-2c. What
remains is the minimum coherent unit: one service method plus the six mandated
resilience tests.

Splitting again would not bring this near 500. Roughly 200 of the 515 test lines
are irreducible fixtures (`StubProvider`, `MapStorage`, `failingRepository`,
`seedAsset`, `build`, `serviceWith`) that every one of the six required
resilience tests depends on. Removing behavioural tests to fit the budget gets
to about 760 and buys nothing; splitting the safety tests away from the code
they constrain would let this milestone claim transaction-safety it had not
demonstrated, which is exactly what the requirement forbids.

So the milestone is delivered whole and over target, rather than under target
and unverified. **The reviewer should decide whether to accept the overage or
re-scope**; production code is 309 lines and the test-to-code ratio is 1.7:1,
which is coverage rather than padding.

## What was implemented

`AnalysisService.analyzeAsset(actorUserId, organizationId, assetId)`:

1. `authorizeOrganization(..., "property:write")` — membership and RBAC.
2. READY-only eligibility; missing/`DELETED` → `NOT_FOUND`, any other status →
   `VALIDATION_FAILED`.
3. Reserve the row as `PENDING` before any provider call.
4. Emit `analysis.requested`.
5. Read bytes from managed storage; unreadable → `FAILED`.
6. Call `ImageAnalysisProvider`; a throw is normalized through
   `normalizeError` and recorded as `FAILED` with a sanitized reason.
7. Merge provider safety flags with `deriveQualityFlags`, keeping the most
   severe entry per code.
8. Persist `SUCCEEDED`, then emit `analysis.succeeded`.

Also `InMemoryAssetAnalysisRepository` — an organization-scoped test double that
mirrors the unique index on `asset_analyses.assetId`, and rejects
asynchronously the way a real constraint violation surfaces.

### Consistency model

| Requirement | How it holds |
| --- | --- |
| No inconsistent intermediate state | Every write is a single-row status transition; there is no multi-row update to unwind. |
| A provider failure never creates a completed record | The row is reserved `PENDING` first and can only move to `FAILED` on the failure path; `SUCCEEDED` is written solely from a returned `AnalysisResult`. |
| Database failures leave no partially updated row | The terminal write is one `update`. If it throws, the row keeps its previous status (`PENDING`) with null result fields, and the error surfaces. |
| Audit failure cannot silently corrupt state | The terminal row is persisted **before** its audit entry. An audit-sink error propagates — never swallowed — over an already-consistent row. |
| Idempotent retries produce the same result | An existing `SUCCEEDED` row is returned untouched and the provider is not called again. |
| Re-running after failure is safe | A `FAILED` or `PENDING` row is reset and reused, never duplicated; the retry converges on the same row id. |
| Concurrent duplicate requests | The unique index on `assetId` is the concurrency control. The losing insert is reconciled by re-reading and adopting the winner's row. A create failure that is *not* a uniqueness conflict is rethrown, not swallowed. |

## Verification

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | **pass** — root + 11 workspaces, 0 errors |
| Lint | `pnpm lint` | **pass** — 0 errors, 0 warnings |
| Unit tests | `pnpm test` | **pass** — 190/190 in 20 files (28 new) |
| Production build | `pnpm build` | **pass** |
| Integration (live PostgreSQL) | `pnpm test:db` | **pass** — 5/5 |

### The six required resilience tests

| Requirement | Test | Asserts |
| --- | --- | --- |
| Provider timeout | *records FAILED, not SUCCEEDED, when the provider times out* | status `FAILED`, sanitized reason, `roomType` null, `analysis.failed` emitted |
| Provider exception | *records FAILED with a sanitized reason when the provider throws* | vendor host/path absent from the stored reason |
| Repository write failure | *surfaces a reservation write failure without creating a row*; *leaves the row PENDING when the terminal write fails, and converges on retry* | no row on reserve failure; on terminal failure the row is `PENDING` with null `roomType`, and the retry reaches `SUCCEEDED` on the **same** row id |
| Audit write failure | *persists the terminal analysis before the audit entry, so an audit failure cannot hide it* | audit error propagates; row is already `SUCCEEDED`; re-running returns `SUCCEEDED` with still one row |
| Repeated retry after failure | *succeeds on a retry after a failure, converging to one SUCCEEDED row*; *keeps exactly one row across many sequential retries* | same row id, `failureReason` cleared, one row, provider called once when already `SUCCEEDED` |
| Concurrent duplicate requests | *creates a single analysis row for concurrent requests*; *adopts the winner's row when its own insert loses the unique-index race* | one row, identical ids and results; the constraint-conflict branch is exercised directly |

Plus success path, flag merging, the eligibility matrix over all eight
non-READY statuses, `DELETED`/unknown asset handling, audit metadata containing
no storage key, no-membership denial, REVIEWER denial, cross-tenant asset
unreachability, and cross-tenant analysis invisibility.

## Required documentation

Per the refined rule, only documents whose content actually changed were touched.

| Item | Status |
| --- | --- |
| Completion report | This document |
| Change log | Updated — `CHANGELOG.md` |
| Progress | Updated — `docs/progress.md`, including the 3A-2a merge commit and tag record |
| TODO | Updated — concurrency limitation recorded |
| Sequence diagram | Updated — `docs/sequence-analysis-lifecycle.md` v1.1; the flow moved from planned to implemented, and the consistency notes are new |
| Architecture diagram | **Unchanged** — no new module or boundary |
| ER diagram | **Unchanged** — no schema change |
| Migration notes | **Unchanged** — no migration in this milestone |
| API summary / OpenAPI | **Unchanged** — no HTTP surface |

## Known limitations

- **Concurrent requests both call the provider.** The unique index prevents a
  duplicate row and both requests converge on the same result, but the losing
  request still performs its own provider call. Deduplicating the work itself
  needs a lease or a conditional status update, which belongs with the job
  queue in Phase 4. Recorded in `docs/decisions/TODO.md`.
- No `refresh`, so a `SUCCEEDED` analysis cannot yet be recomputed (3A-2c).
- No duplicate grouping or `suggestedOrder` written, though both pure functions
  exist from 3A-1 (3A-2c).
- No read APIs and no HTTP endpoint, so the service is not yet reachable from
  the web app (3A-2c / 3A-3).
- `reviewedBy` / `reviewedAt` remain unwritten until the review surface ships.
  Mandatory human review is unaffected: no AI output can be published in any
  phase implemented so far.
- Remote publication of all five `phase-*-complete` tags is still blocked by
  `HTTP 403` on tag refs from this environment. They exist locally only and are
  **not** claimed to exist on GitHub; see `docs/progress.md`.
