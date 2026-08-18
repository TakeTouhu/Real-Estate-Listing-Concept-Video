# Phase 3B-1a Completion Report — Review infrastructure

Merged milestone. Lifecycle facts (PR number, merge commit) are recorded in the
milestone table in `docs/progress.md`; this report is a technical snapshot.
Branch: `claude/real-estate-virtual-tour-phase-3b1a-hga252`
Base: `main` at `e3fcc7410052ded01e936f75b00dbec239ac2e3e` (merged Phase 3A-3)

Persistence and the transaction boundary for human review. **No review service
methods** — the columns are inert until Phase 3B-1b.

## Milestone size — within target, above estimate

| File | Changed code lines |
| --- | --- |
| `tests/integration/review-transaction.db.test.ts` | 201 |
| `packages/domain/src/testing/in-memory-review-transaction.test.ts` | 110 |
| `packages/domain/src/analysis/types.ts` | 34 |
| `packages/database/src/review-transaction.ts` | 31 |
| `packages/domain/src/testing/in-memory-review-transaction.ts` | 31 |
| `packages/domain/src/analysis/ports.ts` | 24 |
| `packages/database/prisma/schema.prisma` | 21 |
| `packages/database/src/analysis-repositories.ts` | 12 |
| in-memory repo snapshot/restore (2 files) | 22 |
| existing fixtures + barrels + service `create` defaults | 13 |
| migration SQL | *generated + 8 hand-written lines* |
| **Total** | **489** |

Estimated ≈312 against a ~500 target. Delivered 489 — inside the target, but the
estimate was low: the integration suite came to 201 lines against 65 planned,
because the partial index needs five distinct cases to be meaningfully proven
(same group refused, different group allowed, null group unconstrained, non-
approved statuses unconstrained, group freed after a refresh) and the
transaction needs both a commit and a rollback case.

## Two findings that shaped this milestone

### The partial unique index is feasible — verified, not assumed

`@@unique([...], where: {...})` fails `prisma validate` on 5.22, so the index is
hand-written SQL appended to the generated migration, under the conditions set
by **ADR-0011 — database constraints beyond the Prisma schema**. The risk was that
`prisma migrate diff --from-migrations --to-schema-datamodel --exit-code` would
then see an index the datamodel cannot express and fail the `database` CI job. I
tested that against live PostgreSQL before committing to the approach:

```
No difference detected.
exit=0
```

Prisma ignores the index it cannot represent, so the drift check still passes —
confirmed again on the real migration after applying it.

**Caveat, now recorded in `docs/migration-notes.md`:** because the index is
invisible to the datamodel, `prisma migrate dev` may generate a migration that
drops it. Any future migration must be inspected for that.

### The transaction boundary required a new port

Repositories are built once from a `PrismaClient`; nothing could bind two of
them to one `tx`. `ReviewTransaction` closes that gap:

- `createPrismaReviewTransaction` rebuilds both repositories **against the
  transaction client inside `run`**. Building them outside would silently write
  outside the transaction — precisely the failure this port exists to prevent.
- `InMemoryReviewTransaction` snapshots and restores state on throw, so the
  double has real rollback semantics. Without that, unit tests would pass
  against a double that commits partial writes while Prisma does not, and the
  bug would be invisible where it is cheapest to catch.

## What was implemented

**Schema** — `ReviewStatus` enum (`UNREVIEWED` / `APPROVED` / `REJECTED`),
`reviewStatus` (default `UNREVIEWED`), `reviewNote`, `analysisRevision`
(default 1), and `@@index([organizationId, reviewStatus])`. Additive; existing
rows default to unreviewed at revision 1, which is correct — nothing has been
reviewed.

**Partial unique index**, hand-written in the migration:

```sql
CREATE UNIQUE INDEX "asset_analyses_org_dupgroup_approved_key"
  ON "asset_analyses" ("organizationId", "duplicateGroup")
  WHERE "duplicateGroup" IS NOT NULL AND "reviewStatus" = 'APPROVED';
```

The database is authoritative for "at most one `APPROVED` analysis per duplicate
group". Rows with a null group are unconstrained — they have no duplicate
siblings.

**Domain types** — `ReviewStatus`, `REVIEW_STATUSES`, `isReviewStatus`,
`isReviewed`, and the three new fields on `AssetAnalysis`. `analysisRevision`
identifies the persisted *result*: first successful analysis → revision 1,
successful refresh → previous + 1, failed refresh → unchanged. The transition is
decided by whether the run was a refresh, never inferred from the row reaching
`SUCCEEDED`, since an initial analysis and a refresh both end there.

**Ports and adapters** — `ReviewRepositories` / `ReviewTransaction` in the
domain, a Prisma implementation, and an in-memory implementation.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — root + 11 workspaces, 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — **225/225** in 22 files (4 new) |
| `pnpm build` | **pass** |
| `pnpm test:db` | **pass** — **13/13** against live PostgreSQL 16 (8 new) |
| Migration from empty DB | **pass** — 4 migrations applied |
| Drift check | **pass** — `No difference detected.` (exit 0) |

### Integration coverage

| Area | Asserted against real PostgreSQL |
| --- | --- |
| Review columns | round-trip of status, note, reviewer, timestamp, revision; new rows default to `UNREVIEWED` / revision 1 |
| Partial index | a second `APPROVED` in the same group is **refused** and the loser stays `UNREVIEWED` |
| Partial index | many `UNREVIEWED`/`REJECTED` members in one group are permitted |
| Partial index | approval in a *different* group is permitted |
| Partial index | rows with a null duplicate group are unconstrained |
| Partial index | the group frees up once the approved member is reset by a refresh |
| Transaction | analysis and asset writes commit together |
| Transaction | a throw commits **neither** write — no partially applied rejection |

The in-memory double is covered separately for commit, rollback, original-error
propagation, and return value.

## Documentation

| Item | Status |
| --- | --- |
| Completion report | This document |
| ADR | **New** — `docs/decisions/0011-database-constraints-beyond-prisma-schema.md` |
| ER diagram | Updated — `docs/er-diagram.md` v1.3, review columns and the partial index |
| Migration notes | Updated — migration 4, including the `migrate dev` caveat |
| Change log | Updated — `CHANGELOG.md` |
| Progress | Updated — `docs/progress.md`, incl. the 3A-3 merge commit and tag record |
| Architecture diagram | **Unchanged** — no new module or boundary |
| Sequence diagram | **Unchanged** — no runtime flow yet; 3B-1b adds the review transitions |
| API summary | **Unchanged** — no HTTP surface |

## Known limitations

- **The columns are inert.** Nothing writes `reviewStatus`, `reviewNote`,
  `reviewedBy`, `reviewedAt`, or increments `analysisRevision` yet — that is
  3B-1b. Mandatory human review is unaffected: no AI output can be published in
  any phase implemented so far.
- **Audit atomicity is still outside this boundary.** `ReviewTransaction`
  deliberately does not cover the audit write; that remains the transactional-
  outbox item in `docs/decisions/TODO.md`, and this milestone does not claim
  otherwise.
- The partial index is invisible to Prisma's datamodel — see the `migrate dev`
  caveat above.
- Remote publication of all eight `phase-*-complete` tags is still blocked by
  `HTTP 403` on tag refs. They exist locally only and are **not** claimed to
  exist on GitHub; see `docs/progress.md`.
