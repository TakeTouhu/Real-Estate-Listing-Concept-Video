# Phase 3A-2a Completion Report — Analysis persistence and live-PostgreSQL CI

Status: **implemented, awaiting review**
Branch: `claude/real-estate-virtual-tour-phase-3a2a-hga252`
Base: `main` at `a2bbf473512c8f0c0df4121b1111e66b08699dd7` (merged Phase 3A-1)

## Milestone scope decision (made before writing production code)

Phase 3A-2 as originally planned came to **17 files / ≈916 lines**, which does
not fit the ~500-line guideline in `CLAUDE.md`, so it was split before
implementation:

| Milestone | Scope | Status |
| --- | --- | --- |
| **3A-2a** | `asset_analyses` table, migration, Prisma repository, live-PostgreSQL CI job, real-database integration tests | **this PR** |
| 3A-2b | `AnalysisService` orchestration (authorization, idempotency, audit, provider invocation), its in-memory repository double, service unit tests, sequence-diagram update | planned, **not** implemented |
| 3A-3 | HTTP endpoints and analysis review surface | planned, not implemented |

### Deviation from the first published split, and how it was corrected

The first version of this split declared 3A-2a as "persistence only, ≈435 lines"
with `AnalysisService` in 3A-2b. While implementing, `analysis-service.ts` and
its test were written onto this branch anyway — 3A-2b scope. That was the
forbidden "implement then split" pattern and it was corrected rather than
shipped: both files were **deleted** from the branch, not held aside for reuse,
so 3A-2b will be implemented fresh and reviewed on its own.

The boundary was then adjusted once more, deliberately and before commit: the
in-memory repository double moved from 3A-2a to 3A-2b, because its only consumer
is the service, and the live-PostgreSQL job moved *into* 3A-2a, because a
migration and a repository should ship with real-database verification. Final
size: **382 changed lines** excluding `pnpm-lock.yaml` and the generated
migration SQL, plus documentation — within the guideline.

## What was implemented

### Schema and migration

`asset_analyses` (`packages/database/prisma/schema.prisma`), with enums
`AnalysisStatus` and `RoomType` mirroring the Phase 3A-1 domain vocabulary.

- `organizationId` on the row — tenant scope is a column, not an inference.
- `assetId` is **unique** and cascades from `media_assets`, so an asset can hold
  at most one analysis and deleting the asset removes it.
- `detectedObjects` / `safetyFlags` are `jsonb NOT NULL DEFAULT '[]'`; only
  normalized, length-bounded arrays are written — never raw provider payloads.
- Indexes: `(organizationId, status)`, `(organizationId, duplicateGroup)`.

Migration `00000000000002_phase3a2_asset_analysis` is additive only and needs no
backfill. It was generated from the committed schema with
`prisma migrate diff --from-schema-datamodel`, so the SQL is machine-generated
rather than hand-written. Details and rollback in `docs/migration-notes.md`.

### Repository adapter

`createPrismaAnalysisRepository` (`packages/database/src/analysis-repositories.ts`)
implements the Phase 3A-1 `AssetAnalysisRepository` port. Every read is
`findFirst({ where: { …, organizationId } })` or a `findMany` filtered on
`organizationId`, so a row belonging to another tenant is **not found** rather
than merely refused. `listByAssetIds` short-circuits on an empty input instead
of issuing an unbounded query. Domain types cross the Prisma JSON boundary
through explicit casts at the adapter edge only; no `any`.

### Live-PostgreSQL CI

A second CI job, `database`, runs against a `postgres:16` service container with
throwaway credentials (no production credentials, no production data):

1. `prisma migrate deploy` against an **empty** database — proves the committed
   migrations build the schema from nothing.
2. `CREATE DATABASE revt_shadow`, then
   `prisma migrate diff --from-migrations … --to-schema-datamodel … --exit-code`
   — fails the build on any schema/migration drift.
3. `pnpm test:db` — the integration suite.

`pnpm test` remains offline and database-free; integration suites are excluded
from the default config and opted into via `vitest.integration.config.ts`.

### Also included

A root `tsconfig.json` so `vitest*.config.ts` and `tests/**` are typechecked.
They were previously linted but not typechecked; the new step immediately caught
a malformed `SafetyFlag` fixture in the integration test.

## Verification

All commands run on this branch at the committed tree.

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | **pass** — root + 11 workspaces, 0 errors |
| Lint | `pnpm lint` | **pass** — 0 errors, 0 warnings |
| Unit tests (offline) | `pnpm test` | **pass** — 162/162 in 20 files, `DATABASE_URL` unset |
| Production build | `pnpm build` | **pass** — Next.js 15 build, 10 routes |
| Migrate from empty DB | `pnpm --filter @app/database run db:migrate` | **pass** — 3 migrations applied |
| Schema drift | `prisma migrate diff … --exit-code` | **pass** — `No difference detected.` (exit 0) |
| Integration tests | `pnpm test:db` | **pass** — 5/5 against local PostgreSQL 16 |

The five integration assertions: JSON column round-trip (including `jsonb`
arrays and nullable scores), cross-tenant invisibility for `findById` /
`findByAssetId` / `listByAssetIds`, the one-analysis-per-asset unique
constraint, list filtering by requested asset ids, and cascade deletion of the
analysis when its asset is deleted.

## Required phase documentation

| Item | Status |
| --- | --- |
| Architecture diagram | **Not applicable** — no new module or boundary; `docs/architecture.md` v1.1 already places persistence behind the repository ports. |
| Entity-relationship diagram | Updated — `docs/er-diagram.md` v1.2 adds `ASSET_ANALYSES` and its cascade/index notes. |
| Critical sequence diagram | **Not applicable** — this milestone adds no runtime flow. `docs/sequence-analysis-lifecycle.md` already documents the intended flow and is updated when `AnalysisService` lands in 3A-2b. |
| OpenAPI / API change summary | **Not applicable** — no HTTP surface changes. |
| Change log | Updated — `CHANGELOG.md`. |
| Release notes | **Not applicable** at milestone level; Phase 3A release notes are written when all 3A milestones merge. |
| Database migration notes | Updated — `docs/migration-notes.md` migration 3. |
| Phase completion report | This document. |

## Known limitations and remaining work

- No `AnalysisService`, so nothing yet authorizes, audits, or de-duplicates an
  analysis request; the table and repository are unreachable from the
  application. Deliberate — Phase 3A-2b.
- No HTTP endpoint and no review UI (Phase 3A-3).
- `reviewedBy` / `reviewedAt` exist as columns but nothing writes them until the
  human-review surface ships. Mandatory human review is unaffected: no AI output
  can be published in any phase implemented so far.
- The integration suite covers the analysis repository only. Extending it to the
  identity and property repositories is worthwhile follow-up and is recorded in
  `docs/decisions/TODO.md`.
- Remote publication of the annotated tags `phase-0-complete`,
  `phase-1-complete`, `phase-2-complete`, and `phase-3a1-complete` is still
  blocked by `HTTP 403` on tag refs from this environment. The tags exist
  locally and are **not** claimed to exist on GitHub; see `docs/progress.md` for
  the exact push commands a maintainer must run.
