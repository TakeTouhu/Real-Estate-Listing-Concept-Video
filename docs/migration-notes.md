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

Verified for this branch: **no drift** — the combined migrations reproduce the
schema exactly (207 non-empty DDL lines on both sides).

With a reachable shadow database, the canonical check is:

```bash
pnpm exec prisma migrate diff --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" --exit-code
```

## Operational notes

- Storage objects are **not** managed by migrations. Physical deletion of
  objects for assets in `DELETION_PENDING` is the retention job's job
  (Phase 7, not implemented).
- Audit and billing retention differ from customer-data retention; audit rows
  survive organization deletion because `audit_logs.organizationId` is
  `ON DELETE SET NULL`.
- No seed data is committed. Accounts are created through `/api/auth/register`.
