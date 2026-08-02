import type {
  PrismaClient,
  StoryboardScene as DbScene,
  VideoProject as DbProject,
} from "@prisma/client";
import type {
  StoryboardRepositories,
  StoryboardScene,
  VideoProject,
} from "@app/domain";

function toProject(r: DbProject): VideoProject {
  return {
    id: r.id,
    organizationId: r.organizationId,
    propertyId: r.propertyId,
    name: r.name,
    status: r.status,
    durationSeconds: r.durationSeconds,
    aspectRatio: r.aspectRatio,
    resolution: r.resolution,
    stylePreset: r.stylePreset,
    cameraMotion: r.cameraMotion,
    prompt: r.prompt,
    negativePrompt: r.negativePrompt,
    includeMusic: r.includeMusic,
    includeCaptions: r.includeCaptions,
    brandTemplateId: r.brandTemplateId,
    compositionFingerprint: r.compositionFingerprint,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toScene(r: DbScene): StoryboardScene {
  return {
    id: r.id,
    videoProjectId: r.videoProjectId,
    propertyId: r.propertyId,
    assetId: r.assetId,
    position: r.position,
    roomType: r.roomType,
    durationSeconds: r.durationSeconds,
    cameraMotion: r.cameraMotion,
    compiledPrompt: r.compiledPrompt,
    sourceAnalysisRevision: r.sourceAnalysisRevision,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Prisma-backed storyboard persistence.
 *
 * Scenes carry no organization column, so their tenant scope is resolved
 * through the owning project on every read — `videoProject: { organizationId }`
 * is a join predicate, not an application-side check that could be forgotten.
 * Writes are additionally protected by the composite foreign keys on
 * `(videoProjectId, propertyId)` and `(assetId, propertyId)`: a scene mixing
 * two properties, and therefore two tenants, cannot be inserted at all.
 */
export function createPrismaStoryboardRepositories(
  prisma: PrismaClient,
): StoryboardRepositories {
  return {
    projects: {
      async create(input) {
        return toProject(await prisma.videoProject.create({ data: input }));
      },

      async findById(organizationId, id) {
        const row = await prisma.videoProject.findFirst({ where: { id, organizationId } });
        return row ? toProject(row) : null;
      },

      async listByProperty(organizationId, propertyId) {
        const rows = await prisma.videoProject.findMany({
          where: { organizationId, propertyId },
          orderBy: { createdAt: "asc" },
        });
        return rows.map(toProject);
      },

      async update(project) {
        const { id, organizationId } = project;
        // Mutable fields only, enumerated: `propertyId` never moves, and
        // `updatedAt` is left to Prisma's @updatedAt rather than being written
        // back from a possibly stale in-memory copy.
        //
        // updateMany scopes the write by organization, so another tenant's row
        // matches nothing rather than being overwritten.
        const changed = await prisma.videoProject.updateMany({
          where: { id, organizationId },
          data: {
            name: project.name,
            status: project.status,
            durationSeconds: project.durationSeconds,
            aspectRatio: project.aspectRatio,
            resolution: project.resolution,
            stylePreset: project.stylePreset,
            cameraMotion: project.cameraMotion,
            prompt: project.prompt,
            negativePrompt: project.negativePrompt,
            includeMusic: project.includeMusic,
            includeCaptions: project.includeCaptions,
            brandTemplateId: project.brandTemplateId,
            compositionFingerprint: project.compositionFingerprint,
          },
        });
        if (changed.count === 0) throw new Error(`video project ${id} not found`);
        const row = await prisma.videoProject.findFirstOrThrow({ where: { id, organizationId } });
        return toProject(row);
      },
    },

    scenes: {
      async listByProject(organizationId, videoProjectId) {
        const rows = await prisma.storyboardScene.findMany({
          where: { videoProjectId, videoProject: { organizationId } },
          orderBy: { position: "asc" },
        });
        return rows.map(toScene);
      },

      async replaceForProject(organizationId, videoProjectId, scenes) {
        const project = await prisma.videoProject.findFirst({
          where: { id: videoProjectId, organizationId },
        });
        if (!project) throw new Error(`video project ${videoProjectId} not found`);
        return prisma.$transaction(async (tx) => {
          await tx.storyboardScene.deleteMany({ where: { videoProjectId } });
          for (const scene of scenes) {
            await tx.storyboardScene.create({ data: scene });
          }
          const rows = await tx.storyboardScene.findMany({
            where: { videoProjectId },
            orderBy: { position: "asc" },
          });
          return rows.map(toScene);
        });
      },
    },
  };
}
