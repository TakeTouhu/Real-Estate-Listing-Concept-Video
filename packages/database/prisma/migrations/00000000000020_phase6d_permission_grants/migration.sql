-- Phase 6D — individual permission grants (ADR-0058).
--
-- One table: a permission granted to one member on top of its role template.
-- Removing the membership removes its grants; the audit log keeps the history.
--
-- Additive only. No existing table, column or row is read, updated or deleted,
-- and migrations 0 through 19 are not touched.

-- CreateTable
CREATE TABLE "member_permission_grants" (
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_permission_grants_pkey" PRIMARY KEY ("organizationId","userId","permission")
);

-- AddForeignKey
ALTER TABLE "member_permission_grants" ADD CONSTRAINT "member_permission_grants_organizationId_userId_fkey" FOREIGN KEY ("organizationId", "userId") REFERENCES "memberships"("organizationId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only the grantable vocabulary: the ADR-0052 permissions except `video.share`,
-- which is reserved for after the initial release (ADR-0052 Decision 12).
ALTER TABLE "member_permission_grants"
  ADD CONSTRAINT "member_permission_grants_permission_check"
  CHECK ("permission" IN (
    'organization.view', 'organization.manage',
    'member.view', 'member.manage',
    'group.view', 'group.manage',
    'permission.manage',
    'property.view', 'property.create', 'property.edit', 'property.delete',
    'asset.upload', 'asset.delete',
    'analysis.review',
    'video.view', 'video.generate', 'video.regenerate', 'video.download',
    'disclosure.change', 'disclosure.none',
    'unit.consume', 'unit.view',
    'billing.view', 'billing.manage',
    'audit.view', 'audit.export'
  ));
