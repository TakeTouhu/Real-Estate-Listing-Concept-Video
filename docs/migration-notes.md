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

## Phase 4C-3B-2B — `00000000000009_phase4c3b2b_resolution_identity_v2`

The first migration in this project that **can refuse to run**, and the first
that constrains a column customers have already written to.

### What it does

1. Checks every `video_projects.resolution` against the product vocabulary and
   **raises** if any row is outside it, then adds
   `video_projects_resolution_target_check` restricting it to `720p` / `1080p`.
2. Adds five nullable columns to `scene_generations` — `requestModelKey`,
   `requestTargetOutputResolution`, `requestNativeGenerationResolution`,
   `requestResolutionNormalization`, `requestNativeMeetsTarget` — plus closed
   vocabulary constraints on two of them and non-blank constraints on the model
   key and the native token.
3. Adds `scene_generations_request_identity_version_check`, which makes the two
   request-identity vocabularies mutually exclusive per row, keyed off the
   version prefix the row's own `requestHash` carries.

### What it deliberately does not do

No `UPDATE`, no `INSERT`, no `DELETE`, no `TRUNCATE`, no `DROP`, no `RENAME`, no
index. No `requestHash` is rewritten and no V1 snapshot is backfilled.

The physical column keeps the name `resolution`; the Prisma model maps
`targetOutputResolution` onto it. A physical rename would be a larger, riskier
migration that buys nothing — the meaning is fixed by the constraint and the
domain type, not by the column name.

`requestResolution` is retained. The rows carrying it were hashed over it, so
dropping the column would destroy the only surviving record of what a V1 attempt
was admitted for, and rewriting those values into the V2 columns would be a
guess about which of their two meanings applied (ADR-0034).

### If it aborts

The failure looks like:

```
ERROR:  Cannot apply the output-resolution constraint: N video_projects row(s)
        hold a value outside (720p, 1080p). ...
```

This is **intended behaviour, not a broken migration.** A project row is a
customer's stated request, and `scene_generations` rows are already hashed
against it, so rewriting `4k` to `1080p` would change what somebody asked for
underneath an identity computed from it. Nothing is applied — the transaction
rolls back, including the `scene_generations` columns.

Resolve it by deciding, per row, what each project should actually be, with the
customer's intent in hand:

```sql
SELECT id, "organizationId", "propertyId", resolution FROM video_projects
WHERE resolution NOT IN ('720p', '1080p');
```

An attempt already admitted against such a project keeps its own frozen
`requestResolution` regardless of what the project is corrected to — that is
what the immutable snapshot is for (ADR-0018).

### Rollback

```sql
ALTER TABLE "scene_generations"
  DROP CONSTRAINT "scene_generations_request_identity_version_check",
  DROP CONSTRAINT "scene_generations_native_resolution_nonblank_check",
  DROP CONSTRAINT "scene_generations_model_key_nonblank_check",
  DROP CONSTRAINT "scene_generations_resolution_normalization_check",
  DROP CONSTRAINT "scene_generations_target_output_resolution_check",
  DROP COLUMN "requestNativeMeetsTarget",
  DROP COLUMN "requestResolutionNormalization",
  DROP COLUMN "requestNativeGenerationResolution",
  DROP COLUMN "requestTargetOutputResolution",
  DROP COLUMN "requestModelKey";
ALTER TABLE "video_projects" DROP CONSTRAINT "video_projects_resolution_target_check";
```

This discards every V2 delivery snapshot, leaving those attempts with a
`sha256:v2:` hash and no facts to reproduce it — permanently unreconstructable.
It is only safe while no V2 attempt matters, and the application code would have
to be rolled back with it.

### Verification performed on this branch

- `prisma migrate deploy` from an empty database: all nine migrations applied.
- `prisma migrate diff --exit-code` against the resulting database:
  **`No difference detected.`**
- Applied to a database built from the eight pre-3B-2B migrations holding a
  legacy project (`resolution = '1080p'`) and a V1 generation
  (`requestHash = 'sha256:legacyhash'`, `requestResolution = '1080p'`): both
  rows unchanged, all five V2 columns null.
- Applied to the same database with the project's `resolution` set to `'4k'`:
  **aborted with the explicit message, and no column was added.**
- Each constraint exercised directly against a migrated database: an
  off-vocabulary project target, a V2 hash with no snapshot, a V2 hash with a
  partial snapshot, a row carrying both vocabularies, a V1 hash carrying a V2
  snapshot, an off-vocabulary normalization, an off-vocabulary snapshot target,
  and blank/empty model keys and native tokens were all rejected by their named
  constraints; a well-formed V2 row (`768P`/`UPSCALE`/`false`) and a legacy V1
  row were both accepted.
- `tests/schema/resolution-identity-v2-migration.test.ts` parses the migration
  and asserts both the shape and the absence of every data-modifying statement.

## Phase 4C-3B-2H-1 — `00000000000011_phase4c3b2h1_managed_output_integrity`

Additive only: three nullable columns and three CHECK constraints on
`scene_generations`. No `UPDATE`, `INSERT`, `DELETE`, `TRUNCATE`, `DROP`,
`RENAME` or index. Safe against a populated database — adding a nullable column
takes no table rewrite in PostgreSQL — and it cannot refuse to run.

### Why it is required

`outputStorageKey` already existed, but a key alone proves nothing. It says where
the platform *believes* a copy of a generated video lives; it does not say the
copy is complete, that it is the object the provider produced, or when anyone
checked. An attempt could reach `OUTPUT_VERIFIED` with a key pointing at a
half-written object and nothing in the row would contradict it.

### What it does

1. Adds `outputSha256 TEXT`, `outputSizeBytes BIGINT` and
   `outputVerifiedAt TIMESTAMP(3)`, all nullable.
2. `scene_generations_verified_output_metadata_check` — any row whose
   `orchestrationState` is `OUTPUT_VERIFIED` must carry all four integrity facts
   (`outputStorageKey`, `outputSha256`, `outputSizeBytes`, `outputVerifiedAt`).
3. `scene_generations_output_sha256_format_check` — `NULL` or canonical
   lowercase 64-character hex.
4. `scene_generations_output_size_positive_check` — `NULL`, or strictly positive
   **and** no greater than 9007199254740991. Zero is refused explicitly: a
   zero-byte object is not a small video, it is a failed copy that happened to
   create the destination.

`BIGINT` rather than `INTEGER` because the domain admits any positive safe
integer, and `int4` would silently overflow at roughly 2 GiB on a value the
application validator had just accepted. The upper bound is
`Number.MAX_SAFE_INTEGER`, so the column's range and the application's range are
the **same** range. What `BIGINT` alone got wrong was the other end: past 2^53-1,
reading the column into a JavaScript number is silently lossy — a stored
9007199254740993 comes back as ...992 and validates cleanly — so a value that was
never written would be compared against an integrity receipt as though it had
been. The repository refuses to narrow an out-of-range value regardless, because
a constraint added by a migration is not evidence about a database that migration
has not been applied to.

### The legacy exception, stated exactly

Every constraint keys on `orchestrationState`, which is NULL on every row
admitted before Phase 4C-3B-2E, and `IS DISTINCT FROM` is null-safe — so those
rows satisfy the verified-metadata constraint unconditionally and **no exception
logic exists**. Nothing is backfilled. A legacy `state = 'SUCCEEDED'` row is not
reinterpreted as an orchestrated `PROVIDER_SUCCEEDED`: inventing a digest, a
size, a verification instant or an orchestration state for it would forge an
integrity record nobody produced.

### Rollback

```sql
ALTER TABLE "scene_generations"
  DROP CONSTRAINT "scene_generations_verified_output_metadata_check",
  DROP CONSTRAINT "scene_generations_output_sha256_format_check",
  DROP CONSTRAINT "scene_generations_output_size_positive_check",
  DROP COLUMN "outputVerifiedAt",
  DROP COLUMN "outputSizeBytes",
  DROP COLUMN "outputSha256";
```

This discards every managed-output integrity record, leaving verified rows with a
storage key and no proof of what it points at. Safe only while no attempt has
reached `OUTPUT_VERIFIED` under the orchestration vocabulary, and the application
code must be rolled back with it.

### Verification performed on this branch

- `prisma migrate deploy` from an empty database: all eleven migrations applied.
- `prisma migrate diff` schema → database and migrations → schema: both
  **`No difference detected.`**
- Applied to a database built from the ten prior migrations holding a legacy
  generation row (`state = 'SUCCEEDED'`, `orchestrationState` NULL,
  `outputStorageKey` populated): the row survived unchanged and all three new
  columns are NULL.
- Each constraint exercised directly against a migrated database, by raw writes
  that bypass the service: clearing any one of the four facts on an
  `OUTPUT_VERIFIED` row, an uppercase digest, a zero size, a negative size and a
  size of `Number.MAX_SAFE_INTEGER + 1` were all rejected; a size of exactly
  `Number.MAX_SAFE_INTEGER`, a size of 1, a complete verified row and a legacy row
  were all accepted. Non-hex and wrong-length digests are refused earlier, by the
  domain validator, and are covered there rather than at the constraint.

### What these constraints do and do not establish

They establish **completeness** (an `OUTPUT_VERIFIED` row carries all four
integrity facts), **format** (a canonical lowercase digest) and **range** (a byte
count inside the domain's own bounds).

They do **not** establish immutability, and the documentation must not claim they
do. A CHECK evaluates one row against one predicate; it has no memory of what the
row said before, so it cannot distinguish a first write from a second. A verified
row whose `outputStorageKey` is replaced with a different key still satisfies
every constraint here while pointing at an object whose bytes nobody hashed.

Immutability of verified output is an **application** property: the Phase 2H
compare-and-set writes the four facts only on
`OUTPUT_INGESTING → OUTPUT_VERIFIED` (which a verified row can no longer match),
the finalize decision answers a re-presented receipt with a replay or a conflict
rather than a second write, and the legacy tenant-facing
`SceneGenerationRepository.update` may write `outputStorageKey` only on rows with
`orchestrationState IS NULL`. No trigger was added: the mutation path was
closeable in the application, where the rule stays visible to the people who
maintain it.

## Phase 4C-3B-2H-3B-6A — Atomic validated Scene delivery

**No migration.** This phase adds none, and
`00000000000012_phase4c3b2h3b5_media_validation_lifecycle` remains the newest
migration in `packages/database/prisma/migrations`.

Transaction F writes only columns that already existed:

| Column | Added by |
| --- | --- |
| `scene_generation_requests.deliveredAt` | migration 10 |
| `scene_generation_requests.state`, `.stateVersion` | migration 10 |
| `generation_scenes.currentDeliveredRequestId` | migration 10 |
| `generation_scenes.state`, `.stateVersion` | migration 10 |
| `generation_jobs.state`, `.stateVersion` | migration 10 |

Two constraints already in place do real work here and were deliberately not
duplicated in application code:

- the composite foreign key
  `generation_scenes(currentDeliveredRequestId, id) -> scene_generation_requests(id, generationSceneId)`,
  which makes a delivered pointer to *another* Scene's request unstorable; and
- `scene_generation_requests_delivered_ordinal_key`, which lets a regeneration
  ordinal be spent only once.

A static test pins migration 12 as the newest and asserts no migration named for
this phase exists, so an unreviewed migration trips it.

**Backfill:** none. No existing row is read differently than before, and no
historical row changes meaning.

## Phase 5A — Durable deliverable composition plan

**Migration `00000000000014_phase5a_deliverable_composition_plan`.** Two tables,
no enums, and the foreign key that finally binds a column added four migrations
ago.

### New tables

| Table | Purpose |
| --- | --- |
| `generation_deliverable_versions` | one planned customer deliverable: job-scoped `ordinal`, `inputFingerprint` |
| `generation_deliverable_inputs` | one immutable row per scene frozen into that version |

### Constraints that do real work

| Name | Rule |
| --- | --- |
| `generation_deliverable_versions_generationJobId_ordinal_key` | a job has one version per ordinal |
| `generation_deliverable_versions_id_generationJobId_key` | the composite key the job pointer references |
| `generation_deliverable_version_ordinal_check` | `ordinal >= 1` |
| `generation_deliverable_inputs_deliverableVersionId_position_key` | one input per position |
| `generation_deliverable_inputs_deliverableVersionId_generati_key` | one input per scene |
| `generation_deliverable_input_position_check` | `position >= 0`, matching `generation_scenes_position_check` |
| `generation_deliverable_input_receipt_check` | canonical lowercase hex digest, positive size bounded at `Number.MAX_SAFE_INTEGER` |

All six foreign keys are `ON DELETE RESTRICT`. The rows referenced are paid
generated history, so a physical deletion must resolve retention policy
deliberately rather than cascading it away.

### The job pointer foreign key

```sql
ALTER TABLE "generation_jobs"
  ADD CONSTRAINT "generation_jobs_currentDeliverableVersionId_id_fkey"
  FOREIGN KEY ("currentDeliverableVersionId", "id")
  REFERENCES "generation_deliverable_versions"("id", "generationJobId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
```

Composite, not single-column, and that is the whole ownership guarantee: a
single-column key would have accepted another job's version, and one customer's
video could have been composed of another's. The same pattern
`generation_scenes(currentDeliveredRequestId, id)` already uses.

This is the **only** statement in the migration touching `generation_jobs`. No
column is added, dropped, altered or rewritten.

### Backfill: none, and none was needed

Verified before the migration was written, because adding this key to a column
carrying orphan values would fail the migration:

- the column arrived in migration 10 as a plain nullable `TEXT`, no default, no
  foreign key;
- **no migration in 0–13 writes a value into it.** The only `UPDATE` tokens in
  the whole migration history are `ON UPDATE CASCADE` foreign-key clauses;
- **no seed script exists**: `packages/database/prisma/` holds only
  `migrations/` and `schema.prisma`, and no package declares a `seed` entry;
- no repository method writes it.

The only non-null values anywhere were written by two integration fixtures, after
schema setup, into a disposable database. Those fixtures now create a real
`GenerationDeliverableVersion` row. **No production-compatible row could carry a
non-null pointer, so nothing was nulled and nothing was synthesized.**

The migration contains no `INSERT`, no `UPDATE "`, no `DELETE FROM` and no
`SELECT`, and a static test in the Phase 5A dormancy suite asserts each of those
along with the single-statement rule above.

## Phase 5C — Deliverable validation

**Migration `00000000000016_phase5c_deliverable_validation`.** One table, one
enum, and two enums *reused* rather than copied.

### New table

| Table | Purpose |
| --- | --- |
| `generation_deliverable_validations` | one durable verdict about one deliverable version's composed object |

Unique on `deliverableVersionId`, foreign key `RESTRICT` to
`generation_deliverable_versions`. The uniqueness is what makes two workers
racing to create the first record resolvable: exactly one insert wins, and the
loser re-reads a row it must not reopen. `RESTRICT` rather than `CASCADE` because
this row records the verdict that authorized publishing a customer's video and
spending an entitlement unit; a physical deletion must resolve retention
deliberately.

### New enum

`DeliverableValidationStatus` — `PENDING`, `RUNNING`, `VALID`, `INVALID_MEDIA`,
`INTEGRITY_MISMATCH`. `RETRYABLE_FAILURE` is deliberately absent: it is not a
verdict about the video but the absence of one, and it returns the row to
`PENDING` with a future instant.

### Enums reused, not copied

`ManagedOutputMediaInvalidReason` and `ManagedOutputContainerFamily` already
exist, from migration 12. "Is this file playable video" is the same question for a
provider attempt's output and for a composed deliverable, and a second
five-member copy would drift from the first the moment either is extended. The
migration creates **one** type and asserts so in the Phase 5C dormancy suite.

### Constraints that do real work

| Name | Rule |
| --- | --- |
| `generation_deliverable_validations_deliverableVersionId_key` | one verdict per deliverable version |
| `deliverable_validation_counters_check` | `attemptCount` and `version` are never negative |
| `deliverable_validation_receipt_check` | the frozen binding is canonical lowercase 64-hex and a positive byte count inside `Number.MAX_SAFE_INTEGER` |
| `deliverable_validation_facts_check` | duration, both dimensions and the video-stream count are positive; the audio count may be zero; all are inside the safe-integer range |
| `deliverable_validation_status_shape_check` | each status admits exactly one arrangement of the lease, retry and verdict columns |

The shape constraint is the one that matters. Without it a row can claim to be
`VALID` while still holding a lease, or `PENDING` with no instant at which it
becomes due, or `INVALID_MEDIA` carrying media facts describing a video it just
called unusable, or `VALID` with four of the five facts — states TypeScript can
refuse and a direct `UPDATE` cannot.

Two details inside it are deliberate. The five facts are **all-or-none** in the
`VALID` arm, because a container with no duration is not a description of
anything and a partially written fact set is what a later reader would average
over. And `invalidReason` exists in the `INVALID_MEDIA` arm and nowhere else: an
`INTEGRITY_MISMATCH` is not a statement about media at all — the object is not the
bytes that were published — so carrying a media reason there would assert
something nobody measured.

### No publication column

There is no `publishedAt`, no `consumedAt` and no `isCurrent` on this table. A
deliverable is published when the job says `DELIVERABLE_READY`, the job's pointer
names the version, and the hold is `CONSUMED`; Transaction G writes those three
in one commit. A fourth copy of the same fact would be a fourth thing to
disagree, and the dormancy suite asserts the columns are absent.

### Backfill: none, and none was needed

Nothing in the migration reads, updates or rewrites an existing row. Deliverable
versions composed by Phase 5B carry no validation row until a worker claims one,
and an absent row is an eligible state rather than a gap — the same discipline
migration 12 chose for attempt-level validations.

Statically asserted in the Phase 5C dormancy suite: exactly one `CREATE TABLE`,
exactly one `CREATE TYPE`, no statement beginning `UPDATE`, `DELETE`, `TRUNCATE`,
`DROP` or `ALTER COLUMN`, and every `ALTER TABLE` naming this phase's own new
table.

### Migrations 0–15

Untouched, byte for byte. `prisma migrate diff --from-migrations … --to-schema-datamodel`
reports no difference, and `prisma migrate status` reports the database up to
date after `migrate deploy` applies 16 on top of an existing 15.

## Phase 6A — Unit entitlement ledger

**Migration `00000000000017_phase6a_unit_entitlement_ledger`.** Three tables,
three enums, and two columns on `generation_reservations`. ADR-0055.

### New tables

| Table | Purpose |
| --- | --- |
| `unit_entitlement_periods` | one organization's Unit entitlement for one renewal period, plan snapshot frozen on it |
| `unit_add_on_blocks` | one purchased, quality-locked package of additional Units, bound to one period |
| `generation_reservation_allocations` | one frozen slice of a reservation's funding: Base, or one named block |

None has a foreign key to `organizations`, matching `generation_transition_events`:
commercial history must not be deletable through an organization row. Every
foreign key is `RESTRICT`.

### New enums

`EntitlementPlanKey` (`STANDARD`, `PREMIUM`, `ENTERPRISE`),
`UnitEntitlementSourceType` (`BASE`, `ADD_ON_BLOCK`) and
`GenerationReservationFunding` (`UNALLOCATED_LEGACY`, `ALLOCATED`).
`GenerationQualityTier` is **reused** for block and allocation quality.

### Changed table: `generation_reservations`

| Column | Rule |
| --- | --- |
| `funding` | `NOT NULL`, **no default**. Existing rows take `UNALLOCATED_LEGACY` in the statement that adds the column; the default is then dropped, so no new row can become legacy by omission |
| `entitlementPeriodId` | nullable; `NULL` exactly for legacy rows, by `generation_reservations_funding_period_check` |

Composite foreign key `(entitlementPeriodId, billingCycleKey)` →
`unit_entitlement_periods (id, billingCycleKey)`: a ledger-funded reservation's
cycle is its period's. Legacy rows, with a `NULL` period, are unaffected.

**No backfill of funding.** No existing row is read, updated or deleted, and no
allocation is inserted for history: a source that was never recorded is not
reconstructed.

### Constraints that do real work

| Name | Rule |
| --- | --- |
| `unit_entitlement_periods_organizationId_billingCycleKey_key` | one period per organization and cycle key |
| `unit_entitlement_periods_shape_check` | non-negative Base Units; HQ ceiling inside them; `endsAt > startsAt`; non-empty keys |
| `unit_add_on_blocks_organizationId_commercialReference_key` | a purchase is credited once per organization |
| `unit_add_on_blocks_shape_check` | positive quantity, non-empty purchase reference |
| `generation_reservation_allocations_shape_check` | positive quantity, 1-based ordinal, block id exactly on add-on allocations |
| `generation_reservation_allocations_one_base_key` | **partial** unique index: at most one Base row per reservation |
| `generation_reservation_allocations_reservationId_ordinal_key` | one row per draw position |
| `…_addOnBlockId_entitlemen_fkey` | a block allocation names a block of the same period and the same quality |
| `…_entitlementPeriodId_org_fkey` | an allocation stays in its period's organization |
| `…_reservationId_entitleme_fkey` | an allocation names its own reservation's period |

Prisma cannot express the partial index, so it lives in the migration SQL; the
committed schema still diffs clean against the migrations (`prisma migrate diff
--exit-code`). Period overlap per organization is refused by `openPeriod` under an
organization-scoped advisory lock rather than by an exclusion constraint, which
would need the `btree_gist` extension.

### Rollback

Forward-only, like every migration here. Reverting the application leaves the
new tables unused and `funding` set on every row; nothing older reads them.

## Phase 6B — the organization subscription

**Migration `00000000000018_phase6b_organization_subscriptions`.** One table and
one enum. ADR-0056.

### New table

| Table | Purpose |
| --- | --- |
| `organization_subscriptions` | one organization's plan, sales channel, renewal anchor and commercial reference |

### New enum

`SubscriptionChannel` (`SELF_SERVICE`, `SALES_ASSISTED`). `EntitlementPlanKey`
(migration 17) is **reused** for the plan.

### Constraints that do real work

| Name | Rule |
| --- | --- |
| `organization_subscriptions_organizationId_key` | one subscription per organization; orders two concurrent first provisions |
| `organization_subscriptions_shape_check` | non-empty commercial reference; `ENTERPRISE` only on `SALES_ASSISTED` |
| `organization_subscriptions_organizationId_fkey` | `RESTRICT`: an organization cannot be deleted from under its commercial record |

Unlike the Phase 6A ledger tables, this one has a foreign key to
`organizations`: a subscription for an organization that does not exist is a
defect, and `RESTRICT` still keeps commercial history from being deleted through
the organization row.

**No backfill.** No existing organization is given a subscription; provisioning
is an explicit input. No existing table, column or row is read, updated or
deleted.

### Rollback

Forward-only. Reverting the application leaves the table unused; nothing older
reads it.


## Phase 6C — the role templates

**Migration `00000000000019_phase6c_role_templates`.** One enum recreated, no
table created. ADR-0057.

### Changed enum

`Role`: `OWNER`, `ADMIN`, `MANAGER`, `CREATOR`, `VIEWER`, `BILLING` (was `OWNER`,
`ADMIN`, `CREATOR`, `REVIEWER`). PostgreSQL cannot drop an enum value, so the
migration creates `Role_new`, converts `memberships.role` and `invitations.role`
to it, drops the old type and renames the new one, in one transaction.

### Data rewritten

| Table | Rule |
| --- | --- |
| `memberships` | `REVIEWER` → `VIEWER`; every other value keeps its name |
| `invitations` | `REVIEWER` → `VIEWER`; every other value keeps its name |

`VIEWER` is the least-privileged template (ADR-0057 Decision 3). A value the
mapping does not know fails the cast and aborts the migration rather than being
guessed. No other table, column or row is touched.

**Rehearsed** on a scratch database migrated through migration 18 and seeded with
one membership of each old role and a `REVIEWER` and a `CREATOR` invitation:
after migration 19 the `REVIEWER` membership and invitation read `VIEWER`, every
other row kept its role, and the type's values were the six templates in order.

### Rollback

Forward-only. Reverting the application after this migration leaves `MANAGER`,
`VIEWER` and `BILLING` values that the old code does not know, and `REVIEWER` is
gone; a rollback would need its own migration mapping them back.

## Phase 6D — individual permission grants

**Migration `00000000000020_phase6d_permission_grants`.** One table created.
ADR-0058.

### New table

`member_permission_grants`: `organizationId`, `userId`, `permission`,
`grantedByUserId`, `grantedAt`.

| Constraint | Rule |
| --- | --- |
| Primary key | (`organizationId`, `userId`, `permission`): a member holds a permission by grant at most once |
| Foreign key | (`organizationId`, `userId`) → `memberships`, `ON DELETE CASCADE`: removing a member removes their grants |
| `member_permission_grants_permission_check` | `permission` is one of the 26 grantable permissions; never `video.share` |

`grantedByUserId` has no foreign key: it is attribution, like
`invitations.invitedByUserId`. A revocation deletes the row; the audit log keeps
the history.

Additive only. No existing table, column or row is read, updated or deleted.

### Rollback

Forward-only. Reverting the application leaves the table unused, and every
member's permissions fall back to the role template; nothing older reads it.

## Phase 6E — membership changes made atomic

**Not applicable: no migration.** No table, column, constraint or index changed
(ADR-0059). The new transactions and the `FOR UPDATE` lock on `memberships` are
application code. Reverting the application restores the earlier, non-atomic
writes against the same schema.

## Phase 6F — groups and group membership

**Migration `00000000000021_phase6f_groups`.** Two tables created. ADR-0060.

### New tables

`groups`: `id`, `organizationId`, `name`, `createdByUserId`, `createdAt`,
`updatedAt`.

`group_members`: `groupId`, `organizationId`, `userId`, `addedByUserId`,
`addedAt`.

| Constraint | Rule |
| --- | --- |
| `groups` primary key | `id` |
| `groups_organizationId_name_key` | a name is unique within its organization |
| `groups_id_organizationId_key` | (`id`, `organizationId`) is unique: the target of the member row's group key |
| `groups_name_check` | the name is trimmed and 1 to 100 characters |
| `groups` foreign key | `organizationId` → `organizations`, `ON DELETE CASCADE` |
| `group_members` primary key | (`groupId`, `userId`): a member is in a group at most once |
| `group_members` group key | (`groupId`, `organizationId`) → `groups`(`id`, `organizationId`), `ON DELETE CASCADE` |
| `group_members` membership key | (`organizationId`, `userId`) → `memberships`, `ON DELETE CASCADE`: removing a member from the organization removes it from every group |
| Index | (`organizationId`, `userId`) on `group_members` |

`createdByUserId` and `addedByUserId` have no foreign key: they are attribution,
like `member_permission_grants.grantedByUserId`.

Additive only. No existing table, column or row is read, updated or deleted.

### Rollback

Forward-only. Reverting the application leaves both tables unused. Nothing older
reads them, and no permission or row access depends on them.

## Phase 6G — group permissions

**Migration `00000000000022_phase6g_group_permissions`.** One table created.
ADR-0061.

### New table

`group_permissions`: `groupId`, `organizationId`, `permission`,
`grantedByUserId`, `grantedAt`.

| Constraint | Rule |
| --- | --- |
| Primary key | (`groupId`, `permission`): a group carries a permission at most once |
| Foreign key | (`groupId`, `organizationId`) → `groups`(`id`, `organizationId`), `ON DELETE CASCADE`: a row stays in its group's organization, and deleting the group removes it |
| `group_permissions_permission_check` | `permission` is one of the 25 permissions a group may carry: the grantable vocabulary less `disclosure.none`; never `video.share` |

`grantedByUserId` has no foreign key: it is attribution, like
`member_permission_grants.grantedByUserId`. A revocation deletes the row; the
audit log keeps the history. A member's group permissions are read through the
existing `group_members` (`organizationId`, `userId`) index and this table's
primary key, so no new index is needed.

Additive only. No existing table, column or row is read, updated or deleted.

### Rollback

Forward-only. Reverting the application leaves the table unused, and every
member's permissions fall back to its template and individual grants; nothing
older reads it.

## Phase 6H — Property assignment

**Migration `00000000000023_phase6h_property_assignment`.** Two columns added to
`properties`. ADR-0062.

### New columns

| Column | Rule |
| --- | --- |
| `responsibleUserId` `TEXT NULL` | foreign key (`organizationId`, `responsibleUserId`) → `memberships`(`organizationId`, `userId`), `ON DELETE NO ACTION`: the responsible user is always a member of the Property's organization |
| `groupId` `TEXT NULL` | foreign key (`groupId`, `organizationId`) → `groups`(`id`, `organizationId`), `ON DELETE NO ACTION`: the group always belongs to the Property's organization |

Two indexes, `properties_organizationId_responsibleUserId_idx` and
`properties_groupId_idx`, serve a member's removal and a group's deletion, which
release the Properties that refer to them.

`NO ACTION` means the database refuses to delete a membership or group a
Property still refers to. A member's removal and a group's deletion clear the
assignments themselves, in the same transaction, and count them in their audit
entries. Anything else that deletes memberships must do the same, including the
cascade from deleting a user or an organization (neither is built).

Additive only. No existing row is updated: every existing Property starts with
no responsible user and no group, which ADR-0052 allows for the `OWNER`s who
created them. No table, column or constraint of migrations 0 through 22 is
changed.

### Rollback

Forward-only. Reverting the application leaves both columns `NULL` on every new
Property and unread; a member's removal or a group's deletion by the older code
would be refused only for a Property that still names it, which only this code
can write.

## Near-duplicate rule removal

**Migration `00000000000024_near_duplicate_rule_removal`.** One statement.
ADR-0063, implementing ADR-0052 Decision 14.

```sql
DROP INDEX "asset_analyses_org_dupgroup_approved_key";
```

It drops migration 3's hand-written partial unique index, which allowed at most
one `APPROVED` analysis per (`organizationId`, `duplicateGroup`). Look-alike
photos are now approved independently.

Kept: `asset_analyses.duplicateGroup` and its non-unique index
`asset_analyses_organizationId_duplicateGroup_idx`, and the perceptual hash on
`media_assets`, all internal only.

No row is updated or deleted, and no table, column or constraint of migrations
0 through 23 is otherwise changed. The migration 4 caveat about `prisma migrate
dev` generating a stray `DROP INDEX` for this index no longer applies: the index
is gone. The CI drift check is unaffected, since Prisma never saw the index.

### Rollback

Forward-only. Once two look-alikes are both approved, recreating the index
fails. Reverting the application without recreating it is not supported either:
the older storyboard selection refuses a project holding two approved
look-alikes.

## Phase 6I-1 — Property reach

No migration. `PropertyRepository.listReachable` filters `properties` by
`groupId IN (…)` for a `MANAGER` and by `responsibleUserId` for a `CREATOR`
or `VIEWER`, beside the organization and not-deleted conditions. Migration
23's indexes, (`organizationId`, `responsibleUserId`) and (`groupId`), serve
both (ADR-0064).

## Phase 6I-2 — Property reach on analyses, video projects and storyboards

No migration. Reach on an analysis or a video project reads the Property it
belongs to by its id and organization, one lookup per check, plus the member's
groups for a `MANAGER`. No query or index changes.

## MFA-1 — authenticator-app MFA and recovery codes

**Migration `00000000000025_mfa_foundation`.** Two tables and three `sessions`
columns. ADR-0065, implementing ADR-0052 Decision 18.

### New tables

| Table | Rule |
| --- | --- |
| `user_mfa_factors` | primary key `userId`, foreign key → `users` `ON DELETE CASCADE`. `secret` is the sealed TOTP secret (`<key id>.<AES-256-GCM payload>`), `lastUsedStep` the step of the last code accepted |
| `user_mfa_recovery_codes` | primary key (`userId`, `codeHash`), foreign key `userId` → `user_mfa_factors` `ON DELETE CASCADE`; `CHECK ("codeHash" ~ '^[0-9a-f]{64}$')` |

### New `sessions` columns

| Column | Rule |
| --- | --- |
| `mfaVerifiedAt` `TIMESTAMP(3) NULL` | when the sign-in passed MFA |
| `mfaFailedAttempts` `INTEGER NOT NULL DEFAULT 0` | `CHECK (>= 0)`; incremented by one `UPDATE … RETURNING` |
| `mfaPendingSecret` `TEXT NULL` | the sealed secret of a set-up started in the sign-in |

Additive only: existing sessions read as not having passed MFA, which nothing
reads before MFA-2. No row is updated or deleted.

Queries: every MFA read is by primary key (`userId`, or the session `id`), and
recovery codes are counted and deleted by their primary key's leading column.
No index is added.

Rollback: drop the two tables and the three columns. No data elsewhere refers
to them.

New server secret: `MFA_SECRET_KEY`, 64 hex characters, optional until MFA-2.
Keep it once set: a different key cannot open secrets sealed under the old one.

## MFA-2 — the security page and two-step sign-in

**No migration.** MFA-2 reads and writes the tables and columns of migration 25
and changes none of them. Sessions created before it read as not having passed
MFA; a user who has no factor is signed in by them exactly as before.

**Environment.** Set `MFA_SECRET_KEY` on the web app before anyone turns on
MFA. It stays optional in the schema, which the worker shares; without it the
web app fails closed (ADR-0065 Decision 14). The worker needs no key.

## MFA-3 — mandatory MFA

**No migration.** MFA-3 reads the tables of migration 25 and the existing
membership, grant and group tables, and changes none of them.

**What changes at deploy.** Every `OWNER`, `ADMIN`, `BILLING` and other holder
of `permission.manage` or `billing.manage` who has not set up MFA is asked to set
it up at their next request, including in sessions that were already signed in.
There is no grace period and no data migration: the rule is read from current
memberships on every request (ADR-0065 Decision 15).

**Environment.** `MFA_SECRET_KEY` must be set on the web app before deploying
MFA-3. Without it no one who must use MFA can sign in, every `OWNER` included,
and the readiness probe (`GET /api/health/ready`) reports `degraded` with its
`mfa` check failing (Decision 17).

## MFA-4 — an organization's requirement for all members

Migration 26, `00000000000026_organization_mfa_requirement`:

| Change | Meaning |
| --- | --- |
| `organizations.mfaRequired` `BOOLEAN NOT NULL DEFAULT false` | every member must use MFA, whatever their role (ADR-0065 Decision 18) |

Additive only. Every existing organization reads as not requiring it, which
changes nothing for anyone. No row is updated or deleted, no index is added,
and migrations 0 through 25 are not touched.

Queries: the requirement is read with the organization, by primary key, for
each of a user's memberships when working out whether they must use MFA. A
change is one transaction: a `FOR SHARE` lock on the actor's membership row
(its role compared with the one the request was authorized under), a
compare-and-set `UPDATE` of the one organization row, and its audit row.

**What changes at deploy.** Nothing, until an `OWNER` or `ADMIN` turns the
requirement on. From then on every member of that organization without MFA sets
it up at their next request. No new environment variable.

## UP-1 — plan provisioning and the Units page

**No migration.** UP-1 writes `organization_subscriptions` (migration 18) and
its audit entry, and reads the Unit ledger (migration 17). It changes no table,
column or index.

**What changes at deploy.** Nothing for any organization: none has a plan until
an operator runs `provision-subscription` for it. Every member then sees a
"Units and plan" link on the dashboard; the page says there is no plan yet
until one is provisioned.

**Operating it.** The operator command needs `DATABASE_URL` and nothing else, no
new environment variable. It writes one row and one audit entry per
organization, and running it again with the same contract writes nothing.

## UP-2 — the Unit purchase record (migration 27)

**Migration 27 (`00000000000027_unit_purchases`)** creates `unit_purchases`:
one row per approved purchase of an additional Unit package (ADR-0067).

| Constraint | Holds |
| --- | --- |
| `unit_purchases_addOnBlockId_key` | one block is bought once |
| `unit_purchases_organizationId_idempotencyKey_key` | one key buys once per organization |
| FK `(addOnBlockId, entitlementPeriodId, quality)` → `unit_add_on_blocks` | the block is of the purchase's own period and quality |
| FK `(entitlementPeriodId, organizationId)` → `unit_entitlement_periods` | the period is the purchase's organization's |
| FK `organizationId` → `organizations` | the organization exists |
| `unit_purchases_shape_check` | `priceYenExTax > 0`, a non-empty contract reference, a key of 1 to 200 characters |

Every foreign key is `RESTRICT`: billing evidence outlives casual deletion.
`approvedByUserId` has no foreign key, as no actor column does. The CHECK is in
the migration only; Prisma cannot express it.

**Additive only.** No existing table, column or row is read, updated or deleted.
Rolling back means dropping the empty table, which holds nothing until UP-3
lets a customer buy.

**What changes at deploy.** Nothing: no application writes the table yet. No new
environment variable.

## UP-3 — the Unit purchase screen

**No migration.** UP-3 writes `unit_purchases` (migration 27), its block in
`unit_add_on_blocks` and their audit entries through the UP-2 service, and opens
the current period in `unit_entitlement_periods` when a purchase needs it. It
changes no table, column or index.

**What changes at deploy.** A holder of `billing.manage` in an organization
with an invoice-paid Standard or Premium plan can buy additional Units; the
first purchase writes the first rows of `unit_purchases`. Rolling UP-3 back
leaves those rows and their Units in place, as the invoicing evidence they are.
No new environment variable.

**Behind a proxy.** The purchase route compares the `Origin` header with the
first `X-Forwarded-Host`, else `Host`. A proxy in front of the web app must pass
the host the browser addressed in one of them, or every purchase is refused
`403`.

## UP-4 — this period's purchases and the invoicing export

**No migration.** UP-4 reads `unit_purchases` with its block, period and
organization, and writes only `audit_logs` (`unit_purchase.exported`, one per
organization an export lists). It changes no table, column or index.

**What changes at deploy.** A holder of `billing.view` sees the period's
purchases on the Units page. The operator command `export-unit-purchases` is
available wherever `apps/ops` runs with `DATABASE_URL`; nothing runs it on a
schedule. No new environment variable.

**The export's read.** It selects purchases across organizations by approval
time. The existing index on `unit_purchases` leads with the organization, so the
read scans the table; an index on `approvedAt` can be added when purchases are
many (ADR-0069 Decision 7).

**The export's lock.** It reads under a `SHARE` lock on `unit_purchases`
(ADR-0069 Decision 6), which PostgreSQL grants only to a role with `UPDATE`,
`DELETE` or `TRUNCATE` on the table. Locally and in CI, the role `DATABASE_URL`
names owns it. A role without those privileges fails the command before
anything is read or audited.

## UP-5 — cancelling a mistaken Unit purchase

**Migration 28, `00000000000028_unit_purchase_cancellations`.** Additive only:

- creates the enum `UnitPurchaseCancellationFault` (`VTAVISION`,
  `CUSTOMER`);
- creates `unit_purchase_cancellations` (purchase, organization, whose
  mistake it was, operator, reason, when), its key the purchase id, with a
  composite foreign key to `unit_purchases` (`id`, `organizationId`),
  `ON DELETE RESTRICT`, and a CHECK on the operator's and the reason's lengths;
- adds the unique index `unit_purchases_id_organizationId_key`, which every
  existing row satisfies because `id` is already the primary key. Building it
  blocks writes to `unit_purchases` for as long as it takes, which is brief
  while purchases are few.

No existing table, column or row is updated or deleted. Rolling back means
dropping the table, the enum and the index, which loses every cancellation: a cancelled
purchase's block would fund reservations again and the export would invoice it.

**What changes at deploy.** The ledger reads each block's cancellation when it
computes a balance, so a cancelled purchase's block funds no new reservation
from the moment the cancellation commits. The operator command
`cancel-unit-purchase` is available wherever `apps/ops` runs with
`DATABASE_URL`; nothing runs it on a schedule. The export's CSV gains two
columns at the end, `cancelled_at` and `to_invoice_yen_ex_tax`: a spreadsheet
or script reading it by position is unaffected, and one reading the total
should read `to_invoice_yen_ex_tax`. No new environment variable.

## DS-1 — the AI disclosure layer v1

**No migration.** DS-1 adds constants to `@app/domain`, six images and a font
under `assets/disclosure/`, and a command run by hand. It reads and writes no
table.

**What changes at deploy.** Nothing anyone can notice: no composition, page or
worker reads the images yet. No new environment variable. The images ship with
the repository; nothing needs to be uploaded or installed.

## DS-2 — real FFmpeg in CI

**No migration.** DS-2 adds test suites, a test configuration and a CI job. It
reads and writes no table.

**What changes at deploy.** Nothing: no application code changes. FFmpeg is
installed only on the CI runner; the worker image is unchanged. No new
environment variable.

## DS-3 — the disclosure mode, frozen at admission

**Migration 29, `00000000000029_disclosure_mode_frozen`** (ADR-0073):

- creates the enum `DisclosureMode` with one value, `THROUGHOUT` (Mode A, the
  disclosure for the whole video);
- adds `disclosureMode` to `generation_jobs` and to
  `generation_deliverable_versions`, `NOT NULL`. Each is added with
  `DEFAULT 'THROUGHOUT'`, so every existing row becomes Mode A, and the default
  is dropped in the same migration, so every later writer must name the mode.

No table, index or constraint is created, and no row is updated or deleted
beyond the new columns' values. Adding a column with a constant default does
not rewrite either table on PostgreSQL 11 or later; the `ALTER TABLE`
statements take a brief exclusive lock each. Rolling back means dropping the two
columns and the enum: nothing reads them outside the two repositories that
write them. Roll the code back with them: code from before DS-3 names no mode,
so it cannot insert into either table while the columns exist, and it would
find every v2 plan's fingerprint wrong on a Transaction I replay.

**What changes at deploy.** Nothing anyone can notice. No route admits a
whole-video generation, and the pipeline after admission is dormant. Versions
planned before migration 29 keep their `sha256:deliverable-input:v1`
fingerprint, which is never rewritten; Transaction I's replay of such a plan now
fails closed with `PARTIAL_PLAN_STATE`, while composition, which does not read
the fingerprint, is unaffected (ADR-0073 Decision 4). Only development databases
can hold one. No new environment variable.

## DS-4 — the Clean Master record

**Migration 30, `00000000000030_clean_master_record`** (ADR-0074):

- creates `generation_deliverable_clean_masters`: `id`, `deliverableVersionId`
  (unique, foreign key to `generation_deliverable_versions`, `ON DELETE
  RESTRICT`), `storageKey`, `sha256`, `sizeBytes` (`BIGINT`), `verifiedAt` and
  `createdAt`, all `NOT NULL`, with no default but `createdAt`'s;
- adds `deliverable_clean_master_key_check`: the key is exactly
  `org/{organization}/internal/clean-masters/{deliverableVersionId}` for a
  non-blank organization segment and the row's own version;
- adds `deliverable_clean_master_receipt_check`: lowercase 64-character hex, and
  a size above zero and at most 2^53 − 1.

No existing table is altered and no row is written, updated or deleted; the new
table is empty, and nothing writes it until DS-5. Creating it takes no lock on
an existing table beyond the foreign key's brief `SHARE ROW EXCLUSIVE` on
`generation_deliverable_versions`. Rolling back means dropping the table:
nothing reads or writes it. Code from before DS-4 runs against the new schema
unchanged, except that it would sign an internal key if one were ever asked for.

**What changes at deploy.** Nothing anyone can notice. The two signed storage
routes now answer a token for an internal key with `401`, and nothing issues
one. No new environment variable.

## DS-5a — the Clean Master encode, and the disclosure laid over it

**No migration.** DS-5a adds two methods to the composer and moves the media
suites onto them. It reads and writes no table.

**What changes at deploy.** Nothing: nothing in production constructs the
composer, and the composition runner still calls only `compose`. No new
environment variable; the composer's new `disclosureLayerDirectory` setting is
a constructor argument, set by nothing yet.

## DS-5b-1 — storing the Clean Master, and checking it before the disclosure

**No migration.** DS-5b-1 adds the master's store and its inspector. It reads
and writes no table; the master's table (migration 30) is still written by
nothing.

**What changes at deploy.** Nothing: nothing in production constructs the store
or the inspector, and the composition runner still calls only `compose`. No new
environment variable.

## DS-5b-2a — composition's records for the Clean Master

**Migration 31, `00000000000031_clean_master_block_codes`** (ADR-0077): two
`ALTER TYPE "DeliverableCompositionBlockCode" ADD VALUE` statements, for
`CLEAN_MASTER_SIZE_LIMIT_EXCEEDED` and `CLEAN_MASTER_UNUSABLE`.

No table or column changes and no row is written, updated or deleted; no
composition row holds either value, because nothing records them yet. Adding
an enum value takes a brief lock on the type and rewrites nothing. PostgreSQL
cannot drop an enum value, so rolling back means leaving both values in place:
code from before DS-5b-2a never writes them, and no row holds them, so it runs
against the new schema unchanged.

- **PostgreSQL 12 or later.** Prisma runs each migration in a transaction, and
  `ALTER TYPE … ADD VALUE` inside a transaction block needs PostgreSQL 12
  (CI and local setup use 16). The new values cannot be used before the
  migration's transaction commits; the migration uses neither.
- **Leaving the values in place is safe only until DS-5b-2b ships.** From then
  the runner can block a row with either code, and code from before DS-5b-2a
  would read a block code it does not know. Rolling back past DS-5b-2b is a
  decision for that milestone's notes.
- **A true down-migration is possible while no row holds either value**:
  recreate the type without them, as migration 19 did for its enum (rename the
  type, create it again with the four original values, cast the
  `blockCode` column across, drop the old type). Check first that
  `SELECT count(*) FROM "generation_deliverable_compositions" WHERE "blockCode"::text
  LIKE 'CLEAN_MASTER_%'` is 0.

**What changes at deploy.** Nothing anyone can notice. Nothing in production
constructs the composition repository, so its new behaviour (the claim's mode
and master key, the master's record in Transaction J2, discovery skipping work
frozen under another profile or planned under a mode the build does not draw)
runs in tests only. No new environment variable.


## DS-5b-2b-1 — composition makes the Clean Master first

**No migration** (ADR-0078). Composition profile v2 keeps every column v1
froze at v1's value, including `crf` 18 for the customer's video, and nothing
in the database constrains `profileKey`. The master's record (migration 30) and
the two block codes (migration 31) are written by the runner from now on, once
anything runs it.

**Rolling back.** To DS-5b-2a's build: safe. That build refuses a row frozen
under v2 at claim and its discovery does not offer one, so such a row waits
rather than being encoded under v1; it knows both block codes; and the master
records and stored masters stay as they are. But a version not yet claimed
would be claimed under v1 and composed with no master and no disclosure, so
once composition is activated, no rollback goes back past this milestone. Past
DS-5b-2a: only while no row holds either new block code, with the same check
DS-5b-2a's notes give, because a build from before it does not know them, and
while no work row frozen under v2 is `PENDING` or `RUNNING`: a build from
before DS-5b-2a does not filter discovery by profile, so it would offer every
such row on every pass and its claim would refuse each one, crowding out work
it can do. Check that `SELECT count(*) FROM "generation_deliverable_compositions"
WHERE "profileKey" = 'vtavision-compose:v2' AND "status" IN ('PENDING', 'RUNNING')`
is 0.

**What changes at deploy.** Nothing anyone can notice: nothing in production
constructs the composition runner. No new environment variable.

## DS-5b-2b-2 — every video is made from a recorded master

**No migration** (ADR-0079). Transaction J2 now refuses a finalize naming no
Clean Master and records the master on every first commit; no schema, enum,
constraint or row changes.

**Rolling back.** To DS-5b-2b-1's build: safe. That build's runner passes a
master on every finalize and its J2 records it, so it writes what this build
writes; it only also accepts a finalize with none, which nothing makes.

**What changes at deploy.** Nothing anyone can notice: nothing in production
constructs the composition runner or calls J2. No new environment variable.

## DS-6a — publication requires the disclosure and the master

**No migration** (ADR-0080). Transaction G now refuses, as a defect, a version
whose composition's frozen profile did not draw its disclosure mode or that
has no Clean Master recorded at its canonical key; no schema, enum, constraint
or row changes.

**Before deploying to a database that holds development data**, find what the
gate will refuse: a version awaiting validation or publication that was
composed under v1, that has no master, or whose master is recorded under a key
that is not its own organization's. Validation discovery no longer offers any
of them, and the claim and Transaction G refuse each with a defect, so each
holds its job in `DELIVERABLE_VALIDATING` and its reservation `RESERVED` until
an operator acts (ADR-0080 Decision 4).

```sql
SELECT count(*)
  FROM "generation_deliverable_versions" v
  JOIN "generation_jobs" j ON j."id" = v."generationJobId"
  JOIN "video_projects" p ON p."id" = j."videoProjectId"
  JOIN "generation_deliverable_compositions" c ON c."deliverableVersionId" = v."id"
  LEFT JOIN "generation_deliverable_clean_masters" m ON m."deliverableVersionId" = v."id"
 WHERE j."state" = 'DELIVERABLE_VALIDATING'
   AND c."status" = 'OUTPUT_VERIFIED'
   AND (c."profileKey" <> 'vtavision-compose:v2'
        OR m."id" IS NULL
        OR m."storageKey" <> 'org/' || p."organizationId" || '/internal/clean-masters/' || v."id");
```

This build cannot make such a row: it composes only under v2, and Transaction
J2 records the master at that key in the receipt's commit. Production holds
none: nothing has ever composed there.

**Rolling back.** To DS-5b-2b-2's build: safe. That build publishes everything
this build publishes, and also the versions this build refuses, which this
build cannot make.

**What changes at deploy.** Nothing anyone can notice: nothing in production
constructs the validation runner or calls Transaction G. No new environment
variable.

## DS-6b — a deliverable must measure its planned size and length

**No migration** (ADR-0081). An off-plan video is recorded `INVALID_MEDIA` with
an existing reason (`VIDEO_DIMENSIONS_INVALID` or `DURATION_INVALID`), and
Transaction G refuses, as a defect, a `VALID` verdict whose stored facts are off
plan; no schema, enum, constraint or row changes.

**Before deploying to a database that holds development data**, find the
`VALID` verdicts awaiting publication that DS-6a's build wrote with off-plan
facts. Discovery no longer offers them and Transaction G refuses them, so each
holds its job in `DELIVERABLE_VALIDATING` and its reservation `RESERVED` until
an operator acts (ADR-0081 Decision 3).

```sql
SELECT count(*)
  FROM "generation_deliverable_validations" w
  JOIN "generation_deliverable_versions" v ON v."id" = w."deliverableVersionId"
  JOIN "generation_jobs" j ON j."id" = v."generationJobId"
  JOIN "generation_deliverable_compositions" c ON c."deliverableVersionId" = v."id"
 WHERE j."state" = 'DELIVERABLE_VALIDATING'
   AND w."status" = 'VALID'
   AND (w."videoWidth" <> c."targetWidthPx"
        OR w."videoHeight" <> c."targetHeightPx"
        OR abs(w."durationMs" - j."requestedDurationSeconds"::bigint * 1000)
           > (1000 * c."frameRateDenominator"::bigint + c."frameRateNumerator" - 1)
             / c."frameRateNumerator");
```

Only a validator returning facts the composer did not produce, such as a test
fake, or a row altered by hand, can have written one. Production holds none:
nothing has ever composed there.

**Rolling back.** To DS-6a's build: safe. That build publishes everything this
build publishes, and also off-plan videos, which the media suites show this
build's composer does not make. An `INVALID_MEDIA` verdict this build wrote for an off-plan video stays
terminal under that build too.

**What changes at deploy.** Nothing anyone can notice: nothing in production
constructs the validation runner or calls Transaction G. No new environment
variable.

## GS-1 — a failed deliverable settles its job in the same commit

**No migration** (ADR-0082). A composition `BLOCKED` and a terminal non-`VALID`
verdict now settle their job in their own commit: an initial generation becomes
`FAILED_TERMINAL` with its reservation `RELEASED`, and a replacement returns to
`DELIVERABLE_READY` with its pointer and its consumed reservation unchanged.
Every state and column already exists; no schema, enum, constraint or row
changes.

**Before deploying to a database that holds development data**, find the
terminal rows an earlier build wrote without settling. Discovery offers none of
them, and a replay of one now throws `SETTLEMENT_INCOMPLETE` rather than
settling it late (ADR-0082 Decision 5), so each keeps its job and, for an
initial generation, its reservation where they are until an operator acts.

```sql
SELECT j."id" AS "jobId", j."state"::text AS "jobState",
       res."state"::text AS "reservationState"
  FROM "generation_jobs" j
  JOIN "generation_deliverable_versions" v ON v."generationJobId" = j."id"
  LEFT JOIN "generation_reservations" res ON res."generationJobId" = j."id"
  LEFT JOIN "generation_deliverable_compositions" c ON c."deliverableVersionId" = v."id"
  LEFT JOIN "generation_deliverable_validations" w ON w."deliverableVersionId" = v."id"
 WHERE v."ordinal" = (SELECT MAX(sib."ordinal")
                        FROM "generation_deliverable_versions" sib
                       WHERE sib."generationJobId" = j."id")
   AND ((j."state" = 'COMPOSING' AND c."status" = 'BLOCKED')
     OR (j."state" = 'DELIVERABLE_VALIDATING'
         AND w."status" IN ('INVALID_MEDIA', 'INTEGRITY_MISMATCH')));
```

Production holds none: nothing has ever composed there.

**Rolling back.** To DS-6b's build: safe. That build settles nothing. A job this
build failed is `FAILED_TERMINAL`, which has no outgoing edge and which no
discovery offers; a replacement this build rolled back is `DELIVERABLE_READY`
with the customer's video, which that build handles as any delivered job.

**What changes at deploy.** Nothing anyone can notice: nothing in production
constructs the composition or validation runner. No new environment variable.

## GS-2a — a scene whose attempts ended without a video settles its job

**No migration** (ADR-0083). A new transaction, Transaction K, settles a scene
request whose attempts have all ended, the newest without a video: an initial
generation's request, scene and job become `FAILED_TERMINAL` and its reservation
`RELEASED` (unless reconciliation already released it); a scene regeneration's
request becomes `FAILED_TERMINAL` and its scene and job return to `READY` and
`DELIVERABLE_READY` with the customer's video. Every state and column already
exists; no schema, enum, constraint or row changes at deploy.

**Rows written before this build.** Unlike ADR-0082's settlement, this one is a
sweep over durable facts, so its first pass on a database that holds development
data settles every request already in that shape, with that pass's instant as
`failedAt` and `releasedAt`. Nothing runs the pass in production, and production
holds no such row: no attempt has ever been sent there.

**Rolling back.** To GS-1's build: safe. That build settles nothing. Every row
this build settled is `FAILED_TERMINAL`, which has no outgoing edge and which no
discovery offers, or a regeneration rolled back to `READY` and
`DELIVERABLE_READY` with the customer's video, which that build handles as any
delivered job.

**What changes at deploy.** Nothing anyone can notice: nothing in production
constructs the settlement's runner or repository. No new environment variable.

## GS-2b — a failed job's other scenes close

**No migration** (ADR-0084). A new transaction, Transaction L, closes an open
scene of a `FAILED_TERMINAL` job once nothing of it is at the provider: a scene
that never started becomes `CANCELLED` with its pending request; one that started,
or whose request was admitted, becomes `FAILED_TERMINAL`, its request
`FAILED_TERMINAL` (or `CANCELLED` if it was never admitted) and each of its
`QUEUED` attempts `CANCELLED_PRE_SUBMISSION` (its legacy `state` column
untouched).
The job and its reservation are not written. Every state, column and edge
already exists; no schema, enum, constraint or row changes at deploy.

**Rows written before this build.** A sweep over durable facts, as for GS-2a:
its first pass on a database that holds development data closes every open
scene of a job already failed, with that pass's instant as `failedAt`. Nothing
runs the pass in production, and production holds no such row: no attempt has
ever been sent there.

**Rolling back.** To GS-2a's build: safe. That build closes nothing. Every row
this build closed is `CANCELLED`, `FAILED_TERMINAL` or
`CANCELLED_PRE_SUBMISSION`, none of which has an outgoing edge or is offered by
any orchestration discovery.

**What changes at deploy.** Nothing anyone can notice: nothing in production
constructs the closure's runner or repository. No new environment variable.


## GS-3 — a shared folder holds development and CI objects

**No migration** (ADR-0085). No schema, enum, constraint or row changes.

**A new optional environment variable, `SHARED_STORAGE_DIR`**: an absolute
folder in which the web app keeps stored objects, to be shared with the worker.
The schema refuses a relative path, and refuses the variable altogether when
`NODE_ENV=production`. Unset, the web app keeps objects in its own memory, as
before.

**Objects stored before this build.** None move. Set for the first time, the
variable starts the web app on an empty folder; what the in-memory store held,
lost at every restart anyway, is not copied.

**Rolling back.** To GS-2b's build: safe. That build ignores the variable and
keeps objects in memory again; the folder stays on disk until deleted.

**What changes at deploy.** Nothing in production: the variable is refused
there, and unset it changes nothing.

## GS-4a — a storyboard is saved in one commit

**No migration** (ADR-0086). No schema, enum, constraint or row changes, and
no new environment variable.

**What changes at deploy.** Composing a storyboard now saves its scenes, its
`STORYBOARD_READY` status and its fingerprint in one transaction that first
locks the project row (`FOR NO KEY UPDATE`). Two compositions of one project
take turns instead of failing on the scene position index. Storyboards already
saved are not rewritten; one whose scenes and fingerprint came from different
compositions, if any exists, keeps reading as it does until it is composed
again.

**Rolling back.** To GS-3's build: safe. That build saves the scenes and the
project in two commits again; the rows have the same shape either way.

## GS-4b — the start key

**Migration 32, `00000000000032_generation_start_key`** (ADR-0087). Adds
`generation_jobs."idempotencyKey"` (`TEXT`, nullable), the unique index
`generation_jobs_videoProjectId_idempotencyKey_key` on `("videoProjectId",
"idempotencyKey")`, and the check `generation_jobs_idempotency_key_check`
(`NULL`, or 1 to 200 characters). No row is written: every existing job keeps a
`NULL` key, and PostgreSQL treats `NULL`s as distinct, so the index accepts them
all. No new environment variable.

**What changes at deploy.** Nothing a customer sees. The start commit that
writes the key is constructed by tests only; GS-4c's service and GS-10's route
will call it. Building the index scans `generation_jobs` once.

**Rolling back.** To GS-4a's build: safe with the column left in place, since
that build never reads or writes it. To remove it as well:

```sql
ALTER TABLE "generation_jobs" DROP CONSTRAINT "generation_jobs_idempotency_key_check";
DROP INDEX "generation_jobs_videoProjectId_idempotencyKey_key";
ALTER TABLE "generation_jobs" DROP COLUMN "idempotencyKey";
```

and delete migration 32's row from `_prisma_migrations`. Any key already written
is lost with the column, so a replay of that start would no longer find its job.

## GS-4c — the start service

**No migration** (ADR-0088). No schema, enum, constraint or row changes, and
no new environment variable.

**What changes at deploy.** Nothing a customer sees. The start service and the
replay read it adds to the start repository are constructed by tests only;
GS-10's route will construct them. The replay read uses migration 32's index on
`("videoProjectId", "idempotencyKey")`. The start commit, also unused in
production, now holds the project's Property row `FOR SHARE` with the
project's, so once GS-10 constructs it a Property deletion waits for a start
committing on one of its projects (one short transaction).

**Rolling back.** To GS-4b's build: safe, since nothing in production calls
what GS-4c adds.

## GS-5a-1 — the route table and price catalog are passed in

**No migration** (ADR-0089). No schema, enum, constraint or row changes, and
no new environment variable.

**What changes at deploy.** Nothing. Every caller that passes no route policy
or price catalog gets production's, which are the same tables as before, and
nothing outside tests passes another. The authorization record's
`routingPolicyVersion` is the version of the policy used, which for production
is the same `ROUTING_POLICY_VERSION` as before.

**Rolling back.** To GS-4c's build: safe, since nothing in production calls
what GS-5a-1 adds.

## GS-5a-2 — the test route is built only outside production

**No migration** (ADR-0090). No schema, enum, constraint or row changes, and
no new environment variable.

**What changes at deploy.** Nothing. The test route's factory refuses
production and nothing outside tests calls it. Where it is used, in
development and CI, attempt admission records its fixed exchange rate
(`fx_dev_fixed_usd_jpy_150`) in `fx_rate_snapshots` on first use, as it does
any rate.

**Rolling back.** To GS-5a-1's build: safe, since nothing in production calls
what GS-5a-2 adds.

## GS-5b — a billing cycle's revenue is read from its period

**No migration** (ADR-0091). No schema, enum, constraint or row changes, and
no new environment variable. The reader reads `unit_entitlement_periods`,
`unit_purchases` and `unit_purchase_cancellations` and writes nothing.

**What changes at deploy.** Nothing. Nothing outside tests constructs the
paid-submission service, so no production code calls the reader.

**Rolling back.** To GS-5a-2's build: safe, since nothing in production calls
what GS-5b adds.

## GS-6 — the test provider makes a real clip from the photo

**No migration** (ADR-0092). No schema, enum, constraint or row changes, and
no new environment variable. The studio keeps its clips in a folder it is
given, outside the database and outside the shared storage's objects.

**What changes at deploy.** Nothing. Nothing outside tests builds the studio
or the FFmpeg clip maker, and both refuse production.

**Rolling back.** To GS-5b's build: safe, since nothing in production calls
what GS-6 adds.

## GS-7a — the concurrent-job limit and the launch plan

**No migration** (ADR-0094). No schema, enum, constraint or row changes, and
no new environment variable. The limit is a field of the plan catalog, which is
code.

**What changes at deploy.** Nothing. Nothing outside tests builds the launch
planner, and the media-recovery planner prices exactly as before.

**Rolling back.** To GS-6's build: safe, since nothing in production calls
what GS-7a adds.

## GS-7b — the launch commit

**No migration** (ADR-0095). No schema, enum, constraint or row changes, and
no new environment variable. The launch lock is a transaction-scoped advisory
lock, which leaves nothing behind.

**What changes at deploy.** Nothing. Nothing outside tests builds the launch
runner or its repository, and no existing caller's behaviour changes:
`applyLockedTransition` is only exported within the package.

**Rolling back.** To GS-7a's build: safe, since nothing in production calls
what GS-7b adds.

## GS-7c-1 — the boundary an orchestrated attempt crosses

**No migration** (ADR-0096). No schema, enum, constraint or row changes, and
no new environment variable. The gate's audit entry uses the existing
`audit_logs` table; its source lock is a row lock, released at commit.

**What changes at deploy.** Nothing. Nothing outside tests constructs the
paid-submission gate or the legacy executor. The legacy executor's queries now
also require `orchestrationState IS NULL`, which every legacy row already has.

**Rolling back.** To GS-7b's build: safe, since nothing in production calls
either.

## GS-7c-2a — finding an attempt to send, and ending one refused for good

**No migration** (ADR-0097). No schema, enum, constraint or row changes, and
no new environment variable. The ending writes `CANCELLED_PRE_SUBMISSION`, a
state the schema already allows without a boundary instant, and an event in the
existing `generation_transition_events` table.

**What changes at deploy.** Nothing. Nothing outside tests constructs the
attempt submission repository.

**Rolling back.** To GS-7c-1's build: safe, since nothing in production calls
what GS-7c-2a adds.

## GS-7c-2b — sending an attempt once, and recording the answer

**No migration** (ADR-0098). No schema, enum, constraint or row changes, and
no new environment variable. A send writes through the gate's arm and the
submission outcome, which already exist; discovery's cursor is a query
predicate on `createdAt` and `id`, which the existing order already uses.

**What changes at deploy.** Nothing. Nothing outside tests constructs the
sender, the repository or the adapter.

**Rolling back.** To GS-7c-2a's build: safe, since nothing in production calls
what GS-7c-2b adds.

## GS-7d-1 — ending a waiting job that can never launch

**No migration** (ADR-0099). No schema, enum, constraint or row changes, and
no new environment variable. The ending writes the job's `RESERVED →
FAILED_TERMINAL` and the reservation's `RESERVED → RELEASED`, both states and
columns that already exist; its events go to the existing transition history,
with a new event type (`job.ended_unlaunchable`) in a free-text column.

**What changes at deploy.** Nothing. Nothing outside tests constructs the
ending repository or the launch runner.

**Rolling back.** To GS-7c-2b's build: safe, since nothing in production calls
what GS-7d-1 adds. A job a test ended stays ended; its Units stay released.

## GS-7d-2 — ending a generating job's attempt whose Property was deleted

**No migration** (ADR-0100). No schema, enum, constraint or row changes, and
no new environment variable. The ending writes the attempt's `QUEUED →
CANCELLED_PRE_SUBMISSION`, a state and columns that already exist, with
`PROPERTY_DELETED` in the free-text `normalizedErrorCode`; its event goes to
the existing transition history with a new event type
(`attempt.ended_property_deleted`) in a free-text column.

**What changes at deploy.** Nothing. Nothing outside tests constructs the
attempt submission repository or the sender.

**Rolling back.** To GS-7d-1's build: safe, since nothing in production calls
what GS-7d-2 adds. An attempt a test ended stays ended.

## Property rename and deletion as conditional writes (ADR-0101)

**No migration.** No schema, enum, constraint or row changes, and no new
environment variable. A rename now writes with one conditional `UPDATE …
RETURNING`, and a deletion with one conditional `updateMany`, each on the id,
the organization and a status other than `DELETED`, the columns they already
wrote.

**What changes at deploy.** Nothing a customer reaches: no route renames or
deletes a Property yet.

**Rolling back.** To GS-7d-2's build: safe, with the lost update ADR-0101 fixes
back in the code, unreachable from any route.

## GS-7d-3a — ending a deleted Property's launched job before its video is assembled

**No migration** (ADR-0102). No schema, enum, constraint or row changes, and
no new environment variable. The ending writes a job's move from
`GENERATING`, `SCENES_READY` or `COMPOSITION_PENDING` to `FAILED_TERMINAL` and
a reservation's `RESERVED → RELEASED`, states and columns that already exist.
Its events go to the existing transition history, the job's with a new event
type (`job.ended_property_deleted`) in a free-text column.

**What changes at deploy.** Nothing. Nothing outside tests constructs the
ending's repository or the launch runner.

**Rolling back.** To the build before it: safe, since nothing in production
calls what GS-7d-3a adds. A job a test ended stays ended, its Unit released.

## GS-7d-3b — Transaction G refuses a deleted Property's first video

**No migration** (ADR-0103). No schema, enum, constraint or row changes, and
no new environment variable. A refused publication writes a job's
`DELIVERABLE_VALIDATING → FAILED_TERMINAL` and a reservation's release, states
and columns that already exist, through the failure settlement of ADR-0082.
Its events go to the existing transition history, the job's with the type
ADR-0102's ending records (`job.ended_property_deleted`) and both with
`PROPERTY_DELETED` as their reason code, the code every deleted Property's
ending carries.

**What changes at deploy.** Nothing. Nothing outside tests constructs the
validation repository or its runner.

**Rolling back.** To GS-7d-3a's build: safe, since nothing in production calls
Transaction G. A job a test ended stays ended, its Unit released.

## GS-8 — planning a video's composition once its scenes are ready

**No migration** (ADR-0104). No schema, enum, constraint or row changes, and no
new environment variable. The candidate query reads existing tables and
writes nothing; Transaction I, which the runner calls, is unchanged.

**What changes at deploy.** Nothing. Nothing outside tests constructs the
runner, and nothing but the runner calls the plan repository.

**Rolling back.** To GS-7d-3b's build: safe. A job a test planned stays
`COMPOSITION_PENDING` with its version and inputs, as Transaction I always
left it.

## GS-9a — the launch window moves

**No migration** (ADR-0105). No schema, enum, constraint or row changes, and no
new environment variable. The launch candidate query reads existing columns,
`generation_jobs.createdAt` among them, and writes nothing.

**What changes at deploy.** Nothing. Nothing outside tests constructs the
launch runner or its repository.

**Rolling back.** To GS-8's build: safe. The cursor is never stored, so
nothing is left behind.

## GS-9b-1 — the development pipeline's assembly

**No migration** (ADR-0106). No schema, enum, constraint or row changes, and no
new environment variable. The assembly reads `SHARED_STORAGE_DIR`,
`STORAGE_SIGNING_SECRET`, `NODE_ENV` and `VIDEO_PROVIDER`, which exist.

**What changes at deploy.** Nothing. Nothing calls the assembly, and it is
refused in production.

**Rolling back.** To GS-9a's build: safe. The assembly stores nothing of its
own; the folders it creates are the shared folder and the test provider's.
