# Phase 3A-2b Completion Report — AnalysisService orchestration

Merged milestone, approved as a one-time size exception. Lifecycle facts (PR
number, merge commit) are recorded in the milestone table in
`docs/progress.md`; this report is a technical snapshot.
Branch: `claude/real-estate-virtual-tour-phase-3a2b-hga252`
Base: `main` at `8d1bed31e4d3744865d1a09a1fc08feb3da3e16f` (merged Phase 3A-2a)

## Consistency claim — scope of what is guaranteed

This milestone is **not** fully transaction-atomic, and is not described as such.
What it provides is:

- **Failure-consistent** — no failure path leaves a half-written result. Every
  write is a single-row status transition, and a provider failure can only reach
  `FAILED`, never a completed record.
- **Retry-safe** — re-running a request after any failure is safe and converges
  on the same row.
- **Idempotent at the persisted analysis-row level** — at most one
  `asset_analyses` row exists per asset, and an existing `SUCCEEDED` row is
  returned untouched rather than recomputed.

### The audit consistency boundary (intentional)

The analysis row is persisted **before** its audit event. The two writes are
separate, so:

- an audit-sink failure **returns an error to the caller while the analysis row
  remains `SUCCEEDED`**;
- the completed analysis is not rolled back, and a subsequent retry returns that
  same `SUCCEEDED` row;
- the audit entry for that transition may therefore be missing even though the
  caller saw an error.

This ordering is a deliberate choice, not an oversight. The alternative —
auditing first, or discarding the analysis when its audit write fails — loses a
completed, paid-for analysis because of a logging outage, which is the worse
failure. What it costs is atomicity between the analysis row and the audit row.

**Achieving strict atomicity would require either a shared database transaction
spanning both writes, or a transactional outbox** (append the audit event to an
outbox table inside the same transaction as the analysis row, then publish it
asynchronously with at-least-once delivery and dedupe on the event id). Neither
is implemented here; the improvement is recorded in `docs/decisions/TODO.md`,
and it is a persistence-layer decision that also applies to credit settlement
and provider webhooks in Phases 4–6.

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
they constrain would let this milestone claim failure-consistency it had not
demonstrated, which is exactly what the requirement forbids.

So the milestone was delivered whole and over target, rather than under target
and unverified. Production code is 309 lines and the test-to-code ratio is
1.7:1, which is coverage rather than padding.

**Accepted by the reviewer as a one-time size exception**, on the grounds that
production code is ~309 lines, the remainder is primarily resilience and
security tests, separating those tests from the service would weaken both the
review and the completion claim, and CI was green on the exact PR head commit.
The ~500-line target still applies to Phase 3A-2c and later milestones.

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

### How each requirement holds

| Requirement | How it holds |
| --- | --- |
| No inconsistent intermediate state | Every write is a single-row status transition; there is no multi-row update to unwind. |
| A provider failure never creates a completed record | The row is reserved `PENDING` first and can only move to `FAILED` on the failure path; `SUCCEEDED` is written solely from a returned `AnalysisResult`. |
| Database failures leave no partially updated row | The terminal write is one `update`. If it throws, the row keeps its previous status (`PENDING`) with null result fields, and the error surfaces. |
| Audit failure does not silently corrupt state | The audit error propagates — it is never swallowed — and the analysis row is already in a consistent terminal state. Note the boundary above: the row stays `SUCCEEDED` while the caller receives an error, and the audit entry may be absent. Not atomic. |
| Idempotent retries produce the same result | An existing `SUCCEEDED` row is returned untouched and the provider is not called again. Idempotency is at the analysis-row level. |
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
| Audit write failure | *persists the terminal analysis before the audit entry, so an audit failure cannot hide it* | audit error propagates to the caller; row is already `SUCCEEDED` and stays that way; re-running returns `SUCCEEDED` with still one row. This documents the non-atomic boundary rather than hiding it. |
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

- **Analysis and audit writes are not atomic.** See the consistency boundary
  above: an audit failure returns an error while the analysis row remains
  `SUCCEEDED`, so that transition may lack an audit entry. A shared transaction
  or transactional outbox is required to close this, and is recorded in
  `docs/decisions/TODO.md`.
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
