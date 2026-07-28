# Phase 3A-1 Completion Report

Version: 1.0
Date: 2026-07-28
Milestone: Phase 3A-1 — analysis contracts and deterministic offline provider
Status: **Review candidate. Not approved, not merged. No phase tag** (a milestone
PR never receives a `phase-N-complete` tag).
Governance: `CLAUDE.md` v1.3

## Milestone context

Phase 3A as scoped measured **~2,058 changed lines** before documentation
(~2,950 with docs) — 4–6× the ~500-line guideline. Per the explicit instruction
*"If the milestone exceeds the guideline, split Phase 3A before continuing"*,
Phase 3A is delivered as three sequential milestones:

| Milestone | Content | Size (excl. lockfile/migration SQL) | Status |
| --- | --- | --- | --- |
| **3A-1** | Analysis contracts, normalization, ordering/duplicate rules, deterministic offline provider, config | **869 lines / 13 files** | **This PR** |
| 3A-2 | Prisma `AssetAnalysis` model + migration + tenant-scoped repository, in-memory repository, `AnalysisService` (authorization, audit, idempotency, READY-only validation) | ~790 lines | Written + verified locally; **held, not pushed** |
| 3A-3 | Live PostgreSQL CI job, migration-from-empty + repository tenant-isolation integration tests | ~462 lines | Written + verified locally; **held, not pushed** |

3A-2 and 3A-3 were fully implemented and exercised locally before the split — the
live PostgreSQL suite passed 13/13 from an empty database, and the schema/migration
drift check reported *"No difference detected."* They are withheld from this
branch so each milestone is reviewed on its own, per the rule against adding
later-milestone code to an earlier milestone's branch.

## Objective delivered

The image-analysis **contract and provider layer**: a vendor-neutral seam, the
full `AssetAnalysis` record shape, platform-owned normalization and rules, and a
deterministic offline adapter — with no HTTP surface and no persistence, so
nothing is half-exposed.

## Requirement coverage (Phase 3A scope)

| Requirement | 3A-1 | Note |
| --- | --- | --- |
| `AssetAnalysis` domain entity | ✅ | `analysis/types.ts` |
| Room-type classification result | ✅ | 15-value vocabulary + guard |
| Confidence score | ✅ | 0..1, `LOW_CONFIDENCE_THRESHOLD` 0.6 |
| Quality score | ✅ | 0..1 |
| Brightness score | ✅ | 0..1, measured from real bytes |
| Blur score | ✅ | 0..1 |
| Duplicate-group reference | ✅ | `resolveDuplicateGroup` |
| Detected-object metadata | ✅ | capped at 50, confidences clamped |
| Safety and privacy flags | ✅ | 8 codes × BLOCKING/WARNING |
| Suggested display order | ✅ | `roomOrderRank` |
| Analysis status and failure reason | ✅ | status enum + field |
| `ImageAnalysisProvider` interface | ✅ | ADR-0009 |
| Deterministic offline analysis adapter | ✅ | no network I/O |
| Provider request/result normalization | ✅ | plus error normalization |
| No real external AI calls | ✅ | `deterministic` only; fail-fast otherwise |
| Prisma model and migration | ⏭ 3A-2 | |
| Tenant-scoped repository | ⏭ 3A-2 | |
| Analysis service with authorization | ⏭ 3A-2 | |
| Audit logging | ⏭ 3A-2 | vocabulary ships in 3A-1 |
| Idempotent creation or refresh | ⏭ 3A-2 | |
| READY-only eligibility validation | ⏭ 3A-2 | |
| Live PostgreSQL CI | ⏭ 3A-3 | |
| No review UI / storyboard / prompt compilation | ✅ | none added |

## Required documentation

| Required item | Status | Location |
| --- | --- | --- |
| Gap analysis | ✅ | `docs/gap-analysis-phase-3a1.md` |
| ADR — image-analysis provider boundary | ✅ | `docs/decisions/0009-image-analysis-provider-boundary.md` |
| ADR — live PostgreSQL CI | ⏭ **3A-3** | The CI change itself is in 3A-3; writing its ADR here would document behavior this PR does not contain |
| Architecture diagram update | ✅ | `docs/architecture.md` v1.1 |
| ER diagram update | ✅ | `docs/er-diagram.md` v1.1 — records that no `asset_analyses` table exists yet |
| Analysis lifecycle sequence diagram | ✅ | `docs/sequence-analysis-lifecycle.md`, with 3A-1 vs 3A-2 steps labelled |
| API change summary | ✅ | `docs/api-changes-phase-3a1.md` — explicit **Not applicable** |
| Migration notes | ✅ | `docs/migration-notes.md` — explicit **no migration in 3A-1** |
| Changelog entry | ✅ | `CHANGELOG.md` |
| Completion report | ✅ | this document |

## Exact test results

Environment: Node.js v22.22.2, pnpm 10.33.0, TypeScript 5.7.3, Vitest 3.2.7.

```text
pnpm typecheck   → PASS   tsc --noEmit across 11 workspace projects
pnpm lint        → PASS   eslint . — 0 problems
pnpm test        → PASS   19 files, 162 tests, 0 failed
pnpm build       → PASS   next build — compiled successfully, 16 routes
```

New in this milestone (+31 tests, 131 → 162):

| Test file | Tests |
| --- | --- |
| `packages/domain/src/analysis/analysis-contracts.test.ts` | 21 |
| `packages/ai-providers/src/deterministic-analysis-provider.test.ts` | 10 |

Coverage of the required check list:

| Required check | Result |
| --- | --- |
| `pnpm typecheck` | ✅ |
| `pnpm lint` | ✅ |
| `pnpm test` | ✅ 162 tests |
| `pnpm build` | ✅ |
| Offline-provider mapping tests | ✅ determinism, room vocabulary, score bounds, brightness from bytes, forced overrides, empty-input rejection, error normalization, no network |
| Live PostgreSQL migration test | ⏭ 3A-3 (passed locally: 5/5) |
| Live PostgreSQL repository integration tests | ⏭ 3A-3 (passed locally: 8/8) |
| Tenant-isolation tests | ⏭ 3A-2 (service) / 3A-3 (repository) — 3A-1 has no data access to isolate |
| Audit-event tests | ⏭ 3A-2 — 3A-1 ships the vocabulary, not the emission |

**Unit tests are database-independent**, verified by running the full suite with
`DATABASE_URL` unset: 162/162 pass.

## Migration result

**No migration in this milestone.** The Prisma schema is byte-identical to
Phase 2. Verified: `packages/database/prisma/schema.prisma` and
`prisma/migrations/` are unchanged from `origin/main`.

## PostgreSQL integration result

**Not in this milestone** (3A-3). Recorded for transparency, the held work was
verified locally before the split against PostgreSQL 16:

- `prisma migrate deploy` onto an empty database: all three migrations applied,
  `finished_at` set, `rolled_back_at` null.
- Drift check with a shadow database: **"No difference detected."**
- Integration suite: **13/13 passing** (5 migration, 8 repository/tenant
  isolation), including cross-tenant denial by id, by asset, and in bulk.

Those results belong to 3A-3 and will be re-run in CI when that milestone is
submitted; they are **not** claimed as verification of this PR.

## Security posture

- No secrets added. `ANALYSIS_PROVIDER` is a non-secret server-side setting.
- The provider seam receives only internal identifiers, image bytes, and
  dimensions — never customer names or addresses.
- `AnalysisProviderError.messageSanitized` is the only error text that leaves the
  adapter; raw provider payloads never propagate.
- Malformed provider output cannot inflate a score: any non-finite value
  normalizes to 0, and unknown room types collapse to `OTHER` with confidence 0.
- No network I/O in the analysis path.

## Known limitations

1. **The deterministic adapter is a structural stand-in, not a classifier.** Its
   room labels carry no claim about real photo content and must not be shown to
   customers as accurate. Phase 3B (every AI decision correctable) is the
   safeguard; a real provider needs its own ADR, cost controls, and a
   production-safety guard per the ADR-0008 precedent.
2. Nothing enforces low-confidence confirmation or blocking findings yet — 3A-1
   records the signals only (`isLowConfidence`, `hasBlockingFlag`); enforcement
   is Phase 3B.
3. Analysis is not persisted or reachable over HTTP in this milestone.
4. `packages/queue` remains a placeholder; when wired in 3A-2 analysis runs
   synchronously. Moving it to the worker is a Phase 4 follow-up.

## Unresolved blockers

Carried over, unchanged by this milestone:

- **Remote phase tags are still unpublished.** `phase-0-complete`,
  `phase-1-complete`, and `phase-2-complete` exist only locally; tag-ref pushes
  fail with `HTTP 403` and `git ls-remote --tags origin` is empty. Needs a
  maintainer push (`docs/progress.md`).
- Production blockers from Phase 2 remain open: durable S3/Azure object storage,
  a real malware-scanning engine, and moving image processing off the request
  path.

## Next steps

**Phase 3B is not started.** Per governance, 3A-2 is submitted only after this
milestone is reviewed, CI passes, and it is merged; 3A-3 follows 3A-2. No
`phase-3-complete` tag is created until all three Phase 3A milestones — and the
remaining Phase 3B/3C milestones — are merged and verified.
