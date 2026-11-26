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

## GS-9b-2 — the development pipeline's steps after the copy

**No migration** (ADR-0107). No schema, enum, constraint or row changes, and no
new environment variable.

**What changes at deploy.** Nothing. Nothing calls the assembly, and it is
refused in production. CI's database job now installs FFmpeg; a local
`pnpm test:db` needs `ffmpeg` and `ffprobe`.

**Rolling back.** To GS-9b-1's build: safe. The assembly stores nothing of its
own; what its steps write is the rows and objects the steps already write.

## GS-9c — the development pipeline command

**No migration** (ADR-0108). No schema, enum, constraint or row changes, and no
new environment variable. The command reads the variables the assembly already
reads, and `DATABASE_URL`.

**What changes at deploy.** Nothing. The command is the worker's `pipeline`
script, which nothing runs by itself; it is refused in production, on a
database not on this machine, and on one holding any attempt of a provider
other than the test provider.

**Rolling back.** To GS-9b-2's build: safe. The command stores nothing of its
own; what its steps write is the rows and objects the steps already write.

## GS-10a — what the start screen offers

**No migration** (ADR-0109). No schema, enum, constraint or row changes, and no
new environment variable.

**What changes at deploy.** Nothing. The offer is a read on the start service,
which nothing outside tests constructs until GS-10c's route.

**Rolling back.** To GS-9c's build: safe. The offer writes nothing.

## GS-10b — one video of a project at a time

**No migration** (ADR-0110). No schema, enum, constraint or row changes, and no
new environment variable. A unique index cannot express the rule, which spans
a job and its reservation; the start commit's read under its new project-start
advisory lock does.

**What changes at deploy.** Nothing. The start commit and service are
constructed by tests only until GS-10c's route.

**Existing data.** None is needed: before this build nothing outside tests
started a video. A project that already holds two jobs is answered with the
newest one that holds it.

**Rolling back.** To GS-10a's build: safe. Nothing is stored; the lock is
transaction-scoped.

## GS-10c — the start route, in development only

**No migration** (ADR-0111). No schema, enum, constraint or row changes, and no
new environment variable.

**What changes at deploy.** In production, nothing: the route answers `404`
and no start is built. In development with `VIDEO_PROVIDER=fake` (the
default), `POST /api/video-projects/{projectId}/generations` starts videos;
nothing on the site posts to it until GS-10d's page.

**Rolling back.** To GS-10b's build: safe. Jobs started through the route stay
as any started job does, and the development pipeline command takes them on.

## GS-10d — the start page, in development only

**No migration** (ADR-0112). No schema, enum, constraint or row changes, and no
new route or environment variable.

**What changes at deploy.** In production, nothing: the start page is not
found and the project page has no link to it. In development with
`VIDEO_PROVIDER=fake` (the default), the project page links to the start page,
whose form starts the video.

**Rolling back.** To GS-10c's build: safe. Nothing is stored by the page;
videos started from it stay as any started video does.

## GS-11a — a project's video, as its customer sees it

**No migration** (ADR-0113). No schema, enum, constraint or row changes, and no
new route or environment variable. The read uses the existing indexes on
`generation_jobs."videoProjectId"`, `generation_reservations."generationJobId"`
and `generation_scenes."generationJobId"`.

**What changes at deploy.** Nothing. The read is constructed by tests only
until GS-11b's project page.

**Rolling back.** To GS-10d's build: safe. The read writes nothing.

## GS-11b — a project's video on its project page

**No migration** (ADR-0114). No schema, enum, constraint or row changes, and no
new route or environment variable.

**What changes at deploy.** The project page reads its project's newest video.
Where nothing can start a video, as in production, no project has one and the
page shows nothing new. A video not delivered whose Units were used is shown as
unreadable and logged as an error (`component: "video-progress"`), with its
id, organization and project.

**Rolling back.** To GS-11a's build: safe. The page writes nothing.

## GS-12a — serving a stored video, a range at a time

**No migration** (ADR-0115). No schema, enum, constraint or row changes, and no
new route path or environment variable. No stored key moves: scene videos stay at
`org/{organizationId}/generations/{attemptId}/output` and are refused by the
signers and the verifier by that segment.

**What changes at deploy.** The signed download route streams what it serves
and answers byte ranges, for photos too: a photo's bytes, content type and
headers are as before, plus `Accept-Ranges: bytes`, and a request with a
`Range` header the photo holds bytes of is answered `206`. `HEAD` is answered
by the route itself, and the `401` and `404` answers are no longer cacheable. A
link that names a scene video is refused as unauthorized; nothing has ever
signed one.

**Rolling back.** To GS-11b's build: safe. Nothing is written, and no link a
customer holds names a video.

## GS-12b-1 — a link to watch a project's delivered video

**No migration** (ADR-0116). No schema, enum, constraint or row changes, and no
new route, permission or environment variable. The progress read selects the
job's `currentDeliverableVersionId` itself instead of whether it is set.

**What changes at deploy.** Nothing a customer reaches: no page or route
constructs the link service yet, so no link to a video is given and no
`video.preview_link_issued` entry is written. The project page reads the same
progress as before.

**Rolling back.** To GS-12a's build: safe. Nothing is written.

## GS-12b-2 — the delivered video on the project page

**No migration** (ADR-0117). No schema, enum, constraint or row changes, and no
new route, permission or environment variable.

**What changes at deploy.** The project page asks for a link to a project's
video when its progress shows it completed, and plays it; each such page load,
and each renewal the player asks for, writes one `video.preview_link_issued`
audit entry. Where nothing can start a video, as in production (ADR-0111), no
project has one and the page is unchanged.

**Rolling back.** To GS-12b-1's build: safe. The audit entries already written
stay; nothing else is written.

## GS-12c-1 — a download link that names the file it saves

**No migration** (ADR-0118). No schema, enum, constraint or row changes, and no
new route, permission or environment variable.

**What changes at deploy.** Nothing a customer sees: nothing signs a named link
yet, so no token names a file and the signed download route answers exactly as
before. Tokens already given stay valid: a token's payload without a name is
unchanged.

**Rolling back.** To GS-12b-2's build: safe. Nothing is written, and no token
given before the rollback names a file.

## GS-12c-2 — a link to download a project's delivered video

**No migration** (ADR-0119). No schema, enum, constraint or row changes, and no
new route, permission or environment variable. The audit action
`video.download_link_issued` is a value in the audit log's text column.

**What changes at deploy.** Nothing a customer sees: nothing outside tests
constructs `VideoDownloadService`, so no download link is given, no token names
a file and nothing new is audited.

**Rolling back.** To GS-12c-1's build: safe. Nothing is written.

## GS-12c-3 — the download on the project page

**No migration** (ADR-0120). No schema, enum, constraint or row changes, and no
new permission or environment variable. One route is added:
`POST /api/video-projects/{projectId}/download`.

**What changes at deploy.** A member holding `video.download` sees a "Download
video" button under a delivered video on its project page; each press that
gives a link writes one `video.download_link_issued` entry (ADR-0119). Where
nothing can start a video, as in production (ADR-0111), no project has one and
the page is unchanged.

**Rolling back.** To GS-12c-2's build: safe. The audit entries already written
stay; a link already given keeps working until it runs out, and a page loaded
before the rollback posts to a route that is gone (`404`).

## GS-13a — the browser test

**No migration** (ADR-0121). No schema, enum, constraint or row changes, and no
route, permission or environment variable of the app's. A development
dependency is added (`@playwright/test` 1.56.1), with a root script
(`pnpm test:e2e`) and a CI job (`e2e`).

**What changes at deploy.** Nothing: the browser test runs only in CI and on a
developer's machine, against a disposable database.

**Rolling back.** To GS-12c-3's build: safe. Nothing is written but the test's
own rows in its own database.

## GS-13b — analyze photos from the review page

**No migration** (ADR-0122). No schema, enum, constraint or row changes, and no
route, permission or environment variable. The review page gains a button that
calls the existing analysis route.

**What changes at deploy.** A member holding `asset.upload` sees the button on
a Property's review page while a ready photo has no analysis. Pressing it
analyzes those photos with the deterministic analyzer, as the route already
did for any client calling it.

**Rolling back.** To GS-13a's build: safe. Analyses the button started stay,
as any analysis the route made does.

## GS-13c-1 — the start refuses scenes no route can make

**No migration** (ADR-0123). No schema, enum, constraint or row changes, and no
route, permission or environment variable. The start and its offer answer two
new refusals, read from code (the route policy and model catalog the planner
is handed).

**What changes at deploy.** Nothing in production, where the start is not
built (ADR-0111). In development with the test provider, a storyboard with a
scene outside 5 to 15 seconds is no longer started; a job started from one
before stays waiting, as it did.

**Rolling back.** To GS-13b's build: safe. Nothing is written by the check;
the start would again admit a storyboard the launch cannot route.

## GS-13c-2 — the browser test makes and downloads a video

**No migration** (ADR-0124). No schema, enum, constraint or row changes, and no
route, permission, environment variable or production code. The browser test
gains a second test and its helpers; it runs the development pipeline command
itself, with a kept folder under `.e2e/` (git-ignored).

**What changes at deploy.** Nothing: the browser test runs only in CI and on a
developer's machine, against a disposable database.

**Rolling back.** To GS-13c-1's build: safe. Nothing is written but the test's
own rows in its own database, and clips in its own folder.

## GS-13d — the browser test of a video that is not made

**No migration** (ADR-0125). No schema, enum, constraint or row changes, and no
route, permission, environment variable or production code. The browser test
gains a third test, which runs the development pipeline's own steps in its
process with a clip maker that makes no clip.

**What changes at deploy.** Nothing: the browser test runs only in CI and on a
developer's machine, against a disposable database.

**Rolling back.** To GS-13c-2's build: safe. Nothing is written but the test's
own rows in its own database.

## AT-1 — the product sends email through a port

**No migration** (ADR-0126). No schema, enum, constraint or row changes, and no
route, permission or page. One optional environment variable,
`EMAIL_OUTBOX_DIR`, is accepted only as an absolute path outside production;
nothing reads it yet.

**What changes at deploy.** Nothing. A production environment must leave
`EMAIL_OUTBOX_DIR` unset: the environment schema refuses it there, as it
refuses `SHARED_STORAGE_DIR`.

## AT-2 — an organization is created in one transaction

**No migration** (ADR-0127). No schema, enum, constraint or row changes. The
organization, its founding `OWNER` membership and `organization.created` are
now written in one transaction, using the existing unique key on
`organizations.slug` to detect a slug taken meanwhile.

**What changes at deploy.** Nothing. Organizations created before AT-2 are
unchanged; one left without an `OWNER` by an interrupted creation, if any
exists, is not repaired.

## AT-3a — email verification links

**Migration 33** (`00000000000033_account_links`, ADR-0128). Additive only:

- enum `AccountLinkPurpose` (`EMAIL_VERIFICATION`, `PASSWORD_RESET`);
- `users."emailVerifiedAt"`, nullable, with no default;
- table `account_links`, with a unique `tokenHash`, an index on (`userId`,
  `purpose`), a foreign key to `users` that cascades on delete, and two
  CHECKs: `account_links_tokenHash_check` (64 lower-case hex characters) and
  `account_links_window_check` (expires after it is made; used, if at all,
  not before it is made). Prisma cannot express the CHECKs, so the schema
  drift check does not see them.

No existing row is updated or deleted, and migrations 0 to 32 are not touched.

**What changes at deploy.** Nothing a person sees. Every existing user reads as
unverified, and nothing checks the column until AT-3b. No production deployment
is recorded, so only development and CI databases are known to hold users;
AT-3b confirms that before its guard ships.

**Rolling back.** To AT-2's build: safe while the table is unused. Reverting the
schema means dropping `account_links`, its enum and `users."emailVerifiedAt"`,
which loses any verification recorded since.

## AT-3b — email verification is required

**No migration** (ADR-0129). Migration 33 stays the last.

**What changes at deploy.** Every account whose address is not verified, which
is every account made before AT-3b, meets the verify page at its next sign-in
and reaches nothing else until it opens a link mailed to it. Confirmed: no
production database holds users (ADR-0054 Decision 7's gates are all BLOCKED,
`infra/` holds no deployment, and ADR-0126 Decision 3 records production as
not running). Development and CI accounts verify through the outbox:
set `EMAIL_OUTBOX_DIR` and `APP_BASE_URL` (`docs/local-setup.md`, section 3c).
A production deployment cannot verify anyone until an email service is chosen.

**Rolling back.** To AT-3a's build: safe. Nothing is written that AT-3a cannot
read; verifications recorded since stay, and are again checked by nothing.

## AT-4a — an account is registered in one transaction

**No migration** (ADR-0130). Migration 33 stays the last.

**What changes at deploy.** Nothing in the schema or the data. Sign-up writes
its three rows in one transaction; accounts made before are not checked.

**Rolling back.** To AT-3b's build: safe. Sign-up again writes its rows in
separate steps.

## AT-4b-1 — password reset links, and a sign-in with a replaced password

**No migration** (ADR-0131). Migration 33 stays the last; `account_links`
already accepts `PASSWORD_RESET`.

**What changes at deploy.** Nothing in the schema or the data. Each sign-in
now makes its session in a short transaction that locks the user's row
`FOR SHARE`.

**Rolling back.** To AT-4a's build: safe. No reset link is made before AT-4c,
and sessions are unchanged.

## AT-4b-2 — resetting a password with a link

**No migration** (ADR-0132). Migration 33 stays the last.

**What changes at deploy.** Nothing in the schema or the data, and nothing
reachable: no page or route resets a password until AT-4c.

**Rolling back.** To AT-4b-1's build: safe. No link can have been used, since
nothing reaches the reset.

## AT-4c — the password reset pages

**No migration** (ADR-0133). Migration 33 stays the last.

**What changes at deploy.** Nothing in the schema or the data. Password reset
becomes reachable from the sign-in page. Asking for a link needs
`EMAIL_OUTBOX_DIR` and `APP_BASE_URL`, as email verification does; without
them, and in production, which has no email service yet, the page answers the
same and nothing is mailed.

**Rolling back.** To AT-4b-2's build: safe. A link already mailed stops
working until the pages return, and a password already reset stays reset.

## AT-5 — the members page

**No migration** (ADR-0134). Migration 33 stays the last.

**What changes at deploy.** Nothing in the schema or the data. The members page
appears, linked from the dashboard, and only reads.

**Rolling back.** To AT-4c's build: safe. Nothing was written.

## AT-6a — one pending invitation per address

**Migration 34** (`00000000000034_one_pending_invitation`, ADR-0135): one
partial unique index, `invitations_one_pending_per_email`, on
`("organizationId", "email")` where `status = 'PENDING'`. It is added by raw
SQL: Prisma cannot express the `WHERE`, so the schema drift check does not see
it, and the schema carries a comment instead.

**What changes at deploy.** The index is built. No route has created an
invitation yet, so no environment holds two pending invitations of one
address; if one did, the migration would fail rather than choose between them.
No row is changed. Nothing reachable changes: no page or route invites or
cancels until AT-6b.

**Rolling back.** To AT-5's build: drop the index
(`DROP INDEX "invitations_one_pending_per_email";`), or leave it: AT-5's build
writes no invitation. An invitation already marked `EXPIRED` or `REVOKED`
stays so.

## AT-6b — inviting and cancelling from the members page

**No migration** (ADR-0136). Migration 34 stays the last.

**What changes at deploy.** Nothing in the schema or the data. The members
page gets the invite form and the cancel buttons, and two form posts appear.
Inviting needs `EMAIL_OUTBOX_DIR` and `APP_BASE_URL`, as email verification
does; without them the page says nothing was saved. Production has no email
service yet, so nothing is mailed there. The link's page, `/accept-invitation`,
arrives with AT-7.

**Rolling back.** To AT-6a's build: safe. Invitations already made stay
pending, taking their seats until they expire after 7 days; that build cannot
cancel them, and nothing can accept them yet.

## AT-7a — accepting an invitation

**No migration** (ADR-0137). Migration 34 stays the last.

**What changes at deploy.** Nothing in the schema or the data, and nothing
reachable: no page or route accepts an invitation until AT-7b.

**Rolling back.** To AT-6b's build: safe. Nothing accepts in either build.

## AT-7b — opening and accepting an invitation

**No migration** (ADR-0138). Migration 34 stays the last.

**What changes at deploy.** Nothing in the schema or the data. The page
`/accept-invitation` and two form posts appear, and the emailed links AT-6b
sent start to work: invitations still pending can be accepted. Accepting needs
no email configuration. A browser may now hold a `rev_invitation` cookie for
up to a day.

**Rolling back.** To AT-7a's build: safe. Memberships made by accepting stay.
The links of invitations still pending lead nowhere again, and a waiting
`rev_invitation` cookie is ignored until it expires.

## AT-8a — changing a member's role

**No migration** (ADR-0139). Migration 34 stays the last.

**What changes at deploy.** Nothing in the schema or the data. One form post
appears, and the members page shows an `OWNER` or `ADMIN` a role form on the
other members whose role it may give. A change is audited as
`member.role_changed`, as the service always did.

**Rolling back.** To AT-7b's build: safe. Roles changed stay as they are; the
page no longer offers to change them.

## AT-8b — removing a member

**No migration** (ADR-0140). Migration 34 stays the last.

**What changes at deploy.** Nothing in the schema or the data. One form post
appears, and the members page shows an `OWNER` or `ADMIN` a removal form on
the other members whose role it may give. A removal is audited as
`member.removed`, as the service always did.

**Rolling back.** To AT-8a's build: safe. Removed members stay removed, and
their Properties stay unassigned; the page no longer offers to remove anyone.

## AT-9a — the groups page

**No migration** (ADR-0141). Migration 34 stays the last.

**What changes at deploy.** Nothing in the schema or the data. One page and
one form post appear, and the dashboard links the page. A creation is
audited as `group.created`, as the service always did.

**Rolling back.** To AT-8b's build: safe. Groups created stay, with their
audit entries; no page shows them until AT-9a returns.

## AT-9b — renaming and deleting a group

**No migration** (ADR-0142). Migration 34 stays the last.

**What changes at deploy.** Nothing in the schema or the data. The groups
page gains a rename form on each group for a holder of `group.manage`, and a
delete form for an `OWNER` or `ADMIN` holding it, each with its form post. A
rename is audited as `group.renamed` and a deletion as `group.deleted`, as
the service always did.

**Rolling back.** To AT-9a's build: safe. Renamed groups keep their names and
deleted groups stay deleted, their Properties ungrouped; the page no longer
offers either change.

## AT-9c — adding and removing a group's members

**No migration** (ADR-0143). Migration 34 stays the last.

**What changes at deploy.** Nothing in the schema or the data. The groups
page gains an add form on each group and a remove form on each member, for
a viewer who may assign the member's role, each with its form post. An
addition is audited as `group.member_added` and a removal as
`group.member_removed`, as the service always did. A `MANAGER` added to a
group reaches the Properties assigned to it at once (ADR-0064).

**Rolling back.** To AT-9b's build: safe. Members added stay in their groups
and members removed stay out; the page no longer offers either change.

## AT-10a — changing a Property's assignment on its page

**No migration** (ADR-0144). Migration 34 stays the last.

**What changes at deploy.** Nothing in the schema or the data. The Property
page shows an `OWNER` or `ADMIN` the Property's responsible user and group,
with a form that changes them. A change is audited as
`property.assignment_changed` and a refusal as `property.assignment_refused`,
as the service always did. A `MANAGER` in the chosen group, and a `CREATOR`
or `VIEWER` made responsible, reach the Property at once (ADR-0064).

**Rolling back.** To AT-9c's build: safe. Assignments made stay; the page no
longer shows or changes them.

## AT-10b — choosing a Property's assignment when creating it

**No migration** (ADR-0145). Migration 34 stays the last.

**What changes at deploy.** Nothing in the schema or the data. The home
page's "Add a property" form offers a member what its role may choose for the
new Property, and `POST /api/properties` passes it on; a refusal is audited as
`property.assignment_refused`, as the service always did. That route now
refuses a post from another origin with `403`. A `BILLING` member's home page
no longer fails.

**Rolling back.** To AT-10a's build: safe. Properties keep the assignments
they were created with. An `OWNER` or `ADMIN` again creates them unassigned,
a `MANAGER` in several groups again cannot create one, and a `BILLING`
member's home page fails again.

## AT-11a — a member's permissions page

**No migration** (ADR-0146). Migration 34 stays the last.

**What changes at deploy.** Nothing in the schema or the data. A new page,
`/organizations/{id}/members/{userId}/permissions`, reads a member's role,
individual grants and groups' permissions, and the members page links each
member to it. Nothing is written or audited.

**Rolling back.** To AT-10b's build: safe. The page and the members page's
links go; no permission changes.

## AT-11b — giving and taking back individual permissions

**No migration** (ADR-0147). Migration 34 stays the last.

**What changes at deploy.** Nothing in the schema or the data. Two routes,
`POST /api/organizations/{id}/members/{userId}/permissions/grant` and
`.../revoke`, write individual grants through `PermissionGrantService`, each
with its Phase 6D audit entry, and a member's permissions page offers them.
A member given `permission.manage` or `billing.manage` is asked to set up
two-step sign-in at their next page.

**Rolling back.** To AT-11a's build: safe. The buttons and routes go. Grants
given meanwhile stay, and stay in effect; an `OWNER` takes one back only
through the database until AT-11b returns.

## AT-11c — a group's permissions on the groups page

**No migration** (ADR-0148). Migration 34 stays the last. The new
repository read uses the primary key of `group_permissions`.

**What changes at deploy.** Nothing in the schema or the data. Two routes,
`POST /api/organizations/{id}/groups/{groupId}/permissions/grant` and
`.../revoke`, write a group's permissions through `GroupService`, each with
its Phase 6G audit entry, and the groups page shows them and offers them.
Each member of a group given `permission.manage` or `billing.manage` is
asked to set up two-step sign-in at their next page.

**Rolling back.** To AT-11b's build: safe. The list, the forms and the
routes go. Permissions given to groups meanwhile stay, and stay in effect;
the groups page then offers Delete, Add and Remove as before, and the group
service still refuses what the grant ceiling does not allow.

## AT-12 — the browser test of what invited members reach

**No migration** (ADR-0149). Migration 34 stays the last.

**What changes at deploy.** Nothing: only a browser test and documents.

**Rolling back.** Not applicable; no product code changes.

## RD-1 — the web app's adapters in one place

**No migration** (ADR-0150). Migration 34 stays the last.

**What changes at deploy.** Nothing a person sees: the same environment
builds the same adapters, now chosen in `apps/web/src/lib/adapters.ts`. The
in-memory storage and the test scanner now also refuse production when the
configured `NODE_ENV` says so, not only the ambient one; in a real
deployment the two are the same.

**Rolling back.** To AT-12's build: safe. Each service picks its adapters
again in its own file.

## RD-2a — a production start checked

**No migration** (ADR-0151). Migration 34 stays the last.

**What changes at deploy.** A production start of the web app (`next start`)
now ends with exit code 1 and its reasons on standard error, unless its
environment is valid, `NODE_ENV` is `production` or not set, every port's
adapter is one production may use, and `DATABASE_URL`, `MFA_SECRET_KEY` and
`APP_BASE_URL` are set. No production adapter exists for object storage,
malware scanning or email until RD-3, RD-5 and RD-6, so no production start
passes the check yet; nothing is deployed. `next build` is unchanged, and so
are `next dev` and the browser test unless `NODE_ENV` is set to `production`
there, which is now refused.

**Not checked.** A server started with `NEXT_PHASE=phase-production-build` in
its environment: Next.js 15.5 skips its start hook there (ADR-0151
Decision 1). A deployment must not set it. Such a start behaves as RD-1's:
each development adapter refuses production when first built.

**Rolling back.** To RD-1's build: safe. A production start is no longer
checked, and a misconfiguration again surfaces at the first request that
meets it.

## RD-2b — readiness asks the database and the storage

**No migration** (ADR-0152). Migration 34 stays the last.

**What changes at deploy.** `GET /api/health/ready` answers `503` when the
database does not answer `SELECT 1`, or the chosen object storage does not
answer whether one key holds an object. Readiness sets no time limit of its
own (ADR-0152 Decision 2). When the database client has to open a
connection, a database that is down or cannot be reached reads `503`, at
once or after about 5 seconds; when it waits for a connection from its pool,
after about 10. When it sends the query on a connection it holds, a database
that says nothing leaves the request waiting. Whatever watches readiness
must set a limit of its own and read no answer as not ready. It sends the
operator's token, as before. The probes write no row and no object.

**On a development machine.** With no database running, readiness reads
`degraded` where it read `ready`. Nothing else changes.

**Rolling back.** To RD-2a's build: safe. Readiness again reports the
provider self-check and the MFA key alone.

## RD-2c — readiness limited by its clients' own settings

**No migration** (ADR-0153). Migration 34 stays the last.

**What changes at deploy.** Each web process holds one more database
connection, made for its readiness probe: count it against the database's
connection limit. It is opened when readiness is first asked, for the
address in `DATABASE_URL` with `connection_limit=1`, `connect_timeout=3`,
`socket_timeout=3` and `pool_timeout=4` replacing whatever the address sets
for those four. A value there that Prisma cannot read is replaced too, and
a space before the address or a protocol in capitals is put right, so
readiness reads `ready` with an address the web app's own client refuses
(`P1012`, `P1013`): try a new address with a request that uses the
database. It comes with a second Prisma engine in the process, about 2 MB
of memory where it was measured. The web app's own client is as before.

`GET /api/health/ready` now answers `503` after 3 or 4 seconds when the
database says nothing and one request asks at a time, where it could wait
without end. Requests that arrive together take the one connection in turn:
of five at once the last read `503` after 6 seconds, and with a database
that answers slowly one of them can read `503` though every answer came in
time. Each step has its own limit, so at the very most a probe takes 10
seconds. Whatever watches readiness keeps a limit of its own and reads no
answer as not ready, as before. The storage check has its adapter's limits
alone (ADR-0153 Decision 2).

**On a development machine.** Nothing to do.

**Rolling back.** To RD-2b's build: safe. Readiness again asks the web
app's own database client, with no limit of its own.

## RD-2d — readiness says what the start check refuses

**No migration** (ADR-0154). Migration 34 stays the last.

**What changes at deploy.** `GET /api/health/ready` answers with a fifth
check, `start`. It reads `nothing refused` in every start the start check
lets go on whose environment can be read. In a start the check would have
refused and did not see, such as one given
`NEXT_PHASE=phase-production-build`, it gives the check's reasons, the
answer is `503`, and the server logs the reasons as a warning each time
readiness is asked. Such a start whose environment fails its schema answers
`500` with no checks, as before, and logs no such warning (ADR-0154
Decision 3). A deployment must still not set `NEXT_PHASE`: such a server is
not ended, and serves whoever reaches it.
Whatever reads the checks by name is not affected; whatever counts them
finds five.

**On a development machine.** Nothing to do.

**Rolling back.** To RD-2c's build: safe. Readiness answers with four
checks again.

## RD-2e — readiness asks the web app's own client to connect

**No migration** (ADR-0155). Migration 34 stays the last.

**What changes at deploy.** `GET /api/health/ready` answers `503`, and the
server logs `P1012` or `P1013` for the `database` probe, with a
`DATABASE_URL` that the web app's own client cannot read: one that does not
begin with `postgresql://` or `postgres://` exactly as written, or whose
own value for `connection_limit`, `connect_timeout`, `socket_timeout` or
`pool_timeout` Prisma cannot read. RD-2c's note above says readiness reads
`ready` with such an address; from this build it does not. Correct the
address and restart: a process keeps the address it first read. `503`
follows too, where readiness read `ready`, when the database answers the
probe's client and refuses or does not answer the web app's own first
connection (`P1001`, `P2024`, `P2037`, `P1000`). `P1012` with an address
that is right as written: restart the process (ADR-0155 Decision 5).

The web app's own client now opens its first connection when readiness is
first asked and the database answers, where a request opened it before: a
process that has only been asked for readiness holds two connections, not
one. That step waits by the web app's own client's settings, 5 seconds by
Prisma's defaults, so RD-2c's "at the very most a probe takes 10 seconds"
is 15 by those defaults. Do not set both `connect_timeout=0` and
`pool_timeout=0` in the address: a first connection that is never answered
then leaves readiness waiting without end, as it leaves the app's own
requests. Do not set `socket_timeout=0` either: with it the web app's
queries were measured to fail now and then, and readiness does not see
that (`docs/decisions/TODO.md`).

**On a development machine.** Nothing to do. A `DATABASE_URL` written with
a space before it now reads `degraded`, where it read `ready` while every
request that used the database failed.

**Rolling back.** To RD-2d's build: safe. Readiness again reads `ready`
with an address the web app's own client cannot read.

## RD-3a — the Google Cloud Storage adapter's objects

**No migration** (ADR-0156). Migration 34 stays the last.

**What changes at deploy.** Nothing: no application constructs the new
adapter, and no setting is read. `@app/storage` depends on gaxios 7.3.1, so
an install adds ten packages.

**For the first deployment that uses it** (RD-3d onward): the account the
web app runs as needs `storage.objects.get`, `storage.objects.create`,
`storage.objects.delete` and `storage.objects.list` on the one bucket. The
list permission is how the adapter tells a missing object from a missing
bucket (ADR-0156 Decision 2); without it every `exists` is refused. What
Google answers an account without it is not measured, and is a check for
that deployment (`docs/decisions/TODO.md`).

**On a development machine.** Nothing to do. To run the new suites, start
the emulator and name it (`docs/local-setup.md`, *Cloud Storage emulator
tests*).

**Rolling back.** To RD-2e's build: safe. Nothing used the adapter.

## RD-3b — the Google Cloud Storage adapter's streamed read

**No migration** (ADR-0157). Migration 34 stays the last.

**What changes at deploy.** Nothing: no application constructs the adapter,
and no setting or package is added.

**For the first deployment that uses it** (RD-3d onward): a read needs
`storage.objects.get`, and `storage.objects.list` after a `404`, which
RD-3a's list already needs. A read that finds its object is two requests
against the bucket, the size and the bytes, and three when the bytes'
request answers `404` and the list follows. An absent object or a missing
bucket is two, the size and the list; a range or an object that holds no
bytes is one, the size alone. What Google answers for a generation
overwritten between the size's request and the bytes', and for an answer cut
while it streams, are checks for that deployment (`docs/decisions/TODO.md`).

**On a development machine.** Nothing to do.

**Rolling back.** To RD-3a's build: safe. Nothing used the adapter.

## RD-3c — the Google Cloud Storage adapter's credential

**No migration** (ADR-0158). Migration 34 stays the last.

**What changes at deploy.** Nothing: no application constructs the adapter,
and no setting or package is added.

**For the first deployment that uses it** (RD-3d onward): the service account
the web app runs as is its identity, through the metadata server; no key
file and no variable names it. Its token's scopes must allow Cloud Storage
(`devstorage.read_write` or `cloud-platform`). The adapter sends its
requests through no proxy, whatever the environment names, so the service
must reach `storage.googleapis.com` and `metadata.google.internal` directly.
What Google answers a token that has ended, and whether one that ends during
a long upload or read cuts it, are checks for that deployment
(`docs/decisions/TODO.md`).

**On a development machine.** Nothing to do.

**Rolling back.** To RD-3b's build: safe. Nothing used the adapter.

## RD-3d — Google Cloud Storage in the web app

**No migration** (ADR-0159). Migration 34 stays the last.

**What changes at deploy.** Two optional settings,
`GOOGLE_CLOUD_STORAGE_BUCKET` and `GOOGLE_CLOUD_STORAGE_ENDPOINT`, and no
package. An environment that sets neither builds the same adapters as
before. A production environment that sets `NODE_DEBUG` is now refused, the
worker's included.

**For a production web app** (whose start is still refused until RD-5 and
RD-6): set `GOOGLE_CLOUD_STORAGE_BUCKET` to the bucket, and no endpoint. The
service account the web app runs as needs the four permissions on that
bucket listed under RD-3a, and a token whose scopes allow Cloud Storage
(RD-3c); the service must reach `storage.googleapis.com` and
`metadata.google.internal` directly. Set neither `SHARED_STORAGE_DIR` nor
`NODE_DEBUG`. Readiness then asks the bucket on every readiness request:
one list, which Google charges for, waiting up to about six seconds when a
token is due. Whatever asks for readiness should allow for both.

**On a development machine.** Nothing to do. To keep the web app's objects
in the Cloud Storage emulator instead of memory or a folder, see
`docs/local-setup.md`, section 3b. The development pipeline still needs the
shared folder, and a bucket cannot be set beside it.

**Rolling back.** To RD-3c's build: safe. That build ignores both settings,
so a web app given a bucket keeps its objects in memory or the shared folder
again, and does not see what it stored in the emulator.

## RD-4a — the worker's reads and first-wins writes in Google Cloud Storage

**No migration** (ADR-0160). Migration 34 stays the last.

**What changes at deploy.** Nothing: no setting or package is added, the
web app's storage is unchanged, and the worker is not given its view.

**For the first deployment that uses it** (part 2 onward): the service
account the worker runs as needs `storage.objects.get`,
`storage.objects.list` and `storage.objects.create` on the bucket the web
app uses, and a token whose scopes allow Cloud Storage (RD-3c). Its write
never replaces an object, so it should need no `storage.objects.delete`.
Not measured, and checks for that deployment (`docs/decisions/TODO.md`):
what Google answers a write that loses its race from an account without
the delete permission, what it answers a read the account may not make,
that it refuses an upload whose MD5 does not match, whether it answers
`412` before the whole file is sent, and what its `412` names.

**On a development machine.** Nothing to do.

**Rolling back.** To RD-3d's build: safe. Nothing used the worker's view.

## RD-4b — the staging sink's upload in Google Cloud Storage

**No migration** (ADR-0161). Migration 34 stays the last.

**What changes at deploy.** Nothing: no setting or package is added, the
web app's storage is unchanged, and the worker is not given its view.

**Before the worker stores a scene in Cloud Storage** (part 2): check on a
real bucket when Google checks a resumable upload's `ifGenerationMatch=0`.
If it checks only at the start, two uploads of one scene would both finish
and the later would replace the earlier; the fallback is in ADR-0161. Part
2 may not let the worker store a scene until this passes.

**For the first deployment that uses it**: the worker's account needs
`storage.objects.create`, as for RD-4a; that a session's cancel needs
nothing more is inferred. Not measured, and checks for that deployment
(`docs/decisions/TODO.md`): that Google refuses a last chunk whose MD5 does
not match, what it answers a chunk that breaks the 256 KiB rule, the form
of its `308` answers and its session URI, whether it keeps fewer bytes of
a chunk than it was sent, that a `DELETE` cancels a session and what it
answers one after a last chunk refused with `412`, and whether an
abandoned session's bytes are billed until Google ends it after a week.
Part 2's tracing must not record the URLs of these requests: a session's
URI lets anyone who holds it write to the bucket.

**On a development machine.** Nothing to do.

**Rolling back.** To RD-4a's build: safe. Nothing used the worker's view.

## RD-4c — the development pipeline beside the Cloud Storage emulator

**No migration** (ADR-0162). Migration 34 stays the last.

**What changes at deploy.** Nothing: no setting or package is added, and
nothing in production builds the worker's view. The development pipeline,
which is refused in production, may now run on the emulator.

**For the first deployment that uses it.** Nothing new: the pipeline never
builds Google's store. RD-4a's and RD-4b's checks stand for part 2.

**On a development machine.** A machine whose web app keeps its objects in
the emulator gives the pipeline the same `GOOGLE_CLOUD_STORAGE_BUCKET` and
`GOOGLE_CLOUD_STORAGE_ENDPOINT`, without `SHARED_STORAGE_DIR`, with the
emulator running and its bucket made (`docs/local-setup.md`, 3b and 4a). A
machine on the folder changes nothing. A local `pnpm test:db` runs the
pipeline's suite on the emulator too when `GOOGLE_CLOUD_STORAGE_TEST_ENDPOINT`
names one, and on the folder alone otherwise; CI's `database` job names
one.

**Rolling back.** To RD-4b's build: safe. Its pipeline refuses to start
without `SHARED_STORAGE_DIR`, and objects in the emulator stay there.

## RD-5a — the ClamAV scanner

**No migration** (ADR-0163). Migration 34 stays the last.

**What changes at deploy.** Nothing is built from it: the web app still
uses the test scanner, and a production start is still refused. An
upload whose scanner throws or answers an unknown verdict now ends
`FAILED`; the test scanner does neither.

**For the first deployment that uses it.** ADR-0163 Decision 6: clamd on
a private network or a loopback sidecar, its port reachable from the web
app alone, its limits never below the 1.5.5 defaults, `AlertBrokenMedia`
off.

**On a development machine.** Nothing changes unless the ClamAV suite is
run: start a daemon on `127.0.0.1` and name its port in
`CLAMAV_TEST_PORT` (`docs/local-setup.md`, section 5).

**Rolling back.** To RD-4c's build: safe. Nothing stores anything new.
A photo a throwing scanner would have failed would again be left
`SCANNING`, as before.

## RD-5b — ClamAV in the web app

**No migration** (ADR-0164). Migration 34 stays the last.

**What changes at deploy.** Two optional settings, `CLAMAV_HOST` and
`CLAMAV_PORT`. Unset, the web app scans with the test scanner and a
production start is refused for it, as before. Set, it scans every upload
with the daemon they name, and a production start allows it; the start is
still refused for email until RD-6. A host with a port, or a port outside
1 to 65535 or without a host, is refused as the web app starts.

**For the first deployment that uses it.** ADR-0163 Decision 6, and an
operator who reads the web app's log for `A malware scan could not be
completed` and its `code`.

**On a development machine.** Nothing changes unless `CLAMAV_HOST` is set
(`docs/local-setup.md`). The browser test refuses both settings.

**Rolling back.** To RD-5a's build: safe. The two settings are no longer
read, and uploads are scanned by the test scanner again.

## RD-5c — the upload panel's Retry

**No migration** (ADR-0165). Migration 34 stays the last.

**What changes at deploy.** The Property page's upload panel: its Retry
tries the same photo, and is not offered on a quarantined or rejected
photo. Completing or retrying a `FAILED` photo is refused where the
Property has no place left. No setting changes. Photos an earlier Retry
left `PENDING_UPLOAD` still hold their places; nothing frees them.

**Rolling back.** To RD-5b's build: safe. Retry again asks for the file
and makes a new photo, and a failed photo completed again is not checked
against the limit.

## RD-6a — the SMTP email sender

**No migration** (ADR-0166). Migration 34 stays the last.

**What changes at deploy.** Nothing is built from it: the web app still
mails through the outbox or not at all, and a production start is still
refused for email. One dependency is added, `nodemailer` `10.5.0`, in
`@app/storage` alone.

**On a development machine.** `pnpm install` adds the dependency. The
adapter's tests make a certificate with `openssl` for each run, which must
be on the path.

**Rolling back.** To RD-5c's build: safe. Nothing stores anything new.

## RD-6b — Mailpit in CI

**No migration.** Migration 34 stays the last.

**What changes at deploy.** Nothing: the product is unchanged. CI's
`storage` job gains a Mailpit service container and a step running
`pnpm test:smtp`.

**On a development machine.** Nothing changes unless the SMTP suite is
run: start Mailpit on `127.0.0.1` and name its ports in
`MAILPIT_TEST_SMTP_PORT` and `MAILPIT_TEST_API_PORT`
(`docs/local-setup.md`, section 5).

**Rolling back.** To RD-6a's build: safe. Nothing stores anything new.

## RD-6c — the SMTP settings

**No migration** (ADR-0167). Migration 34 stays the last.

**What changes at deploy.** Eight optional settings. The schema checks
the seven SMTP ones, and nothing uses them yet, so the web app still
mails through the outbox or not at all, and a production start is still
refused for email. A production deployment that sets
`NODE_TLS_REJECT_UNAUTHORIZED`, to any non-empty value, no longer starts.

**On a development machine.** Nothing changes unless an SMTP setting is
set: then all seven are required, never beside `EMAIL_OUTBOX_DIR`. The
browser test refuses every one.

**Rolling back.** To RD-6b's build: safe. The settings are no longer
checked, and nothing stores anything new.

## RD-6d — SMTP in the web app

**No migration** (ADR-0168). Migration 34 stays the last.

**What changes at deploy.** With `SMTP_HOST` and its six companions set,
the web app sends every email through that server, and a production
start can pass for the first time. `SMTP_USER` and `SMTP_PASSWORD` come
from the secret manager; the web app alone needs outbound 465 or 587;
`SMTP_HOST` must have a certificate Node.js's bundled authorities trust,
since no setting of ours adds one; `EMAIL_FROM` must be on the domain the
service signs for. A passing start does not show that an email can be
delivered: nothing is tried until the first send. No deployment is to
set `SMTP_HOST` before RD-7 and RD-8 limit resets and invitations
(`TODO.md`); nothing in code enforces it.

**For the first deployment that uses it.** An operator reads `An email
was not accepted for delivery` and its `code` (component `email`), beside
the flow's own `PROVIDER_ERROR` line.

**On a development machine.** Nothing changes unless `SMTP_HOST` is set.
The browser test refuses every SMTP setting.

**Rolling back.** To RD-6c's build: safe. The settings are checked but no
longer used, and a production start is refused for email again.

## RD-7a — the rule of the abuse limits

**No migration** (ADR-0169). Migration 34 stays the last.

**What changes at deploy.** Nothing: no route uses the new code, and
nothing is limited yet.

**On a development machine.** Nothing changes.

**Rolling back.** To RD-6d's build: safe. Nothing stores anything new.

## RD-7b — the abuse-limit counters

**Migration 35** (`00000000000035_rate_limit_counters`, ADR-0169): one new
table, `rate_limit_counters`, keyed by `("policy", "subject")`, with an
index on `"expiresAt"`. Its CHECK, `rate_limit_counters_shape_check`, and
its fill factor of 80 are added by raw SQL: Prisma cannot express them,
so the schema drift check does not see them. No existing row is read or
changed.

**What changes at deploy.** The table is created empty. Nothing reachable
writes to it: no route builds the store until RD-7d.

**On a development machine.** `pnpm --filter @app/database run
db:migrate` applies it. The database suite gains
`tests/integration/rate-limit-store.db.test.ts`.

**Rolling back.** To RD-7a's build: leave the table, which that build
never reads. To remove it as well, drop it
(`DROP TABLE "rate_limit_counters";`) and delete migration 35's row from
`_prisma_migrations`, or a later deploy would not create it again.

## RD-7c — rate-limit settings and the client address

**No migration** (ADR-0170). Migration 35 stays the last.

**What changes at deploy.** A production start of the web app now needs
`FORWARDED_FOR_TRUSTED_ENTRIES`: how many entries at the right end of
`X-Forwarded-For` the deployment's own infrastructure writes, measured
there, never guessed. The five `RATE_LIMIT_*` settings are optional and
take their defaults; a value out of form is refused in every
environment, by the web app and the worker alike. Nothing is limited
yet: no route reads them until RD-7d.

**On a development machine.** Nothing changes unless a `RATE_LIMIT_*`
setting is set: a value out of form is then refused. The browser test
refuses the five limits and `FORWARDED_FOR_TRUSTED_ENTRIES` from the
shell.

**Rolling back.** To RD-7b's build: safe. The settings are no longer
checked, and a production start no longer needs the new one. Nothing
stores anything new.

## RD-7d — sign-in and wrong MFA codes are limited

**No migration** (ADR-0171). Migration 35 stays the last.

**What changes at deploy.** Sign-in is limited per typed address and,
where `FORWARDED_FOR_TRUSTED_ENTRIES` is set, per client address; wrong
MFA codes are limited per user, across sign-ins. The web app writes
`rate_limit_counters` from the first sign-in. The limiter opens a
database client of its own, of up to 3 connections, which count against
the database's connection budget beside the web app's own and the
readiness probe's.

**On a development machine.** Five wrong passwords for one address, or
five wrong codes for one user, within 15 minutes now hold the next
attempt for 15 minutes. `DELETE FROM "rate_limit_counters";` clears
every count.

**Rolling back.** To RD-7c's build: safe. Nothing is limited, and the
table's rows are left unread.

## RD-7e — reset and verification emails are limited

**No migration** (ADR-0172). Migration 35 stays the last.

**What changes at deploy.** Reset requests are limited per typed address
and, where `FORWARDED_FOR_TRUSTED_ENTRIES` is set, per client address;
verification emails, sign-up's included, per account address. A
completed reset clears the address's held sign-in. No deployment is to
set `SMTP_HOST` yet: the invitation limit waits for RD-8 (`TODO.md`).

**On a development machine.** A fourth reset request, or a fourth
verification email, for one address within the hour is refused until
the hour ends. `DELETE FROM "rate_limit_counters";` clears every count.

**Rolling back.** To RD-7d's build: safe. The emails are no longer
limited, and the table's rows for them are left unread.

## RD-8a — sign-up is limited per client address

**No migration** (ADR-0173). Migration 35 stays the last: the table's
CHECK takes the new policy's name.

**What changes at deploy.** Where `FORWARDED_FOR_TRUSTED_ENTRIES` is set,
sign-up is counted per client address, 60 an hour by default, failed
sign-ups included. `RATE_LIMIT_SIGN_UP_PER_IP` is optional and takes its
default; a value out of form is refused, by the web app and the worker
alike. Without a client address nothing is counted.

**On a development machine.** Nothing changes: the setting that gives a
client address stays unset, so sign-up is not counted. The browser test
refuses the new setting from the shell.

**Rolling back.** To RD-7e's build: safe, even with the new setting
set, which that build's schema does not know and ignores. Sign-up is no
longer limited, and the table's rows for it are left unread.

## RD-8b — uploads are limited per account

**No migration** (ADR-0173). Migration 35 stays the last: the table's
CHECK takes the new policy's name.

**What changes at deploy.** Upload links, retries and checks are counted
per signed-in account, 1,000 a day by default, failed ones included.
`RATE_LIMIT_UPLOAD` is optional and takes its default; a value out of
form is refused, by the web app and the worker alike. Signed-in routes
count on a second limiter database client, of up to 3 connections more,
which count against the database's connection budget.

**On a development machine.** A 1,001st upload request of one account
within 24 hours of its first is refused until those 24 hours end.
`DELETE FROM "rate_limit_counters";` clears every count.

**Rolling back.** To RD-8a's build: safe, even with the new setting set,
which that build's schema does not know and ignores. Uploads are no
longer limited, the second client is not opened, and the table's rows
for uploads are left unread.

## RD-8c — invitations are limited per account

**No migration** (ADR-0173). Migration 35 stays the last: the table's
CHECK takes the new policy's name.

**What changes at deploy.** Invitations are counted per signed-in
account, 50 a day by default, failed ones included, on the signed-in
limiter client. `RATE_LIMIT_INVITATION` is optional and takes its
default; a value out of form is refused, by the web app and the worker
alike. The reset and invitation limits that the RD-6d and RD-7e notes
above waited for are in place, so the condition of the rule that no
deployment sets `SMTP_HOST` is met; the email service and its sending
domain stay the product owner's (`TODO.md`).

**On a development machine.** A 51st invitation of one account within
24 hours of its first is refused until those 24 hours end.
`DELETE FROM "rate_limit_counters";` clears every count.

**Rolling back.** To RD-8b's build: safe only with `SMTP_HOST` unset,
since that build does not limit invitations and the rule that no
deployment sets `SMTP_HOST` applies to it again. The new setting may
stay set, which that build's schema does not know and ignores.
Invitations are no longer limited, and the table's rows for them are
left unread.

## RD-8d — analyses are limited per account

**No migration** (ADR-0173). Migration 35 stays the last: the table's
CHECK takes the new policy's name.

**What changes at deploy.** Analyses and refreshes are counted together
per signed-in account, 300 an hour by default, failed ones included, on
the signed-in limiter client. `RATE_LIMIT_ANALYSIS` is optional and
takes its default; a value out of form is refused, by the web app and
the worker alike.

**On a development machine.** A 301st analysis request of one account
within an hour of its first is refused until that hour ends.
`DELETE FROM "rate_limit_counters";` clears every count.

**Rolling back.** To RD-8c's build: safe, even with the new setting set,
which that build's schema does not know and ignores. Analyses are no
longer limited, and the table's rows for them are left unread.

## RD-8e — downloads are limited per account

**No migration** (ADR-0173). Migration 35 stays the last: the table's
CHECK takes the new policy's name.

**What changes at deploy.** Video downloads and photo download links are
counted together per signed-in account, 60 an hour by default, failed
ones included, on the signed-in limiter client. `RATE_LIMIT_DOWNLOAD` is
optional and takes its default; a value out of form is refused, by the
web app and the worker alike. Page renders that sign thumbnails or the
video preview are not counted.

**On a development machine.** A 61st download of one account within an
hour of its first is refused until that hour ends.
`DELETE FROM "rate_limit_counters";` clears every count.

**Rolling back.** To RD-8d's build: safe, even with the new setting set,
which that build's schema does not know and ignores. Downloads are no
longer limited, and the table's rows for them are left unread.

## RD-8f — video starts are limited per account

**No migration** (ADR-0173). Migration 35 stays the last: the table's
CHECK takes the new policy's name.

**What changes at deploy.** In production the start route still answers
404, before it counts. Where it is built (development with the test
provider), each start is counted per signed-in account, 30 an hour by
default, failed and refused ones included, on the signed-in limiter
client, before the start service. `RATE_LIMIT_GENERATION_START` is
optional and takes its default; a value out of form is refused at
startup, by the web app and the worker alike, in production too.

**On a development machine.** A 31st start of one account within an
hour of its first is refused until that hour ends, with no Unit reserved
and no job written. `DELETE FROM "rate_limit_counters";` clears every
count.

**Rolling back.** To RD-8e's build: safe, even with the new setting set,
which that build's schema does not know and ignores. Starts are no
longer limited, and the table's rows for them are left unread.

## RD-8g — Unit purchase approvals are limited per account

**No migration** (ADR-0173). Migration 35 stays the last: the table's
CHECK takes the new policy's name.

**What changes at deploy.** Each approval of an additional Unit package
is counted per signed-in account, 10 an hour by default, failed and
refused ones included, on the signed-in limiter client, before the
purchase service checks `billing.manage`. `RATE_LIMIT_UNIT_PURCHASE` is
optional and takes its default; a value out of form is refused, by the
web app and the worker alike. A body that is not a form returns to the
buy page as unreadable, where it failed before.

**On a development machine.** An 11th approval of one account within an
hour of its first is refused until that hour ends, with nothing bought
and no audit written. `DELETE FROM "rate_limit_counters";` clears every
count.

**Rolling back.** To RD-8f's build: safe, even with the new setting set,
which that build's schema does not know and ignores. Purchase approvals
are no longer limited, and the table's rows for them are left unread.

## RD-9a — the origin check compares with `APP_BASE_URL`

**No migration** (ADR-0174). Migration 35 stays the last.

**What changes at deploy.** `APP_BASE_URL` must be the exact public
origin customers open: `https`, the domain, no port. The 20 routes that
already check their origin now accept only that origin's posts; a
wrong value refuses every one of them with `403`, and reaching the
service at another address or over `http` refuses them there. Redirect
those at the front. A production server without the setting refuses
every checked change, the start that skips the start check included.
Each refusal is logged at `warn` as `ORIGIN_REFUSED` with its reason.

**On a development machine.** Without `APP_BASE_URL`, the host you open
is accepted, as before. With it, open the web app at exactly that
address: `127.0.0.1` for `localhost`, or another port, is refused. Run
`pnpm test` without `APP_BASE_URL` in the shell.

**Rolling back.** To RD-8g's build: safe. The host rule returns
everywhere, and nothing was stored.

## RD-9b — the signed-in work routes check their origin

**No migration** (ADR-0174). Migration 35 stays the last.

**What changes at deploy.** Uploads, photo analysis and review, video
project creation, storyboard composition and the organization's MFA
requirement now accept a post only from `APP_BASE_URL`'s origin, as the
20 routes RD-9a covered do. A wrong `APP_BASE_URL` now also stops
uploads and the review pages with `403`. Each refusal is logged at
`warn` as `ORIGIN_REFUSED`, with its reason and route.

**On a development machine.** Nothing new: open the web app at exactly
`APP_BASE_URL` where it is set. Run `pnpm test` without `APP_BASE_URL`
in the shell.

**Rolling back.** To RD-9a's build: safe. These 11 routes rely on
`SameSite=Lax` alone again, and nothing was stored.

## RD-9c — the sign-in and account routes check their origin

**No migration** (ADR-0174). Migration 35 stays the last.

**What changes at deploy.** Sign-in, sign-up, sign-out, the MFA code
step and MFA settings, organization creation, password reset and email
verification now accept a post only from `APP_BASE_URL`'s origin.
**`APP_BASE_URL` must be exactly the public origin customers open
(`https`, the domain, no port), or nobody can sign in:** every sign-in
answers `403`, and so does sign-up. Check it before the deploy, and
after it sign in once through the public address. Reaching the service
at another address or over `http` refuses sign-in there; redirect those
at the front. Each refusal is logged at `warn` as `ORIGIN_REFUSED`,
with its reason and route; a `NO_ORIGIN` on sign-in would be a browser
that sends no `Origin`.

**On a development machine.** Nothing new: open the web app at exactly
`APP_BASE_URL` where it is set, or sign-in is refused too. Run
`pnpm test` without `APP_BASE_URL` in the shell.

**Rolling back.** To RD-9b's build: safe. These 13 routes rely on
`SameSite=Lax` alone again, and nothing was stored.

## RD-9d — fixed security headers and the API policy

**No migration** (ADR-0174). Migration 35 stays the last.

**What changes at deploy.** Every answer carries `nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options:
DENY`, a `Permissions-Policy` and COOP and CORP `same-origin`; every
`/api` answer carries `default-src 'none'; frame-ancestors 'none';
sandbox`; `X-Powered-By` is gone. A build made under
`NODE_ENV=production` also sends `Strict-Transport-Security:
max-age=31536000`, for the app's own host only. HSTS follows the
`NODE_ENV` in effect when `next build` runs; `next build` sets it to
`production` only when it is unset, and a build run with another
`NODE_ENV` sends no HSTS. So build the production image with `NODE_ENV`
unset or `production` (RD-10 builds the images). These headers are
fixed by `next build`: rebuild to change them. No page
can be shown in another site's frame. Anything a load balancer or CDN
adds of the same names should be removed there, so one value is sent.

**On a development machine.** `next dev` sends the same headers but
HSTS, so `localhost` is never pinned to `https`.

**Rolling back.** To RD-9c's build: the headers go, and nothing was
stored. HSTS does not go: a browser that saw it keeps using `https` for
the app's host until `max-age` runs out, up to a year. That is harmless
while the service is served over `https` only, as production requires
(`APP_BASE_URL` is `https`); to end it early, deploy a build that sends
`Strict-Transport-Security: max-age=0` and let browsers revisit. It
never reaches other hosts of the domain: no `includeSubDomains`.

## RD-9e — the pages' Content Security Policy

**No migration** (ADR-0174). Migration 35 stays the last.

**What changes at deploy.** Every page answer carries one
`Content-Security-Policy` with a new nonce per request, set by
`apps/web/src/middleware.ts`: scripts only with the nonce or loaded by
one that has it, styles from the app or inline, images from the app or
`data:`, video, fonts and connections from the app only, no plugin, no
`<base>`, forms only to this origin, no frame and no framing. `/api`
keeps RD-9d's policy. The policy is enforced, with nowhere to report a
refusal. Anything the app loads from another site later (Stripe.js,
analytics, a chat, web fonts) is refused until the policy is changed
and reviewed. A load balancer or CDN must not add its own
`Content-Security-Policy` to pages, nor cache a page: each carries its
own nonce. An unknown address shows Next.js's prerendered "not found"
text without its scripts. `/favicon.ico`, which the app does not have,
and an unknown address under `/_next/` outside `/_next/static` get that
not-found page with no page policy at all, only RD-9d's fixed headers:
the middleware does not run there. A form redirected to the server's bind
address, which a redirect built from `request.url` names behind a
proxy, is now refused by the browser (`TODO.md`, "Open in RD-9").

**On a development machine.** `next dev` sends the same policy with
`'unsafe-eval'` for scripts and `ws: wss:` for its Fast Refresh socket.
A refused load shows in the browser's console as "Refused to ...", and
every browser test fails on one.

**Rolling back.** To RD-9d's build: the page policy goes, and nothing
was stored or is kept by a browser.

## RD-10a — the web app's container image, built and smoked in CI

**No migration** (ADR-0175). Migration 35 stays the last.

**What changes at deploy.** Nothing is deployed or pushed. `next build`
now also writes `apps/web/.next/standalone`, the server with only the
files it loads (`output: "standalone"`). `next start`, which nothing
runs, now only warns that it does not suit that output (read in
Next.js's source, not run).
`apps/web/Dockerfile`, built from the repository root with
`docker buildx build --platform linux/amd64 -f apps/web/Dockerfile .`,
makes the production
image: `node:22-trixie-slim` at one pinned digest, `ca-certificates`
from Debian, uid 1000, port 3000, `NODE_ENV=production`, and
`SSL_CERT_FILE` and `SSL_CERT_DIR` naming Debian's store. It carries no
setting of the app: whoever runs it gives every one, as a production
start requires (ADR-0151). Its entrypoint strips `NEXT_PHASE`; a
deployment must keep it, and should run it with a read-only root, as CI
does. The ignore file keeps every `.env` out of the context; the build
also refuses one at the three places Prisma reads and in `apps/web`,
whose `.env` and `.env.production` `next build` copies into the image.
CI's new `web-image` job builds and runs it on every push and
pull request, so a pull request shows 12 checks; "every check green"
is the merge rule.

**On a development machine.** Nothing changes for `pnpm dev`, the tests
or the browser test. Building the image needs Docker with BuildKit and
access to Docker Hub, Debian's mirror and the npm registry
(`docs/local-setup.md`, section 6).

**Rolling back.** To RD-9e's tree: the Dockerfile, the job and the
guard test go, and `next build` stops writing the standalone tree.
Nothing was stored, pushed or deployed.

## Next.js 15.5.28 — the security patch, with the image optimizer off

**No migration.** Migration 35 stays the last.

**What changes at deploy.** `next` is 15.5.28, a patch release that
fixes six of the nine advisories `pnpm audit --prod` found in 15.5.22:
all three critical, the high one and two moderate.
`next.config.mjs` sets `images: { unoptimized: true }`: `/_next/image`
answers `404` instead of fetching and resizing an image, and nothing in
the app used it. The web image is rebuilt from the updated lockfile; no
setting, page or header changes. The download route still sends
`Content-Length`.

**Not 15.5.29.** 15.5.29 drops the `Content-Length` a route handler
sets, which ADR-0115 Decision 3 relies on; the three advisories fixed
only there do not apply to this app (`docs/api-changes-next-15-5-28.md`).
They stay open in `TODO.md` ("Open in RD-10") with `sharp`, `zod`, and
the `postcss` that `next` pins with its `nanoid` and `source-map-js`.

**On a development machine.** Run `pnpm install` once after pulling:
the lockfile names `next` 15.5.28 and its `@next/*` packages.

**Rolling back.** To RD-10a's tree: `next` 15.5.22 and the image
optimizer return, with the nine advisories. Nothing was stored.

## RD-10b — route handlers redirect to a path

**No migration** (ADR-0175 Decision 7). Migration 35 stays the last.

**What changes at deploy.** Every redirect a route handler sends keeps
its status, `303`, and now names a path (`Location: /login`) instead of
an address built from `request.url`, which named the server's bind
address (`http://0.0.0.0:3000/login` on the image). Browsers resolve it
against the address they asked, so a proxy or load balancer in front of
the app needs no `Host` or `X-Forwarded-Host` rewriting for redirects,
and no setting is added. A client that reads `Location` itself must
resolve it against the request's address (RFC 9110, section 10.2.2);
the app's own pages and forms need nothing (`docs/api-changes-rd-10b.md`).
CI's `web-image` job now requires the path and the session cookie
deleted; the checks stay 12.

**On a development machine.** Nothing changes in running `pnpm dev`,
the tests or the browser test; the route tests now expect a path.

**Rolling back.** To the Next.js 15.5.28 tree: redirects name the
server's bind address again, which the browser refuses after a form
post (`form-action 'self'`). Nothing was stored.

## Unknown request failures logged

**No migration** (ADR-0177). Migration 35 stays the last.

**What changes at deploy.** A failure the app does not know, or a 5xx
`AppError`, taken by one of the logged catches now writes one `error`
line to stdout from the component `request`, with `route`, `requestId`,
`errorName`, `code` and, when present, `causeName`, and never the
error's message or anything of the request
(`docs/api-changes-unknown-failures.md`). No answer changes. A log
filter or alert can select `"component":"request"`, unthrottled during
an outage, but it sees only those failures: an error no catch takes
(the session lookups, the body reads outside a `try`, what the home
and Units pages rethrow) still reaches only Next.js's raw output, and a
Property page
writes one line for each organization it tries. Sign-in, its code step
and the JSON routes that call `limitJsonRequest` name a limiter that
cannot reach the database `errorName: RateLimiterUnavailable`,
`causeName: PrismaClientInitializationError` and `code: UNEXPECTED`,
not `P1001`; sign-up's line names its store's own error, and the lib
helpers' limiters log a code alone. CI's `web-image` job now requires
that line for a sign-in against its stand-in database; the checks stay
12.

**On a development machine.** Nothing to do. A route test whose
request fails this way prints one such line too (measured); `pnpm dev`
runs the same code (inferred, not measured).

**Rolling back.** To RD-10b's tree: such failures are answered as
before and the line is gone; those caught and answered are logged
nowhere again, and those rethrown (the generation start, the Unit
purchase, the security page) keep only Next.js's raw line. Nothing was
stored.

## RD-10c — the worker image's runtime layer

**No migration** (ADR-0176). Migration 35 stays the last.

**What changes at deploy.** Nothing is deployed or pushed.
`apps/worker/Dockerfile`, built from the repository root with
`docker buildx build --platform linux/amd64 -f apps/worker/Dockerfile .`,
makes the worker's image: ADR-0175's base at its one digest, Debian 13's
FFmpeg, the six disclosure images at `/app/assets/disclosure` with
their checksums, and uid 1000. It holds no worker code, and its default
command exits 2, saying that the worker has no production runtime until
part 2; a deployment of it before then runs nothing.
`worker-image-check` is its explicit check. CI's new `worker-image` job
builds it and its `media-test` stage on every push and pull request and
runs the media suites on that FFmpeg with no network, so a pull request
shows 14 checks; "every check green" stays the merge rule. FFmpeg
floats within Debian 13: a point release reaches CI's image at its next
build, where the suites run again; CI's build is never pushed, so the
image a deployment runs must be that build or one the suites run on
again (ADR-0176 Decision 3).

**On a development machine.** Nothing changes for `pnpm dev`, the tests
or the browser test. Building the image needs Docker with BuildKit and
access to Docker Hub, Debian's mirror and the npm registry
(`docs/local-setup.md`, section 7).

**Rolling back.** To the tree of the unknown-failure PR: the
Dockerfile, its ignore file, `apps/worker/image/`, the job and the
guard's worker rules go, and the composer's `-r` with its unit tests;
the checks return to 12. Nothing was stored, pushed or deployed.

## RD-11a — the production image against stand-ins

**No migration** (ADR-0178); nothing deployed or pushed. With CI's new
`production-mode` job a pull request shows 16 checks. **Rolling back:**
the job, the files under `tests/production/`, the guard's stand-in rules
and helpers (`STAND_IN_JOBS`, `dockerCommands`, `builds`, `ranImage`),
and the `TODO.md` flip, amendments and items of RD-11a go; 14 checks.

## RD-11b — the browser through the front

**No migration** (ADR-0178); nothing deployed or pushed; still 16
checks. **Rolling back:** the job's Chromium, browser, limit, outage,
report and artifact steps, its `runner.env` and `all-values` lines and
the last step's check, `playwright.production.config.ts`, the
`test:production` script, the Vitest exclude and the `tsconfig.json`
include, the spec, its support files, `log-report.mjs` and its test,
the guard's browser rules, `id`, `stop` and `start`, the CSP guard
test's production specs, the parameters added to `owner.ts`
(`pressVerify` with them) and `clamav.ts`, `api-changes-rd-11b.md`,
and the `TODO.md` flip, amendments and items of RD-11b go.

## RD-11c — the completion report

**No migration**; documents only (`docs/production-readiness-completion.md`
and `TODO.md` amendments). Nothing deployed or pushed; still 16 checks.
**Rolling back:** remove the report, its pointers in the Roadmap and the
gap analysis, and RD-11c's `TODO.md` amendments, flip and new item.

## PT-6a — CI once per commit

**No migration** (ADR-0179); nothing deployed or pushed. A pull request
now shows 8 checks, one run per commit, and a newer commit cancels its
pull request's run. **Rolling back:** the workflow's `push` trigger
returns to every branch, its comment and `concurrency` go, `database`
and `e2e` return to `postgres:16`, and `tests/ci-workflow.test.ts`,
ADR-0179, the part 2 gap analysis, the README and Roadmap lines and the
`TODO.md` flip of PT-6a go; 16 checks again.

## PT-6c — `sharp` 0.35.5 and two patch overrides

**No migration**; nothing deployed or pushed; still 8 checks. A
development machine runs `pnpm install`; an image built from this
lockfile holds `sharp` 0.35.5. **Rolling back:** the two `sharp`
versions, the `overrides` block of `package.json`, the `Exif` import
of `media-pipeline.integration.test.ts`, the lockfile,
`tests/dependency-overrides.test.ts`, `api-changes-pt-6c.md`, and the
Roadmap, gap analysis and `TODO.md` lines of PT-6c go; the 8
advisories come back.

## PT-6b — each image scanned in its job

**No migration** (ADR-0180); nothing deployed or pushed; still 8
checks. Each image job pulls two more images, Syft and Grype, and
fetches Grype's database. **Rolling back:** the two pins and the three
scan steps of each image job and their comments, the guard's scan
checks in `tests/container-images.test.ts`, `.github/scan/`, ADR-0180,
and the Roadmap, gap analysis and `TODO.md` lines of PT-6b go.

## PT-6d — `zod` 4.6.7

**No migration**; nothing deployed or pushed; still 8 checks. A
development machine runs `pnpm install`. An environment that sets a
number setting (`SESSION_TTL_SECONDS`, `USER_SESSION_TTL_SECONDS`,
`WAVESPEED_POLL_*_MS`) to 2^53 or more no longer starts.
**Rolling back:** `zod` returns to 3.25.76 in `packages/shared` and
the lockfile, `env.ts`, the `shape` reads of `env.test.ts` and
`tests/container-images.test.ts` and the `VIDEO_PROVIDER` line
`queue-status-dormancy.test.ts` looks for return, the PT-6d cases of
`env.test.ts` and `tests/dependency-overrides.test.ts` go, and
`api-changes-pt-6d.md` and the Roadmap, gap analysis and `TODO.md`
lines of PT-6d go; the advisory comes back.

## PT-7a — `severity` for Cloud Logging

**No migration** (ADR-0181); nothing deployed or pushed; still 8
checks. A log line names `severity` (`DEBUG`, `INFO`, `WARNING`,
`ERROR`) where it named `level` (`debug`, `info`, `warn`, `error`): a
query, alert or tool that reads `level` must read `severity` and the
upper-case names. None exists outside the repository, since no
environment is deployed (*inference*: the gap analysis lists no
infrastructure). `LOG_LEVEL` is unchanged. **Rolling back:**
`logger.ts` writes `level` again and drops no field,
`logger.test.ts` goes, the five `apps/web/src/lib` tests and
`tests/production/log-report.mjs` and its test read `level` again, and
ADR-0181, `api-changes-pt-7a.md` and the Roadmap, gap analysis and
`TODO.md` lines of PT-7a go.

## PT-7a2 — A log message is a constant

**No migration** (ADR-0182); nothing deployed or pushed; still 8
checks. No line written today changes: every message is a literal, and
no caller is known to log a URL with a user name or password
(*inference*). A logged URL with either now shows neither. **Rolling
back:** `logger.ts` writes the message as given, `redactUrl` returns a
URL with no query unchanged, the new cases in `logger.test.ts` and
`redact.test.ts` and `tests/observability/constant-log-messages.test.ts`
go, and ADR-0182, `api-changes-pt-7a2.md` and the Roadmap, gap analysis
and `TODO.md` lines of PT-7a2 go.

## PT-7a3 — Liveness names the Cloud Run revision

**No migration** (ADR-0183); nothing deployed or pushed; still 8
checks. `GET /api/health` gains `revision`, `null` wherever
`K_REVISION` is unset or not a revision's shape. No setting is added or
required. A monitor that compares the exact liveness body must accept
the new key; none is known (*inference*: nothing is deployed, and no
consumer in the repository reads the body). **Rolling back:**
`health.ts` drops `revision` and the second parameter of
`buildLiveness`, the new cases in `health.test.ts` go, and ADR-0183,
`api-changes-pt-7a3.md` and the Roadmap and `TODO.md` lines of PT-7a3
go.

## PT-7a4 — A production start refuses the settings that widen trust

**No migration** (ADR-0184); nothing deployed or pushed; still 8 checks.
An environment that sets `NODE_OPTIONS`, `NODE_USE_SYSTEM_CA` or
`OPENSSL_CONF` to a non-empty value no longer starts in production:
unset each, or set it
empty, before deploying this commit. A heap size or any other flag once
given through `NODE_OPTIONS` needs a new ADR first. No setting is added
or required, and `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and
`SSL_CERT_DIR` are unchanged. CI's web-image job gains one step.
**Rolling back:** `env.ts` drops the three keys and their refusal, the
new cases in `env.test.ts`, `startup.test.ts`, `bootstrap.test.ts` and
`container-images.test.ts` go, as do the CI step and the
`NODE_USE_SYSTEM_CA` entry in `BANNED_ENV`, and ADR-0184,
`api-changes-pt-7a4.md` and the Roadmap, `architecture.md`,
`.env.example` and `TODO.md` lines of PT-7a4 go.

## PT-7b1 — A request error Next.js answers is logged as one JSON line

**No migration** (ADR-0185); nothing deployed or pushed; still 8
checks. The web server writes one more `ERROR` line of the component
`request`, `"Next.js answered a request that failed"`, for each error
no catch took that Next.js reports to `onRequestError`, answered
500, or 200 for a payload request or a page whose shell was
already streamed (ADR-0185); Next.js's raw print to stderr
is unchanged. No setting is added or required. A log query that counts
`"component":"request"` lines now also counts these; one that counts
`"A request failed"` is unchanged. **Rolling back:** `instrumentation.ts`
drops `onRequestError`, `failure-log.ts` drops
`logUncaughtRequestFailure` and `uncaughtRequestFields`, their cases in
`failure-log.test.ts` and `instrumentation.test.ts` go,
`startup.test.ts` holds the hook to its earlier imports again, and
ADR-0185, `api-changes-pt-7b1.md` and the Roadmap, `architecture.md`,
`SaaSOperations.md` and `TODO.md` lines of PT-7b1 go.

## PT-7b2 — The web server prints no raw error or warning line

**No migration** (ADR-0186); nothing deployed or pushed; no setting is
added or required. In production the web server's `console.error` and
`console.warn` after its start write one JSON line each, component
`console`, `ERROR` or `WARNING`, to stdout; Next.js's raw print of an
uncaught error, with its message and stack, no longer reaches stderr.
A log query or alert that read raw stderr text must read
`"component":"console"` lines, which hold the error's name and stack
frames, never its message. `next dev`, tests and the worker are
unchanged. **Rolling back:** `instrumentation.ts` drops the bridge's
install and its test cases; `console-bridge.ts` and its test go;
`startup.test.ts` drops `lib/console-bridge.ts` and `node:util`;
`failureFields` and
`failureDigest` in `failure-log.ts` may stay: PT-7b1's
`uncaughtRequestFields` now uses them and keeps working; ADR-0186,
`api-changes-pt-7b2.md` and the PT-7b2 lines of the Roadmap,
`architecture.md`, `SaaSOperations.md`, the part 2 gap analysis and
`TODO.md` go, its two flipped items back to `[ ]`. The raw print
returns.

## PT-7b3 — The production-mode job answers one error no catch takes

**No migration** (ADR-0187); nothing deployed or pushed; no setting,
image or route changes. CI's `production-mode` job gains one step,
"Answer one error no catch takes", which expects `500`, and
`tests/production/log-report.mjs` requires its `console` and `request`
`TypeError` lines once each. **Rolling back:** the step goes from
`ci.yml` with its pin in `tests/container-images.test.ts`; the report
drops `UNCAUGHT` and its count, its header comment returns to its
PT-7b2 text, and its test the new cases and the pair in `CLEAN`; ADR-0187 and
`api-changes-pt-7b3.md` go, and the PT-7b3 lines of the Roadmap and
`TODO.md`; `architecture.md`'s production-mode row returns to its
PT-7b2 text. Dropping only the step fails the report, which requires
its two lines.
The browser tests' `next dev` gets a larger heap limit
(`devServerNodeOptions` in `tests/e2e/support/environment.ts`, used by
`playwright.config.ts`), and the `e2e` job's "Browser tests" step
fails a run in which `next dev` restarted near its heap limit. **Rolling
that back:** the step returns to `pnpm run test:e2e`, the web server's
`env` to `e2eEnvironment()`, and the function and its test go with the
"Amended in PT-7b3" note on the lost-press item of `TODO.md` and its
"Find what keeps" item.

## PT-7c1 — The 404 page renders per request, so its scripts carry the nonce

**No migration** (ADR-0188); nothing deployed or pushed; no setting,
image build step or route changes. The root layout exports
`dynamic = "force-dynamic"`, so a production build no longer writes
`/_not-found` as a file: each 404 is rendered per request, which costs
a render, and carries no `x-nextjs-cache` or `x-nextjs-prerender`.
**Rolling back** is a revert: the layout's line and
`layout-dynamic.test.ts` go; the `web-image` probe's 404 lines and
their pin in `tests/container-images.test.ts` go; the
`production-mode` spec's step 8 returns to its PT-7b3 text with its
`console.log`, and the pin of printed lines takes it back; ADR-0188,
`api-changes-pt-7c1.md` and the PT-7c1 lines of the Roadmap,
`architecture.md` and the part 2 gap analysis go, and the PT-7c1
amendments of `TODO.md`, its flipped item back to `[ ]`. The 404's
scripts are then refused again.
A production build also sends the API policy on `/_next/:path*` and
`/favicon.ico` (ADR-0188 Decision 4). **Rolling that back alone**
reverts the second commit and the review fix's matcher term:
`fixedHeaderRules` returns its two rules, the middleware's matcher
returns `_next(?:/|$)` to `_next/`, the tests in `next-config.test.ts`
and `middleware.test.ts` and the `web-image` probe's `/_next`,
`/_next/nothing` and `/favicon.ico` lines and their pin go, and the
`/_not-found` item of `TODO.md` returns to `[ ]` with its second
PT-7c1 amendment removed and the first one's last sentence back to
"`/favicon.ico` and an unknown `/_next/<path>` still get no
policy".

## PT-7c2 — Browsers report page policy violations to an endpoint that logs only categories

**No migration** (ADR-0189); nothing deployed or pushed; no setting or
image step changes. A new unauthenticated route, `POST /api/csp-report`,
exists and is reachable, though no page points at it until PT-7c3. The
web app now depends on `zod` 4.6.7, the version `packages/shared`
already pins, so `pnpm-lock.yaml` gains one importer entry (three
lines) for `apps/web`; the `zod@4.6.7` package entry already existed.
**Rolling back** is a revert: the route, `lib/csp-report.ts` and their
two test files go; `zod` leaves `apps/web/package.json` and the
lockfile; the same-origin guard's exception and its count (46 to 45),
the failure-log guard's `lib/csp-report.ts` entries and counts, its
erroring-stream test and the route count in the relative-redirect
guard (51 to 50) go; ADR-0189, `api-changes-pt-7c2.md`, and the PT-7c2
lines of `API.md`, `SecurityCompliance.md`, `architecture.md`, the
Roadmap, the part 2 gap analysis and `TODO.md` go.

## PT-7c3 — The page policy reports to the endpoint

**No migration** (no new ADR; ADR-0189's "Built in PT-7c3"); nothing
deployed or pushed; no setting, dependency or image step changes.
Browsers now post a refusal under the page policy to
`POST /api/csp-report`: Chromium by `report-to` over `https`, other
engines by `report-uri` *(inference for Firefox and Safari)*. Each
accepted request may write one `INFO` line of component `csp-report`,
now with the page's route pattern; `docs/SaaSOperations.md` has the
query and how to read it. **Rolling back** is a revert: the two
directives, the `Reporting-Endpoints` header and the `page` category
go with their tests; the e2e spec, the shared
`tests/e2e/support/dev-page-policy.ts` (its policy goes back into
`security-headers.spec.ts`), the guard's one exception, the
production-mode step, its pinned text and `log-report.mjs`'s required
lines go; `api-changes-pt-7c3.md` and the PT-7c3 lines of the Roadmap,
`API.md`, `SecurityCompliance.md`, `SaaSOperations.md`,
`architecture.md`, the part 2 gap analysis and `TODO.md` go.
