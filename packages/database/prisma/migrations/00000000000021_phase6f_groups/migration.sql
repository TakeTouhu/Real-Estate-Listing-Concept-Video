-- Phase 6F — groups and group membership (ADR-0060).
--
-- Two tables: an organization's groups, and which of its members belong to
-- each. A group confers no permission and no row access yet (Phase 6G adds
-- group permissions, Phase 6H Property-rooted Scope).
--
-- Both foreign keys of `group_members` carry the organization, so a row can
-- never link a group of one organization to a member of another. Deleting a
-- group, or removing a member from the organization, removes its rows; the
-- audit log keeps the history.
--
-- Additive only. No existing table, column or row is read, updated or deleted,
-- and migrations 0 through 20 are not touched.

-- CreateTable
CREATE TABLE "groups" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "groupId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "addedByUserId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("groupId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "groups_organizationId_name_key" ON "groups"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "groups_id_organizationId_key" ON "groups"("id", "organizationId");

-- CreateIndex
CREATE INDEX "group_members_organizationId_userId_idx" ON "group_members"("organizationId", "userId");

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_groupId_organizationId_fkey" FOREIGN KEY ("groupId", "organizationId") REFERENCES "groups"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_organizationId_userId_fkey" FOREIGN KEY ("organizationId", "userId") REFERENCES "memberships"("organizationId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- A name as the service stores it: trimmed, 1 to 100 characters.
ALTER TABLE "groups"
  ADD CONSTRAINT "groups_name_check"
  CHECK (char_length("name") BETWEEN 1 AND 100 AND "name" = btrim("name"));
