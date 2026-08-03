# Phase 3C-1 Completion Report — Storyboard persistence

Status: **implemented, awaiting review**
Branch: `claude/real-estate-virtual-tour-phase-3c1-hga252`
Base: `main` at `6a5c8484e225f89147b168f54b7d62edfd072dc2` (merged Phase 3B)

Persistence and infrastructure only: `VideoProject` and `StoryboardScene`
entities, their Prisma models and additive migration, tenant-scoped
repositories, and live-PostgreSQL integration tests.

**Deliberately absent**, per the approved scope: no composition algorithm, no
prompt compiler, no moderator, no `StoryboardService`, no HTTP endpoints, no UI,
no Phase 4 work.

## Milestone size — over the target, reported not absorbed

| File | Changed code lines |
| --- | --- |
| `tests/integration/storyboard-repository.db.test.ts` | 228 |
| `packages/database/src/storyboard-repositories.ts` | 145 |
| `packages/domain/src/storyboard/types.ts` | 82 |
| `packages/database/prisma/schema.prisma` | 75 |
| `packages/domain/src/storyboard/ports.ts` | 66 |
| barrels (`domain`, `database`, `storyboard/index.ts`) | 4 |
| **Total** | **604** — 375 production + 229 tests |

Generated migration SQL excluded, per policy. Estimated ~500 before
implementation, so this is **21% over** (571 at first review, plus the narrowed
update contract requested in review) — schema 75 against 62 (the composite
keys and their rationale comments), repositories 145 against 115 (enumerating
mutable update fields rather than spreading, after the defect below), and tests
228 against 185 (nine cases, including two the tenant model exists to make
possible).

## The six decisions, as implemented

### 1. Freshness — fingerprint on the project, provenance on the scene

`video_projects.compositionFingerprint` (nullable) holds the digest of the
approved-analysis input set a storyboard was composed from;
`storyboard_scenes.sourceAnalysisRevision` records per-scene provenance. Both
columns exist and round-trip.

**No cross-module hook exists**, as required: nothing in `AnalysisService` knows
about storyboards, and `packages/domain/src/analysis/` has a zero diff.
Freshness is a comparison a reader performs, so it stays correct however long
after the refresh it is asked.

The **fingerprint computation itself is not in this milestone** — see "Scope
question" below.

### 2–4. Minimum scenes, image reuse, project settings

`MIN_STORYBOARD_SCENES = 3` is defined in the domain types with the rule it
encodes; enforcement lives in 3C-2/3C-4 where composition happens. The schema
stores `durationSeconds`, `aspectRatio`, and `resolution` as requested with
**no capability table and no provisional provider limits** — Phase 4 owns that
validation. Nothing in this milestone reuses an image or shortens a storyboard,
because nothing composes one.

### 5. Moderation

Not in this milestone. No moderation vocabulary was invented.

### 6. Tenant modelling — no `organizationId` on `StoryboardScene`

Implemented as you preferred, and **I did not need to justify keeping the
column**. Scenes carry no organization:

- **Reads** resolve tenant scope through the parent —
  `where: { videoProjectId, videoProject: { organizationId } }` — a join
  predicate, not an application-side check that a future caller could omit.
- **Writes** are constrained by two *composite* foreign keys:
  `(videoProjectId, propertyId) → video_projects(id, propertyId)` and
  `(assetId, propertyId) → media_assets(id, propertyId)`.

`propertyId` on the scene is not convenience denormalization — it is the shared
column that makes both foreign keys possible. Because a property belongs to
exactly one organization, a scene whose project and asset sit in different
properties is **rejected by PostgreSQL**, not merely discouraged. That is the
"appropriate composite relationship" standard applied even though the column was
dropped. Supporting unique keys `video_projects(id, propertyId)` and
`media_assets(id, propertyId)` exist solely to make the foreign keys legal; the
latter is the only change to an existing table, and it adds an index.

A test inserts a scene pairing this property's project with another tenant's
asset and asserts the database refuses it.

`UNIQUE(videoProjectId, position)` is in place, so recomposition replaces a
project's scenes wholesale rather than diffing them — reflected in the
`replaceForProject` port.

## Repository update contract — made unrepresentable, as required

`VideoProjectRepository.update(organizationId, id, changes)` accepts a
`VideoProjectUpdate` covering only genuinely mutable fields. `propertyId`,
`organizationId`, `createdAt` and `updatedAt` **cannot be supplied at all**: a
requested property move is a compile error, not a silently ignored field, and
`updatedAt` stays database-managed because nothing can write it. The
organization is an addressing argument rather than payload, so a write can never
target another tenant by carrying a different id in the body.

**This does not conflict materially with the rest of the codebase, and nothing
else was refactored.** The older ports — `AssetAnalysisRepository`,
`PropertyRepository`, `MediaAssetRepository`, `InvitationRepository` — still
take a whole entity and rely on their adapters enumerating mutable columns. The
new port diverges deliberately and *locally*: it has no other callers yet, so
adopting the narrower contract required **zero** changes outside this milestone.
The two styles should not coexist indefinitely; converging them is a
cross-repository refactor and is recorded in `docs/decisions/TODO.md` for its own
approval rather than performed here.

### How the earlier version failed

The first implementation spread the domain object into Prisma's `data`. That
wrote back a stale `updatedAt` (defeating `@updatedAt`, so the column would have
frozen at creation time) and allowed `propertyId` to be rewritten, moving a
project to another property straight past the composite keys. Enumerating the
mutable fields fixed the symptom; the narrowed contract removes the possibility.

## `MIN_STORYBOARD_SCENES` is vocabulary only — confirmed

`grep -rn MIN_STORYBOARD_SCENES` finds exactly one hit: its declaration in
`packages/domain/src/storyboard/types.ts`. It is referenced by no repository, no
schema constraint, and no migration. **Persistence enforces no composition
minimum** — a project with zero scenes stores happily, which is correct, since
composition is 3C-2/3C-4 work.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — 302/302 in 26 files (unchanged; this milestone adds no offline tests) |
| `pnpm build` | **pass** |
| `pnpm test:db` | **pass** — **24/24** in 4 files (9 new) |
| Migration on an **empty** database | **pass** — rebuilt `revt_verify` from all five migrations, then ran the full DB suite against it |
| Drift check | **pass** — `No difference detected.` (exit 0) |
| `packages/domain/src/analysis/` diff | **zero** |
| HTTP routes diff | **zero** |

### Integration coverage (9 cases, live PostgreSQL)

| Area | Coverage |
| --- | --- |
| Project round-trip | nullable settings, status, fingerprint; `updatedAt` advances |
| Project tenant isolation | another org's project is invisible to `findById` / `listByProperty`, and an update scoped to it changes nothing |
| Immutability | an update naming only `name` leaves every other field, and identity, untouched |
| Scene replacement | wholesale replace, position ordering, position reuse after replacement |
| Position uniqueness | two scenes at one position rejected, leaving no partial write |
| Scene tenant scope | reads and writes for another org return nothing / reject, resolved through the project |
| **Cross-property insert** | **the composite foreign key rejects a scene mixing tenants** |
| Cascades | deleting the project, or the source asset, deletes its scenes |

## Documentation

| Item | Status |
| --- | --- |
| Completion report | This document |
| ER diagram | **Updated** — v1.4, two new entities plus the tenant-modelling note |
| Migration notes | **Updated** — migration 5, including the composite-FK rationale and rollback |
| Architecture diagram | **Updated** — the new `storyboard` domain module |
| Change log | Updated — `CHANGELOG.md` |
| Progress | Updated — `docs/progress.md` |
| API summary | **Unchanged** — no endpoint exists yet |
| Sequence diagram | **Unchanged** — no new interaction; composition arrives in 3C-2/3C-4 |

## Scope question for review

**Where does `computeCompositionFingerprint` belong?** The *column* is here, as
instructed. The *function* needs the definition of "eligible input set"
(approved analyses of a property), which is composition's own vocabulary — so I
left it for 3C-2, where the composer produces the scenes and the fingerprint of
the inputs it used in one place. Including it here would also have pushed this
milestone to roughly 690 lines.

If you want it in 3C-1 instead, it is a small follow-up: a pure function over a
sorted `(assetId, analysisRevision)` list plus its unit tests, ~120 lines, with
the column already in place.

## Deferred deliberately

- **In-memory storyboard repository double** — nothing in this milestone
  consumes it. It lands with `StoryboardService` in 3C-4, which is the first
  code that needs one.
- **`StoryboardScene.status`** — `docs/DataModel.md` lists the column but
  documents no vocabulary, and every plausible value (`GENERATING`, `READY`,
  `FAILED`) describes generation, which is Phase 4. Rather than invent an enum,
  the column is omitted; recorded for Phase 4.

## Known limitations

- A storyboard cannot yet be created, read over HTTP, or displayed. This
  milestone is persistence only.
- No audit events — storyboard actions are audited in 3C-4, where the service
  performing them exists.
- Remote publication of all twelve `phase-*-complete` tags remains blocked by
  `HTTP 403` on tag refs. They exist locally only and are **not** claimed to
  exist on GitHub.
