# Phase 3B-1b Completion Report — Review domain logic

Status: **implemented, awaiting review**
Branch: `claude/real-estate-virtual-tour-phase-3b1b-hga252`
Base: `main` at `0a7818f10371bcf8072b6b8cc2f501c9b5868f97` (merged Phase 3B-1a)

Makes human review executable: `approve` and `reject` on `AnalysisService`,
with the revision semantics, duplicate rule, and transactional rejection agreed
in the plan.

## Milestone size — over target, disclosed

| File | Changed code lines |
| --- | --- |
| `packages/domain/src/analysis/analysis-service.test.ts` | 374 |
| `packages/domain/src/analysis/analysis-service.ts` | 265 |
| `packages/domain/src/analysis/types.ts` | 29 |
| `packages/domain/src/testing/in-memory-analysis.ts` | 21 |
| `tests/api/analysis-routes.test.ts` (fixture wiring) | 5 |
| `packages/domain/src/analysis/audit.ts` | 2 |
| `apps/web/src/lib/analysis.ts` (wiring) | 2 |
| **Total** | **698** |
| — of which production | **319** |
| — of which tests | **379** |

**The plan estimated ≈166 production and ≈486 total; delivered is 319 and 698.**
The stop-and-report condition was tied to the estimate, which was inside the
target; the overrun surfaced during implementation, so this is a disclosure
rather than a pre-emptive stop.

Where the production estimate went wrong: I costed `approve` and `reject` as two
methods, and did not cost the five helpers they need —
`requireReviewable`, `requirePrimaryChoice`, `duplicateGroupMembers`,
`writeDecision`, `recordDecision` — plus `optionalReason` and
`isDuplicateApprovalConflict`, and the doc comments explaining the non-obvious
choices (why there is no pre-check, why the conflict is matched by constraint
name, why audit sits outside the transaction).

### Why this was not split

`approve` and `reject` share `requireReviewable`, `recordDecision`, and the whole
fixture. Splitting them would duplicate roughly 100 lines of shared code across
two PRs and would separate the immutability tests, which cover all four
approve/reject permutations and only make sense together. The protected test
categories — authorization, tenant isolation, duplicate concurrency, failure
consistency — are all present and were not trimmed to hit a number.

**The reviewer should decide whether to accept the overage.**

## What was implemented

### Revision semantics — keyed on the refresh flag, not on status

```ts
analysisRevision: refresh ? reserved.analysisRevision + 1 : reserved.analysisRevision
```

- First successful analysis → revision 1 (the row is created at 1 and the
  terminal write leaves it there).
- Successful refresh → previous + 1.
- Failed refresh → unchanged, because `fail()` never reaches this write.

The transition is decided by whether the run was a refresh. An initial analysis
and a refresh both end in `SUCCEEDED`, so status alone cannot distinguish them —
inferring from status would advance the revision on a first analysis, and on a
retry after a failed *initial* analysis. Both cases are covered by tests.

### Review state cleared when refresh begins

`reserve()` now clears `reviewStatus`, `reviewNote`, `reviewedBy`, and
`reviewedAt` along with the stale result fields, so a decision can never remain
attached to a result that no longer exists — including when the refresh then
fails. The revision is deliberately **not** touched there.

### Approve

`video:review` → OWNER, ADMIN, REVIEWER. **CREATOR is denied**, which is the
separation of duties that makes the gate meaningful: whoever runs the analysis
is not whoever approves it.

- Refused when the analysis carries a `BLOCKING` safety flag; rejection stays
  available.
- Refused unless the analysis is `SUCCEEDED` and `UNREVIEWED`.
- **Duplicate rule**: when the asset's duplicate group has more than one member,
  `primaryAssetId` is required and must equal the asset being approved. Whether
  another member is *already* approved is decided by the PostgreSQL partial
  unique index on `(organizationId, duplicateGroup) WHERE reviewStatus =
  'APPROVED'` — **the service performs no pre-check read**, because that would
  be a check-then-act race.
- A unique violation is mapped to `VALIDATION_FAILED`. It is never retried or
  reconciled: unlike the insert race in `reserve`, losing here means another
  member is already the primary, which is the reviewer's decision to revisit.
  The conflict is recognized by constraint name, so an unrelated unique
  violation is not silently reinterpreted.
- Reason optional; blank or absent is stored as `null`.

### Reject

- Reason **required and non-blank** (trimmed).
- The analysis review update and `MediaAsset.status = REJECTED` run inside
  `ReviewTransaction.run`, so they commit together or not at all. A rejected
  asset is then excluded from downstream generation by the existing status
  checks rather than a parallel rule.

### Audit

`analysis.approved` / `analysis.rejected` carry `analysisId`, `assetId`,
`propertyId`, `organizationId`, `actorId`, `reason` (null when absent), and
`analysisRevision`; `createdAt` is stamped by the audit repository. Emitted
**after** the transaction commits — audit atomicity remains the transactional-
outbox item in `docs/decisions/TODO.md` and is not claimed here.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — root + 11 workspaces, 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — **257/257** in 22 files (32 new) |
| `pnpm build` | **pass** |
| `pnpm test:db` | **pass** — 13/13 against live PostgreSQL 16 |

**No Prisma schema or migration change** — `git status packages/database/prisma/`
clean. Everything this milestone needed shipped in 3B-1a.

### Test coverage

| Area | Coverage |
| --- | --- |
| Revision | starts at 1; increments per successful refresh; unchanged by a failed refresh then resumes; a retried *initial* analysis does not advance it |
| Approve | records reviewer/timestamp/reason; blank reason → null; refused on a `BLOCKING` flag while rejection stays available |
| Reject | sets `MediaAsset.status = REJECTED`; reason required and non-blank; **neither write applied** when the transaction fails part-way, and no audit emitted |
| Immutability | all four approve/reject permutations refused; refresh clears the decision and makes it reviewable again; cleared even when the refresh fails; non-`SUCCEEDED` refused |
| Duplicates | primary required once the group has ≥2 members; must equal the target asset; chosen primary approved; single-member group needs no choice; **the constraint** refuses the second approval; a non-conflict write failure is rethrown |
| Authorization | CREATOR denied on both; REVIEWER permitted on both; non-member denied |
| Tenant isolation | another organization's analysis is unreviewable |
| Audit | full payload asserted field-by-field on approve and reject; null reason recorded; revision reflects a prior refresh; no storage key or provider name in metadata |

### A test-double fidelity note

`InMemoryAssetAnalysisRepository.update` now mirrors the partial unique index and
rejects with the **real constraint name**. Without that the duplicate-conflict
test would prove nothing: the double would happily accept two approvals while
PostgreSQL refuses them, and the mapping to `VALIDATION_FAILED` would never be
exercised. This is the same fidelity requirement as the transaction double in
3B-1a.

The tests also caught an invalid safety-flag code (`FACE_DETECTED`, which does
not exist in `SafetyFlagCode`) that Vitest happily ran because it does not
typecheck; `pnpm typecheck` failed on it and it is now `PERSON_DETECTED`.

## Documentation

| Item | Status |
| --- | --- |
| Completion report | This document |
| Change log | Updated — `CHANGELOG.md` |
| Progress | Updated — `docs/progress.md`, incl. the 3B-1a merge commit and tag record |
| Sequence diagram | Updated — `docs/sequence-analysis-lifecycle.md` v1.4, review transitions and the revision rule |
| Architecture diagram | **Unchanged** — no new module or boundary |
| ER diagram | **Unchanged** — no schema change |
| Migration notes | **Unchanged** — no migration |
| API summary | **Unchanged** — no HTTP surface |

## Known limitations

- **No HTTP endpoints and no UI.** The review methods are reachable only from
  the domain; exposing them is Phase 3B-2, and the review page 3B-3.
- Audit atomicity remains outside the transaction (TODO).
- A duplicate group's approved primary can only be changed by refreshing that
  analysis, since decisions are immutable per revision. That follows from the
  approved immutability rule, but it is worth confirming against the intended
  reviewer workflow when the UI lands.
- Remote publication of all nine `phase-*-complete` tags is still blocked by
  `HTTP 403` on tag refs. They exist locally only and are **not** claimed to
  exist on GitHub.
