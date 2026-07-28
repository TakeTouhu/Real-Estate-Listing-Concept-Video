-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "RoomType" AS ENUM ('LIVING_ROOM', 'DINING_ROOM', 'KITCHEN', 'BEDROOM', 'CHILD_ROOM', 'STUDY', 'BATHROOM', 'WASHROOM', 'TOILET', 'ENTRANCE', 'HALLWAY', 'BALCONY', 'STORAGE', 'EXTERIOR', 'OTHER');

-- CreateTable
CREATE TABLE "asset_analyses" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "roomType" "RoomType",
    "confidence" DOUBLE PRECISION,
    "qualityScore" DOUBLE PRECISION,
    "brightnessScore" DOUBLE PRECISION,
    "blurScore" DOUBLE PRECISION,
    "duplicateGroup" TEXT,
    "detectedObjects" JSONB NOT NULL DEFAULT '[]',
    "safetyFlags" JSONB NOT NULL DEFAULT '[]',
    "suggestedOrder" INTEGER,
    "failureReason" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "asset_analyses_assetId_key" ON "asset_analyses"("assetId");

-- CreateIndex
CREATE INDEX "asset_analyses_organizationId_status_idx" ON "asset_analyses"("organizationId", "status");

-- CreateIndex
CREATE INDEX "asset_analyses_organizationId_duplicateGroup_idx" ON "asset_analyses"("organizationId", "duplicateGroup");

-- AddForeignKey
ALTER TABLE "asset_analyses" ADD CONSTRAINT "asset_analyses_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

