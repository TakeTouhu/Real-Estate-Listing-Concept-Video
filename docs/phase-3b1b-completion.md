# Phase 3B-1b Completion Report — Review domain logic

Status: **implemented, awaiting review**
Branch: `claude/real-estate-virtual-tour-phase-3b1b-hga252`
Base: `main` at `0a7818f10371bcf8072b6b8cc2f501c9b5868f97` (merged Phase 3B-1a)

Makes human review executable: `approve` and `reject` on `AnalysisService`,
with the revision semantics, duplicate rule, and transactional rejection agreed
in the plan.

## Size exception

**Accepted as a milestone exception.**

- **698 changed code lines** against the approximate **500-line** target at the
  point the exception was granted. The reviewer-mandated runtime-path
  integration test and the adapter error boundary added afterwards bring the
  final total to **982** (production 388, tests 594) — those additions were
  required before merge and are not part of the original overage.
- The overage came from **underestimated shared helpers and test coverage** —
  the plan costed `approve` and `reject` as two methods and did not cost
  `requireReviewable`, `requirePrimaryChoice`, `duplicateGroupMembers`,
  `writeDecision`, `recordDecision`, or their documentation.
- **No milestone scope was added.** Everything delivered is in the approved
  plan; nothing was pulled forward from 3B-2 or 3B-3.
- **Future estimates must cost authorization, audit, transaction handling, and
  invariant enforcement as separate line items**, not as incidental parts of the
  methods that use them. Each of those four is a cross-cutting concern with its
  own helper and its own tests, and lumping them into "one service method"
  is what produced a 2× miss here.

## Milestone size — detail

| File | Changed code lines |
| --- | --- |
| `packages/domain/src/analysis/analysis-service.test.ts` | 374 |
| `packages/domain/src/analysis/analysis-service.ts` | 265 |
| `packages/domain/src/analysis/types.ts` | 29 |
| `packages/domain/src/testing/in-memory-analysis.ts` | 21 |
| `tests/api/analysis-routes.test.ts` (fixture wiring) | 5 |
| `packages/domain/src/analysis/audit.ts` | 2 |
| `apps/web/src/lib/analysis.ts` (wiring) | 2 |
| **Subtotal at exception** | **698** |
| `tests/integration/review-duplicate-conflict.db.test.ts` (mandated) | 195 |
| `packages/database/src/analysis-repositories.ts` (adapter error boundary) | 82 |
| `packages/domain/src/analysis/ports.ts` (neutral conflict type) | 16 |
| net change from removing the domain's string matching | −9 |
| **Final total** | **982** |
| — of which production | **388** |
| — of which tests | **594** |

**The plan estimated ≈166 production and ≈486 total; delivered is 319 and 698.**
The stop-and-report condition was tied to the estimate, which was inside the
target; the overrun surfaced during implementation, so this is a disclosure
rather than a pre-emptive stop.

Where the production estimate went wrong: I costed `approve` and `reject` as two
methods, and did not cost the five helpers they need —
`requireReviewable`, `requirePrimaryChoice`, `duplicateGroupMembers`,
`writeDecision`, `recordDecision` — plus `optionalReason`, the neutral
`DuplicateApprovalConflictError` boundary and its adapter translation, and the
doc comments explaining the non-obvious choices (why there is no pre-check, why
error interpretation sits in the adapter, why audit sits outside the
transaction).

### Why this was not split

`approve` and `reject` share `requireReviewable`, `recordDecision`, and the whole
fixture. Splitting them would duplicate roughly 100 lines of shared code across
two PRs and would separate the immutability tests, which cover all four
approve/reject permutations and only make sense together. The protected test
categories — authorization, tenant isolation, duplicate concurrency, failure
consistency — are all present and were not trimmed to hit a number.

The reviewer accepted the overage as a milestone exception rather than splitting
the PR after implementation, on the grounds that the shared review invariants and
state-transition tests form one coherent unit.

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
- The conflict is mapped to `VALIDATION_FAILED`. It is never retried or
  reconciled: unlike the insert race in `reserve`, losing here means another
  member is already the primary, which is the reviewer's decision to revisit.
  The violation is recognized **in the Prisma adapter** and handed to the domain
  as a neutral `DuplicateApprovalConflictError`; the domain never inspects
  database errors.
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
| `pnpm test:db` | **pass** — **15/15** against live PostgreSQL 16 (2 new) |
| Domain free of Prisma types and DB vocabulary | **pass** — grep for `@prisma`, `P2002`, and the index name returns nothing under `packages/domain/src/` |

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
| **Duplicate conflict, real runtime path** (integration) | two analyses in one `(organizationId, duplicateGroup)`; the first approves; the second is refused with `VALIDATION_FAILED`; the first remains `APPROVED`; the second remains `UNREVIEWED`; and the surfaced error leaks no Prisma text, error code, or constraint name |

### Database error interpretation lives in the adapter

The domain now reacts to a neutral `DuplicateApprovalConflictError` declared in
`packages/domain/src/analysis/ports.ts`. Recognizing the underlying violation —
a Prisma error code, a PostgreSQL constraint — happens in
`createPrismaAnalysisRepository`, and the in-memory double raises the same
neutral type. The domain imports nothing from Prisma and contains no database
vocabulary; both are asserted by grep in the verification run.

### The runtime-path test caught a real bug

`tests/integration/review-duplicate-conflict.db.test.ts` exercises
`AnalysisService` → Prisma repositories → PostgreSQL → adapter translation →
`AppError`. It failed on first run, and the failure was substantive rather than
cosmetic.

The adapter originally recognized the conflict by the **index name**
(`asset_analyses_org_dupgroup_approved_key`). Prisma does not report it. The
real error is:

```
Unique constraint failed on the fields: (`organizationId`,`duplicateGroup`)
```

The index name is invisible to the datamodel (ADR-0011), so Prisma identifies
the constraint by the fields it covers. **The translation would silently never
have fired in production**, and the caller would have received a raw Prisma
error instead of `VALIDATION_FAILED`. Neither the unit tests nor a direct
constraint test could have shown this: the unit tests use a double that raises
the neutral type directly, and a constraint test never reaches the adapter.

Detection now matches on the field set, which is specific — those two fields are
unique only under the partial index, while the table's other unique constraint
covers `assetId` and is left to propagate.

### A test-double fidelity note

`InMemoryAssetAnalysisRepository.update` mirrors the partial unique index and
raises the same neutral `DuplicateApprovalConflictError` the Prisma adapter
produces. Without that the unit-level duplicate tests would prove nothing: the
double would accept two approvals while PostgreSQL refuses them. Same fidelity
requirement as the transaction double in 3B-1a.

**But the double stands in for the repository *after* translation**, so it
cannot show whether the adapter recognizes the real violation — which is exactly
why the runtime-path integration test above was needed, and exactly what it
caught.

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
