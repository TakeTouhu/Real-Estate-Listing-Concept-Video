import type {
  PrismaClient,
  StoryboardScene as DbScene,
  VideoProject as DbProject,
} from "@prisma/client";
import { AppError } from "@app/shared";
import type {
  StoryboardRepositories,
  StoryboardScene,
  TargetOutputResolution,
  VideoProject,
} from "@app/domain";
import { isTargetOutputResolution } from "@app/domain";

/**
 * Narrow the stored output target, or refuse the row.
 *
 * The column is TEXT — Postgres has no product enum here, only the CHECK
 * constraint added in Phase 4C-3B-2B — so this is the boundary where a stored
 * string becomes a domain member. It is a narrowing, never a cast: the domain
 * field is non-nullable, and asserting membership would let a value that
 * predates or evades the constraint travel as though the product had promised
 * it, which is the whole class of bug ADR-0034 exists to remove.
 *
 * There is no repair and no default. Choosing `720p` for an unrecognised value
 * would silently rewrite a customer's stated request, and choosing `1080p`
 * would promise detail nobody agreed to produce. The message names neither the
 * value nor the project.
 */
function toTargetOutputResolution(value: string): TargetOutputResolution {
  if (!isTargetOutputResolution(value)) {
    throw new AppError("INTERNAL_ERROR", "This project records an unrecognised output resolution");
  }
  return value;
}

function toProject(r: DbProject): VideoProject {
  return {
    id: r.id,
    organizationId: r.organizationId,
    propertyId: r.propertyId,
    name: r.name,
    status: r.status,
    durationSeconds: r.durationSeconds,
    aspectRatio: r.aspectRatio,
    targetOutputResolution: toTargetOutputResolution(r.targetOutputResolution),
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

      async update(organizationId, id, changes) {
        // `changes` cannot express propertyId, organizationId, createdAt or
        // updatedAt, so the fields enumerated here are exactly the mutable set;
        // an absent key is `undefined`, which Prisma reads as "leave alone".
        //
        // updateMany scopes the write by organization, so another tenant's row
        // matches nothing rather than being overwritten.
        const changed = await prisma.videoProject.updateMany({
          where: { id, organizationId },
          data: {
            name: changes.name,
            status: changes.status,
            durationSeconds: changes.durationSeconds,
            aspectRatio: changes.aspectRatio,
            targetOutputResolution: changes.targetOutputResolution,
            stylePreset: changes.stylePreset,
            cameraMotion: changes.cameraMotion,
            prompt: changes.prompt,
            negativePrompt: changes.negativePrompt,
            includeMusic: changes.includeMusic,
            includeCaptions: changes.includeCaptions,
            brandTemplateId: changes.brandTemplateId,
            compositionFingerprint: changes.compositionFingerprint,
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
