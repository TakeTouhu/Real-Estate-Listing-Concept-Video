import type { AssetAnalysis as DbAssetAnalysis, PrismaClient, Prisma } from "@prisma/client";
import type {
  AssetAnalysis,
  AssetAnalysisRepository,
  DetectedObject,
  SafetyFlag,
} from "@app/domain";

function toAnalysis(r: DbAssetAnalysis): AssetAnalysis {
  return {
    id: r.id,
    organizationId: r.organizationId,
    assetId: r.assetId,
    provider: r.provider,
    status: r.status,
    roomType: r.roomType,
    confidence: r.confidence,
    qualityScore: r.qualityScore,
    brightnessScore: r.brightnessScore,
    blurScore: r.blurScore,
    duplicateGroup: r.duplicateGroup,
    detectedObjects: (r.detectedObjects ?? []) as unknown as readonly DetectedObject[],
    safetyFlags: (r.safetyFlags ?? []) as unknown as readonly SafetyFlag[],
    suggestedOrder: r.suggestedOrder,
    failureReason: r.failureReason,
    analysisRevision: r.analysisRevision,
    reviewStatus: r.reviewStatus,
    reviewNote: r.reviewNote,
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Prisma-backed analysis repository. Every read filters on `organizationId`, so
 * a row belonging to another tenant is simply not found — tenant isolation is
 * enforced in the data-access layer, not only in the service above it.
 */
export function createPrismaAnalysisRepository(prisma: PrismaClient): AssetAnalysisRepository {
  return {
    async create(input) {
      return toAnalysis(
        await prisma.assetAnalysis.create({
          data: {
            id: input.id,
            organizationId: input.organizationId,
            assetId: input.assetId,
            provider: input.provider,
            status: input.status,
            roomType: input.roomType,
            confidence: input.confidence,
            qualityScore: input.qualityScore,
            brightnessScore: input.brightnessScore,
            blurScore: input.blurScore,
            duplicateGroup: input.duplicateGroup,
            detectedObjects: input.detectedObjects as unknown as Prisma.InputJsonValue,
            safetyFlags: input.safetyFlags as unknown as Prisma.InputJsonValue,
            suggestedOrder: input.suggestedOrder,
            failureReason: input.failureReason,
            analysisRevision: input.analysisRevision,
            reviewStatus: input.reviewStatus,
            reviewNote: input.reviewNote,
            reviewedBy: input.reviewedBy,
            reviewedAt: input.reviewedAt,
          },
        }),
      );
    },
    async findById(organizationId, id) {
      const row = await prisma.assetAnalysis.findFirst({ where: { id, organizationId } });
      return row ? toAnalysis(row) : null;
    },
    async findByAssetId(organizationId, assetId) {
      const row = await prisma.assetAnalysis.findFirst({ where: { assetId, organizationId } });
      return row ? toAnalysis(row) : null;
    },
    async listByAssetIds(organizationId, assetIds) {
      if (assetIds.length === 0) return [];
      return (
        await prisma.assetAnalysis.findMany({
          where: { organizationId, assetId: { in: [...assetIds] } },
          orderBy: { createdAt: "asc" },
        })
      ).map(toAnalysis);
    },
    async update(analysis) {
      return toAnalysis(
        await prisma.assetAnalysis.update({
          where: { id: analysis.id },
          data: {
            status: analysis.status,
            roomType: analysis.roomType,
            confidence: analysis.confidence,
            qualityScore: analysis.qualityScore,
            brightnessScore: analysis.brightnessScore,
            blurScore: analysis.blurScore,
            duplicateGroup: analysis.duplicateGroup,
            detectedObjects: analysis.detectedObjects as unknown as Prisma.InputJsonValue,
            safetyFlags: analysis.safetyFlags as unknown as Prisma.InputJsonValue,
            suggestedOrder: analysis.suggestedOrder,
            failureReason: analysis.failureReason,
            analysisRevision: analysis.analysisRevision,
            reviewStatus: analysis.reviewStatus,
            reviewNote: analysis.reviewNote,
            reviewedBy: analysis.reviewedBy,
            reviewedAt: analysis.reviewedAt,
          },
        }),
      );
    },
  };
}
