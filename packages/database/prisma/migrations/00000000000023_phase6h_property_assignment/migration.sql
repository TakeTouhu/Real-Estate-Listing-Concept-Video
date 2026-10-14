-- Phase 6H — Property assignment (ADR-0062).
--
-- Two nullable columns on "properties": the responsible user, for `OWN` reach,
-- and the group, for `GROUP` reach (ADR-0052 Decision 10). Both start unset on
-- every existing row.
--
-- Each foreign key carries the organization, so a Property can only ever name a
-- member, or a group, of its own organization. Both refuse deletion (NO
-- ACTION): a group deletion or a member's removal releases the assignment
-- itself, in its own transaction, and records how many it released.
--
-- Additive only. No existing row is updated or deleted, and migrations 0
-- through 22 are not touched.

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "responsibleUserId" TEXT;

-- CreateIndex
CREATE INDEX "properties_organizationId_responsibleUserId_idx" ON "properties"("organizationId", "responsibleUserId");

-- CreateIndex
CREATE INDEX "properties_groupId_idx" ON "properties"("groupId");

-- AddForeignKey
ALTER TABLE "properties" ADD CONSTRAINT "properties_organizationId_responsibleUserId_fkey" FOREIGN KEY ("organizationId", "responsibleUserId") REFERENCES "memberships"("organizationId", "userId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "properties" ADD CONSTRAINT "properties_groupId_organizationId_fkey" FOREIGN KEY ("groupId", "organizationId") REFERENCES "groups"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;
