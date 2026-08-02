import { AnalysisService, hasBlockingFlag, isLowConfidence, type AssetAnalysis } from "@app/domain";
import {
  createPrismaAnalysisRepository,
  createPrismaPropertyRepositories,
  createPrismaReviewTransaction,
  getPrismaClient,
} from "@app/database";
import { createImageAnalysisProvider } from "@app/ai-providers";
import { getServerEnv } from "./env";
import { getIdentityServices } from "./identity";
import { getPropertyServices } from "./property";

let service: AnalysisService | undefined;

/**
 * Wire the analysis service. Server-only.
 *
 * Phase 3 ships offline deterministic analysis only (ADR-0009); a real vision
 * vendor would be another `ImageAnalysisProvider` implementation, wired here,
 * with no change to routes or domain code.
 */
export function getAnalysisService(): AnalysisService {
  if (service) return service;
  const identity = getIdentityServices();
  const env = getServerEnv();
  const repos = createPrismaPropertyRepositories(getPrismaClient());

  service = new AnalysisService({
    identity: identity.deps,
    assets: repos.assets,
    analyses: createPrismaAnalysisRepository(getPrismaClient()),
    storage: getPropertyServices().storage,
    provider: createImageAnalysisProvider(env),
    reviewTx: createPrismaReviewTransaction(getPrismaClient()),
    clock: identity.deps.clock,
    ids: identity.deps.ids,
  });
  return service;
}

/**
 * Human-review state, grouped so review concerns stay one cohesive object rather
 * than eight loose fields on the analysis.
 *
 * `reviewedBy` is the reviewer's **user id only**; it is deliberately not
 * expanded into name or email, which would widen this response into a directory
 * lookup and leak more about members than a review client needs.
 */
export interface ReviewDto {
  readonly status: AssetAnalysis["reviewStatus"];
  readonly note: string | null;
  readonly reviewedAt: string | null;
  readonly reviewedBy: string | null;
  readonly analysisRevision: number;
}

/**
 * Public shape of an analysis. Deliberately omits `organizationId` (implied by
 * the authorized request) and `provider` (an internal adapter name). Storage
 * keys are never part of the entity and so cannot leak here.
 */
export interface AnalysisDto {
  readonly id: string;
  readonly assetId: string;
  readonly status: AssetAnalysis["status"];
  readonly roomType: AssetAnalysis["roomType"];
  readonly confidence: number | null;
  readonly qualityScore: number | null;
  readonly brightnessScore: number | null;
  readonly blurScore: number | null;
  readonly duplicateGroup: string | null;
  readonly detectedObjects: AssetAnalysis["detectedObjects"];
  readonly safetyFlags: AssetAnalysis["safetyFlags"];
  readonly suggestedOrder: number | null;
  readonly failureReason: string | null;
  /** Derived server-side so clients cannot diverge on the documented thresholds. */
  readonly lowConfidence: boolean;
  readonly hasBlockingFlag: boolean;
  readonly review: ReviewDto;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toAnalysisDto(analysis: AssetAnalysis): AnalysisDto {
  return {
    id: analysis.id,
    assetId: analysis.assetId,
    status: analysis.status,
    roomType: analysis.roomType,
    confidence: analysis.confidence,
    qualityScore: analysis.qualityScore,
    brightnessScore: analysis.brightnessScore,
    blurScore: analysis.blurScore,
    duplicateGroup: analysis.duplicateGroup,
    detectedObjects: analysis.detectedObjects,
    safetyFlags: analysis.safetyFlags,
    suggestedOrder: analysis.suggestedOrder,
    failureReason: analysis.failureReason,
    lowConfidence: isLowConfidence(analysis),
    hasBlockingFlag: hasBlockingFlag(analysis),
    review: {
      status: analysis.reviewStatus,
      note: analysis.reviewNote,
      reviewedAt: analysis.reviewedAt?.toISOString() ?? null,
      reviewedBy: analysis.reviewedBy,
      analysisRevision: analysis.analysisRevision,
    },
    createdAt: analysis.createdAt.toISOString(),
    updatedAt: analysis.updatedAt.toISOString(),
  };
}
