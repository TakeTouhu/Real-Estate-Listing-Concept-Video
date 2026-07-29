-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('UNREVIEWED', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "asset_analyses" ADD COLUMN     "analysisRevision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'UNREVIEWED';

-- CreateIndex
CREATE INDEX "asset_analyses_organizationId_reviewStatus_idx" ON "asset_analyses"("organizationId", "reviewStatus");


-- Hand-written: Prisma cannot express a partial index in schema.prisma, so this
-- constraint is added directly. It makes the database authoritative for
-- "at most one APPROVED analysis per duplicate group", which is what makes
-- concurrent approvals of two members of the same group safe: the loser gets a
-- unique violation rather than a second approved primary.
-- Rows with a NULL duplicateGroup are unconstrained (no duplicate siblings).
CREATE UNIQUE INDEX "asset_analyses_org_dupgroup_approved_key"
  ON "asset_analyses" ("organizationId", "duplicateGroup")
  WHERE "duplicateGroup" IS NOT NULL AND "reviewStatus" = 'APPROVED';
