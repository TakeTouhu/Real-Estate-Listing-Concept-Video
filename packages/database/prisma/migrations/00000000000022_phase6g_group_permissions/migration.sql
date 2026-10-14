-- Phase 6G — group permissions (ADR-0061).
--
-- One table: a permission a group carries for every one of its members, on top
-- of their role templates and individual grants. Deleting the group removes its
-- rows; the audit log keeps the history.
--
-- The foreign key carries the organization, so a row always belongs to its
-- group's organization.
--
-- Additive only. No existing table, column or row is read, updated or deleted,
-- and migrations 0 through 21 are not touched.

-- CreateTable
CREATE TABLE "group_permissions" (
    "groupId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_permissions_pkey" PRIMARY KEY ("groupId","permission")
);

-- AddForeignKey
ALTER TABLE "group_permissions" ADD CONSTRAINT "group_permissions_groupId_organizationId_fkey" FOREIGN KEY ("groupId", "organizationId") REFERENCES "groups"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only the grantable vocabulary less `disclosure.none`, which only an `OWNER`
-- grants and only to an individual (ADR-0052 Decision 10), and less
-- `video.share`, reserved for after the initial release (ADR-0052 Decision 12).
ALTER TABLE "group_permissions"
  ADD CONSTRAINT "group_permissions_permission_check"
  CHECK ("permission" IN (
    'organization.view', 'organization.manage',
    'member.view', 'member.manage',
    'group.view', 'group.manage',
    'permission.manage',
    'property.view', 'property.create', 'property.edit', 'property.delete',
    'asset.upload', 'asset.delete',
    'analysis.review',
    'video.view', 'video.generate', 'video.regenerate', 'video.download',
    'disclosure.change',
    'unit.consume', 'unit.view',
    'billing.view', 'billing.manage',
    'audit.view', 'audit.export'
  ));
