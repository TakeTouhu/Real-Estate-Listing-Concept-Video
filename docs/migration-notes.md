# Database Migration Notes

Source of truth: `packages/database/prisma/schema.prisma`
Migrations: `packages/database/prisma/migrations/`

## Applying migrations

```bash
# generate the client (also runs automatically on pnpm install)
pnpm --filter @app/database run db:generate

# apply committed migrations (deploy / CI / production)
pnpm --filter @app/database run db:migrate

# create and apply a new migration during development
pnpm --filter @app/database run db:migrate:dev
```

`DATABASE_URL` must point at the target PostgreSQL database. The repository's
required checks (`pnpm check`) do **not** need a database.

## Migration history

| # | Name | Phase | Nature |
| --- | --- | --- | --- |
| 1 | `00000000000000_init` | 1 | Identity foundation |
| 2 | `00000000000001_phase2_properties_media` | 2 | Properties + media assets |
| 3 | `00000000000002_phase3a2_asset_analysis` | 3A-2a | Asset analysis results |
| 4 | `00000000000003_phase3b1a_review_state` | 3B-1a | Human-review state |
| 5 | `00000000000004_phase3c1_storyboard` | 3C-1 | Video projects + storyboard scenes |
| 6 | `00000000000005_phase3d1_review_corrections` | 3D-1 | Human review corrections |
| 7 | `00000000000006_phase4a2a_scene_generations` | 4A-2a | Scene-generation attempts |

### 1 — `00000000000000_init` (Phase 1)

Creates enums `OrganizationStatus`, `UserStatus`, `Role`, `InvitationStatus` and
tables `organizations`, `users`, `credentials`, `memberships`, `invitations`,
`sessions`, `audit_logs`.

### 2 — `00000000000001_phase2_properties_media` (Phase 2)

**Additive only. No existing column is altered, renamed, or dropped, so it is
safe to apply to a populated Phase 1 database and requires no backfill.**

Creates:

- Enums: `PropertyStatus` (`ACTIVE`, `ARCHIVED`, `DELETED`), `PropertyType`
  (`APARTMENT`, `HOUSE`, `OFFICE`, `RETAIL`, `OTHER`), `MediaAssetStatus`
  (ten upload-lifecycle values).
- Table `properties` — tenant-owned, `organizationId` FK with `ON DELETE CASCADE`.
- Table `media_assets` — tenant-owned, `propertyId` FK with `ON DELETE CASCADE`;
  unique `storageKey`.
- Indexes: `properties(organizationId, status)`,
  `media_assets(organizationId, propertyId, status)`,
  `media_assets(organizationId, sha256)`.

Nullable-by-design columns on `media_assets` (unknown until the bytes are
validated and processed): `mimeType`, `sizeBytes`, `width`, `height`, `sha256`,
`perceptualHash`, `thumbnailKey`, `failureReason`, `deletionRequestedAt`,
`retentionExpiresAt`.

**Rollback.** Because the change is purely additive, rollback is
`DROP TABLE media_assets; DROP TABLE properties;` followed by dropping the three
new enum types. Prisma does not generate down-migrations; a forward fix is
preferred in production. Dropping these tables destroys uploaded-asset metadata —
the underlying stored objects would need separate cleanup.

### 3 — `00000000000002_phase3a2_asset_analysis` (Phase 3A-2a)

**Additive only. No existing column is altered, renamed, or dropped, so it is
safe to apply to a populated Phase 2 database and requires no backfill.**

Creates:

- Enums: `AnalysisStatus` (`PENDING`, `SUCCEEDED`, `FAILED`), `RoomType`
  (the 15 values of `ROOM_TYPES` in `packages/domain/src/analysis/types.ts`).
- Table `asset_analyses` — tenant-owned via `organizationId`; `assetId` is a
  unique FK to `media_assets(id)` with `ON DELETE CASCADE`, so an asset has at
  most one analysis and deleting the asset removes it.
- Indexes: `asset_analyses(organizationId, status)`,
  `asset_analyses(organizationId, duplicateGroup)`, plus the unique index on
  `assetId`.

`detectedObjects` and `safetyFlags` are `jsonb NOT NULL DEFAULT '[]'`; the
repository always writes normalized, length-bounded arrays, never raw provider
payloads. Nullable-by-design columns (unknown until an analysis succeeds):
`roomType`, `confidence`, `qualityScore`, `brightnessScore`, `blurScore`,
`duplicateGroup`, `suggestedOrder`, `failureReason`, `reviewedBy`, `reviewedAt`.

Generated offline with
`prisma migrate diff --from-schema-datamodel ... --to-schema-datamodel ... --script`,
so the SQL is machine-generated from the committed schema rather than hand-written.

**Rollback.** Purely additive, so rollback is
`DROP TABLE asset_analyses;` followed by `DROP TYPE "RoomType"; DROP TYPE "AnalysisStatus";`.
Prisma does not generate down-migrations; a forward fix is preferred in
production. Dropping the table destroys analysis results only — uploaded assets
and stored objects are untouched, and analyses can be re-derived by re-running
the deterministic adapter.

### 5 — `00000000000004_phase3c1_storyboard` (Phase 3C-1)

**Additive only. No existing column is altered, renamed, or dropped, so it is
safe to apply to a populated database and requires no backfill.**

Creates:

- Enum `VideoProjectStatus` (`DRAFT`, `STORYBOARD_READY`, `STORYBOARD_STALE`).
- Table `video_projects`, including `compositionFingerprint` (nullable) — the
  digest of the approved-analysis input set a storyboard was composed from.
- Table `storyboard_scenes`, with `UNIQUE(videoProjectId, position)`.
- Two **composite** foreign keys from `storyboard_scenes`:
  `(videoProjectId, propertyId) → video_projects(id, propertyId)` and
  `(assetId, propertyId) → media_assets(id, propertyId)`.
- The unique keys those foreign keys require: `video_projects(id, propertyId)`
  and **`media_assets(id, propertyId)`** — the only change this migration makes
  to an existing table, and it adds an index rather than altering a column.

`storyboard_scenes` deliberately has **no `organizationId`**. Tenant scope comes
from the owning project, and the composite foreign keys make a scene whose
project and asset belong to different properties — and therefore different
organizations — impossible to insert. Enforcing that in the database rather than
in application code is the same reasoning as the Phase 3B-1a partial unique
index.

Rollback: `DROP TABLE storyboard_scenes; DROP TABLE video_projects;` then
`DROP TYPE "VideoProjectStatus";` and, if desired,
`DROP INDEX media_assets_id_propertyId_key;`. Nothing else references the new
tables, and no analysis or asset data is affected.

### 4 — `00000000000003_phase3b1a_review_state` (Phase 3B-1a)

**Additive only. No existing column is altered, renamed, or dropped, so it is
safe to apply to a populated database and requires no backfill.**

Creates:

- Enum `ReviewStatus` (`UNREVIEWED`, `APPROVED`, `REJECTED`).
- Columns on `asset_analyses`: `reviewStatus` (NOT NULL, default `UNREVIEWED`),
  `reviewNote` (nullable), `analysisRevision` (NOT NULL, default 1).
- Index `asset_analyses(organizationId, reviewStatus)`.
- **A hand-written partial unique index** (see below).

Existing rows default to `UNREVIEWED` at revision 1, which is correct: nothing
had been reviewed before this milestone.

#### The hand-written partial unique index

```sql
CREATE UNIQUE INDEX "asset_analyses_org_dupgroup_approved_key"
  ON "asset_analyses" ("organizationId", "duplicateGroup")
  WHERE "duplicateGroup" IS NOT NULL AND "reviewStatus" = 'APPROVED';
```

It makes the database authoritative for "at most one `APPROVED` analysis per
duplicate group", so two concurrent approvals of different members of the same
group cannot both succeed — the loser gets a unique violation.

**Prisma cannot express a partial index in `schema.prisma`** (`@@unique(...,
where: ...)` fails `prisma validate` on 5.22), so this statement is appended to
the generated migration by hand, under **ADR-0011 — database constraints beyond
the Prisma schema**, which sets the conditions for doing so.

Two consequences, both verified rather than assumed:

- The CI drift check still passes. `prisma migrate diff --from-migrations
  --to-schema-datamodel --exit-code` reports `No difference detected.` because
  Prisma ignores the index it cannot represent.
- **`prisma migrate dev` may generate a migration that drops this index**, since
  it is invisible to the datamodel. Inspect every future generated migration for
  a `DROP INDEX "asset_analyses_org_dupgroup_approved_key"` and remove it.

**Rollback.** Purely additive:
`DROP INDEX "asset_analyses_org_dupgroup_approved_key";`, drop the three
columns, then `DROP TYPE "ReviewStatus";`. Dropping them destroys review
decisions; the audit log retains the history.

### 6 — `00000000000005_phase3d1_review_corrections` (Phase 3D-1)

Four nullable columns on `asset_analyses` so a reviewer can correct what the
analyzer decided:

| Column | Type | Meaning |
| --- | --- | --- |
| `roomTypeOverride` | `"RoomType"` | corrected classification; null means the analyzer's stands |
| `orderOverride` | `INTEGER` | reviewer's sort priority, lower first |
| `correctedBy` | `TEXT` | actor |
| `correctedAt` | `TIMESTAMP(3)` | when |

**Purely additive.** No backfill, no index, no constraint, no change to any
existing column. `NULL` everywhere means "no human correction", which is exactly
the behaviour before this migration, so existing rows need no attention and
application code that ignores these columns keeps working. Verified applying
cleanly to an **empty** database through the full migration chain, and the drift
check reports `No difference detected.` (exit 0).

**No index, deliberately.** A correction is read as part of the analysis row
already being loaded by primary key or by the unique `assetId`, and is never
searched by.

**No constraint on `orderOverride`, deliberately.** Duplicate priorities across
rows are legitimate and resolve deterministically during ordering, and which
values are *valid* is a product rule owned by the correction service (Phase
3D-2) — the schema must not encode a rule that has not shipped. A live test
asserts that `0`, a negative, and a large priority all persist unchanged.

**The analyzer's output is untouched.** `roomType` and `suggestedOrder` keep
their values; a correction is stored beside the AI value, never over it, so the
model's answer stays recoverable and `confidence` keeps describing the value it
was produced for (ADR-0015).

**Freshness consequence, arriving in Phase 3D-3, not here.** When the
composition fingerprint payload widens to include `effectiveRoomType` and
`orderOverride`, every digest changes, so **every storyboard composed under the
old format reads stale once** and must be recomposed. That is the fail-safe
direction and needs **no data migration and no fingerprint backfill**. Phase
3D-1 changes no fingerprint and has no such effect.

**Rollback.** Purely additive:

```sql
ALTER TABLE "asset_analyses"
  DROP COLUMN "roomTypeOverride",
  DROP COLUMN "orderOverride",
  DROP COLUMN "correctedBy",
  DROP COLUMN "correctedAt";
```

Dropping them destroys any recorded corrections; the audit log (from Phase 3D-2)
retains the history. The `"RoomType"` enum is shared with `roomType` and must
**not** be dropped.

### 7 — `00000000000006_phase4a2a_scene_generations` (Phase 4A-2a)

One new enum and one new table recording **attempts to generate a scene through
a video provider**. Purely additive: no existing table, column, index, or
constraint is touched.

`SceneGenerationState` carries exactly the eight states Phase 4A-1 defined —
`QUEUED`, `SUBMITTING`, `PROCESSING`, `SUCCEEDED`, `FAILED_RETRYABLE`,
`FAILED_TERMINAL`, `SUBMISSION_UNKNOWN`, `CANCELLED`. No database-only state
exists.

#### This table records money, and the schema reflects that

A `scene_generations` row can represent a paid external call. Three decisions
follow from that, and each is the opposite of the default a schema generator
would pick.

**The video-project foreign key is `ON DELETE RESTRICT`, not `CASCADE`.** Every
other child in this schema cascades; this one deliberately does not. A future
physical deletion path must resolve retention policy for paid-attempt history
*deliberately*, rather than discovering that a cascade nobody thought about
erased it. It is fail-closed, and it changes **no current behaviour**: property
removal today is a soft delete (`status = 'DELETED'`, assets to
`DELETION_PENDING`), and nothing in the product physically deletes a property or
a video project. Recorded as a TODO — before physical deletion ships, the product
must define retention/archive behaviour for generation history.

**`sourceStoryboardSceneId` has no foreign key.** `StoryboardService.compose`
writes through `replaceForProject`, which deletes every scene row for a project
and re-inserts with freshly generated ids. Recomposition is routine — a reviewer
corrects a room and composes again. A cascade would destroy the record of a paid
call on an ordinary user action; a restrict would block recomposition entirely.
Referential integrity is the wrong tool for a row the system deliberately
deletes, so the column is provenance. A live test creates a generation, runs the
**real** `replaceForProject`, and proves the scene is gone while the attempt,
its provenance value, and its project ownership are intact.

**`assetId` has no foreign key either**, for the same reason one step later:
media assets are removed by the retention pipeline, and generation history may
still need to explain what was generated from what.

#### Tenant scope

No `organizationId` column. Ownership is the `videoProjectId` relation, and
reads resolve the tenant through `videoProject: { organizationId }` — the model
`storyboard_scenes` already uses. A live test asserts the column's absence and
that another organization's generation is indistinguishable from one that does
not exist.

#### The hand-written partial unique index

Prisma cannot express `WHERE` on an index, so this is raw SQL in the migration,
the same pattern as Phase 3B-1a:

```sql
CREATE UNIQUE INDEX "scene_generations_active_request_key"
  ON "scene_generations" ("videoProjectId", "requestHash")
  WHERE "state" IN ('QUEUED', 'SUBMITTING', 'PROCESSING', 'FAILED_RETRYABLE', 'SUBMISSION_UNKNOWN');
```

It makes the **database** authoritative for *at most one active attempt per
`(videoProjectId, requestHash)`*, which is what makes concurrent submissions
safe: the loser gets a uniqueness violation rather than a second, separately
billed provider POST. A check-then-insert application read would not survive
concurrency, and a plain `@@unique` would block deliberate regeneration forever.

Two predicate memberships are load-bearing. `FAILED_RETRYABLE` is included
because it can return to `QUEUED`, so releasing the identity there would allow a
duplicate submission path. `SUBMISSION_UNKNOWN` is included because the provider
may already hold a billed prediction for that request. The three terminal states
are excluded, so a finished attempt releases the identity and a deliberate
regeneration can create a new row.

**It is created in the same migration as the table**, on purpose: shipping the
table first would leave a window in which duplicate active attempts are
possible.

**The predicate is guarded against drift.**
`tests/schema/active-generation-states.test.ts` reads this file, parses the
state literals out of the `WHERE … IN (…)` clause, and compares them as a set
with `ACTIVE_SCENE_GENERATION_STATES` from the domain. Adding or removing a
domain active state fails that test until the SQL is updated deliberately.

#### What is deliberately not persisted

No temporary provider output URL — Phase 4D copies a completed output into
managed storage and persists the managed key, so a URL that expires never has to
survive a worker step. A live test asserts no column name contains `url`. No
retry counter either: no worker exists yet to have a retry policy, and a
speculative column would be a guess about a design that has not been reviewed.

`providerPredictionId`, the normalized error fields, and `outputStorageKey` are
**internal only**. There is no customer-facing DTO in this milestone, and
ADR-0016 §9 governs when there is.

#### Verification

Applied cleanly to a dropped-and-recreated **empty** database through the full
seven-migration chain, and the drift check reports `No difference detected.`
(exit 0). The partial index and the `ON DELETE RESTRICT` foreign key were both
confirmed present in `psql \d scene_generations`.

**Rollback.** Purely additive:

```sql
DROP TABLE "scene_generations";
DROP TYPE "SceneGenerationState";
```

Dropping the table destroys the record of every provider attempt, including paid
ones. That is precisely the loss `ON DELETE RESTRICT` exists to prevent
accidentally, so a rollback here is a deliberate decision, never routine cleanup.

### 8 — `00000000000007_phase4b1c_request_snapshot` (Phase 4B-1c)

Adds five nullable columns to `scene_generations`, the immutable execution
snapshot of ADR-0018:

| Column | Type | Null |
| --- | --- | --- |
| `requestCompiledPrompt` | `TEXT` | yes |
| `requestDurationSeconds` | `INTEGER` | yes |
| `requestCameraMotion` | `TEXT` | yes |
| `requestAspectRatio` | `TEXT` | yes |
| `requestResolution` | `TEXT` | yes |

**What it deliberately does not do**, and why each matters:

- **No backfill.** A row admitted before this contract has no recoverable
  snapshot — its storyboard scene may already be deleted, and the project's
  aspect ratio or resolution may have been edited since. Copying today's values
  in would forge a request that was never admitted, one whose facts would not
  even reproduce the stored `requestHash`.
- **No `requestHash` is rewritten**, and **no historical row is deleted**.
- **No index and no constraint.** These columns are reconstruction payload, never
  a lookup key; identity lookups keep using the existing
  `(videoProjectId, requestHash)` partial unique index and the `(state)` index.

`tests/schema/request-snapshot-columns.test.ts` reads this migration file and
asserts all of the above, so the restraint cannot be silently undone.

**Nullability is legacy compatibility only.** Every generation admitted through
`GenerationService.startScene` from this phase onward writes all five, except
`requestCameraMotion` where `null` is a legitimate request value. `null` in the
other four means "predates the contract"; `generationRequestFactsFrom` fails
closed on it rather than substituting current state.

**Conditional backfill, if it is ever wanted.** A legacy row is safely
backfillable only if its `sourceStoryboardSceneId` still exists *and*
recomputing the hash from that scene plus the current project reproduces the
stored `requestHash` — the hash is its own verifier, and a match proves the copy
is reconstruction rather than fabrication. No such script is part of this
milestone.

**Rollback.**

```sql
ALTER TABLE "scene_generations"
  DROP COLUMN "requestCompiledPrompt",
  DROP COLUMN "requestDurationSeconds",
  DROP COLUMN "requestCameraMotion",
  DROP COLUMN "requestAspectRatio",
  DROP COLUMN "requestResolution";
```

Safe for schema shape, but it re-opens the reconstruction gap: every admitted
generation becomes unexecutable again once its storyboard scene is replaced.

### Phase 3A-1 — no migration

**Not applicable.** Phase 3A-1 added no Prisma model and no migration; it shipped
the `AssetAnalysis` domain entity as TypeScript types only.

## Schema/migration parity

The committed migrations must always equal the schema. Verify offline (no
database required):

```bash
cd packages/database
pnpm exec prisma migrate diff --from-empty \
  --to-schema-datamodel prisma/schema.prisma --script > /tmp/from-schema.sql
cat prisma/migrations/*/migration.sql > /tmp/from-migrations.sql
diff <(grep -v '^$' /tmp/from-schema.sql | sort) \
     <(grep -v '^$' /tmp/from-migrations.sql | sort)
```

With a reachable shadow database, the canonical check is:

```bash
pnpm exec prisma migrate diff --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" --exit-code
```

Since Phase 3A-2a this runs in CI in the `database` job against a PostgreSQL 16
service container, after `prisma migrate deploy` has been applied to an empty
database. Verified for this branch: **`No difference detected.` (exit 0)**.

## Operational notes

- Storage objects are **not** managed by migrations. Physical deletion of
  objects for assets in `DELETION_PENDING` is the retention job's job
  (Phase 7, not implemented).
- Audit and billing retention differ from customer-data retention; audit rows
  survive organization deletion because `audit_logs.organizationId` is
  `ON DELETE SET NULL`.
- No seed data is committed. Accounts are created through `/api/auth/register`.

## Phase 4C-0a — `00000000000008_phase4c0a_execution_prompt_freeze`

One additive statement:

```sql
ALTER TABLE "scene_generations" ADD COLUMN "requestRenderedPrompt" TEXT;
```

**Nullable, and not backfilled.** The column stores the exact provider prompt
rendered at admission, which the worker later submits verbatim. Backfilling would
mean rendering historical rows with *today's* renderer — fabricating, for a
request admitted earlier, precisely the bytes the column exists to pin down. A
`NULL` therefore means "predates the freeze contract and cannot be submitted", and
`frozenExecutionPromptFrom` fails closed rather than computing a value.

No index: this is execution payload fetched by primary key through the row a
queued job names, never a lookup key. No `requestHash` is rewritten, no row
deleted, and the 8-fact hash tuple is unchanged (ADR-0023).

Forward-only and safe to run against a populated database: adding a nullable
column takes no table rewrite in PostgreSQL. Rollback is
`ALTER TABLE "scene_generations" DROP COLUMN "requestRenderedPrompt";`, which
discards frozen prompts and returns every admitted row to the pre-freeze state —
so it is only safe while no generation has been submitted.

`tests/schema/execution-prompt-freeze-column.test.ts` parses the migration and
asserts both the shape and the absence of `UPDATE`/`INSERT`/`DELETE`/`TRUNCATE`,
any index, and any reference to `requestHash`.
