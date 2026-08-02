-- CreateEnum
CREATE TYPE "VideoProjectStatus" AS ENUM ('DRAFT', 'STORYBOARD_READY', 'STORYBOARD_STALE');

-- CreateTable
CREATE TABLE "video_projects" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "VideoProjectStatus" NOT NULL DEFAULT 'DRAFT',
    "durationSeconds" INTEGER NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "stylePreset" TEXT,
    "cameraMotion" TEXT,
    "prompt" TEXT,
    "negativePrompt" TEXT,
    "includeMusic" BOOLEAN NOT NULL DEFAULT false,
    "includeCaptions" BOOLEAN NOT NULL DEFAULT false,
    "brandTemplateId" TEXT,
    "compositionFingerprint" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storyboard_scenes" (
    "id" TEXT NOT NULL,
    "videoProjectId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "roomType" "RoomType",
    "durationSeconds" INTEGER NOT NULL,
    "cameraMotion" TEXT,
    "compiledPrompt" TEXT,
    "sourceAnalysisRevision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storyboard_scenes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_projects_organizationId_propertyId_idx" ON "video_projects"("organizationId", "propertyId");

-- CreateIndex
CREATE INDEX "video_projects_organizationId_status_idx" ON "video_projects"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "video_projects_id_propertyId_key" ON "video_projects"("id", "propertyId");

-- CreateIndex
CREATE INDEX "storyboard_scenes_videoProjectId_idx" ON "storyboard_scenes"("videoProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "storyboard_scenes_videoProjectId_position_key" ON "storyboard_scenes"("videoProjectId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_id_propertyId_key" ON "media_assets"("id", "propertyId");

-- AddForeignKey
ALTER TABLE "video_projects" ADD CONSTRAINT "video_projects_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboard_scenes" ADD CONSTRAINT "storyboard_scenes_videoProjectId_propertyId_fkey" FOREIGN KEY ("videoProjectId", "propertyId") REFERENCES "video_projects"("id", "propertyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboard_scenes" ADD CONSTRAINT "storyboard_scenes_assetId_propertyId_fkey" FOREIGN KEY ("assetId", "propertyId") REFERENCES "media_assets"("id", "propertyId") ON DELETE CASCADE ON UPDATE CASCADE;

