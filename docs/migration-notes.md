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
