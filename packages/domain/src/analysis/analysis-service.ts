import { AppError } from "@app/shared";
import { recordAudit } from "../identity/audit";
import { authorizeOrganization } from "../identity/authorization";
import type { Clock, IdentityServiceDeps, IdGenerator } from "../identity/ports";
import type { MediaAssetRepository, ObjectStorage } from "../property/ports";
import type { MediaAsset } from "../property/types";
import { AnalysisAuditAction } from "./audit";
import { deriveQualityFlags } from "./normalization";
import type { AssetAnalysisRepository, ImageAnalysisProvider } from "./ports";
import type { AssetAnalysis, SafetyFlag } from "./types";

export interface AnalysisServiceDeps {
  /** Supplies membership lookup (authorization) and the audit sink. */
  readonly identity: IdentityServiceDeps;
  readonly assets: MediaAssetRepository;
  readonly analyses: AssetAnalysisRepository;
  readonly storage: ObjectStorage;
  readonly provider: ImageAnalysisProvider;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * Analysis orchestration.
 *
 * Consistency model — every write is a single-row transition, so there is no
 * partially-updated state to unwind:
 *
 * - A row is reserved as `PENDING` *before* the provider is called, so a crash
 *   leaves a visible PENDING row rather than nothing at all.
 * - A provider failure transitions that row to `FAILED`; it can never produce a
 *   `SUCCEEDED` record.
 * - The terminal row is persisted *before* its audit entry is written. If the
 *   audit sink fails, the error propagates (it is never swallowed) while the
 *   persisted analysis is already in a consistent terminal state.
 * - If a repository write fails, the row keeps its previous status and the error
 *   surfaces. Re-running the request resumes from that status.
 * - Retries converge: an existing `SUCCEEDED` row is returned untouched, and a
 *   `PENDING`/`FAILED` row is reused rather than duplicated, so repeated
 *   requests yield the same persisted result.
 */
export class AnalysisService {
  constructor(private readonly deps: AnalysisServiceDeps) {}

  /**
   * Analyze one READY asset. Safe to call repeatedly: at most one analysis row
   * exists per asset, and a completed analysis is never recomputed.
   */
  async analyzeAsset(
    actorUserId: string,
    organizationId: string,
    assetId: string,
  ): Promise<AssetAnalysis> {
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "property:write");
    const asset = await this.requireEligibleAsset(organizationId, assetId);

    const reserved = await this.reserve(organizationId, assetId);
    if (reserved.status === "SUCCEEDED") return reserved;

    await recordAudit(this.deps.identity, {
      organizationId,
      actorUserId,
      action: AnalysisAuditAction.AnalysisRequested,
      resourceType: "asset_analysis",
      resourceId: reserved.id,
      metadata: { assetId, provider: this.deps.provider.name },
    });

    const bytes = await this.deps.storage.getObject(asset.storageKey);
    if (!bytes) {
      return this.fail(actorUserId, reserved, "Stored image could not be read for analysis");
    }

    let result;
    try {
      result = await this.deps.provider.analyze({
        assetId,
        imageBytes: bytes,
        mimeType: asset.mimeType ?? "application/octet-stream",
        width: asset.width ?? 0,
        height: asset.height ?? 0,
        perceptualHash: asset.perceptualHash,
      });
    } catch (error) {
      // Normalized so no vendor payload reaches storage, logs, or customers.
      const normalized = this.deps.provider.normalizeError(error);
      return this.fail(actorUserId, reserved, normalized.messageSanitized);
    }

    const safetyFlags = mergeFlags(
      result.safetyFlags,
      deriveQualityFlags({
        width: asset.width ?? 0,
        height: asset.height ?? 0,
        blurScore: result.blurScore,
        brightnessScore: result.brightnessScore,
      }),
    );

    // Single terminal write; if it throws, the row stays PENDING and a retry
    // recomputes the same values.
    const succeeded = await this.deps.analyses.update({
      ...reserved,
      status: "SUCCEEDED",
      roomType: result.roomType,
      confidence: result.confidence,
      qualityScore: result.qualityScore,
      brightnessScore: result.brightnessScore,
      blurScore: result.blurScore,
      detectedObjects: result.detectedObjects,
      safetyFlags,
      failureReason: null,
      updatedAt: this.deps.clock.now(),
    });

    await recordAudit(this.deps.identity, {
      organizationId,
      actorUserId,
      action: AnalysisAuditAction.AnalysisSucceeded,
      resourceType: "asset_analysis",
      resourceId: succeeded.id,
      metadata: {
        assetId,
        roomType: succeeded.roomType,
        blockingFlags: safetyFlags.filter((f) => f.severity === "BLOCKING").length,
        warningFlags: safetyFlags.filter((f) => f.severity === "WARNING").length,
      },
    });
    return succeeded;
  }

  /**
   * Obtain the row to work on: an existing SUCCEEDED row (returned as-is by the
   * caller), or one reserved as PENDING.
   *
   * The unique index on `assetId` is the concurrency control. When two requests
   * race, the loser's insert is rejected and it adopts the winner's row instead
   * of creating a second one.
   */
  private async reserve(organizationId: string, assetId: string): Promise<AssetAnalysis> {
    const existing = await this.deps.analyses.findByAssetId(organizationId, assetId);
    if (existing) {
      if (existing.status === "SUCCEEDED") return existing;
      return this.deps.analyses.update({
        ...existing,
        status: "PENDING",
        failureReason: null,
        updatedAt: this.deps.clock.now(),
      });
    }

    try {
      return await this.deps.analyses.create({
        id: this.deps.ids.generate("ana"),
        organizationId,
        assetId,
        provider: this.deps.provider.name,
        status: "PENDING",
        roomType: null,
        confidence: null,
        qualityScore: null,
        brightnessScore: null,
        blurScore: null,
        duplicateGroup: null,
        detectedObjects: [],
        safetyFlags: [],
        suggestedOrder: null,
        failureReason: null,
        reviewedBy: null,
        reviewedAt: null,
      });
    } catch (error) {
      const concurrent = await this.deps.analyses.findByAssetId(organizationId, assetId);
      // No row appeared, so this was not a uniqueness conflict: surface it.
      if (!concurrent) throw error;
      return concurrent;
    }
  }

  /** Only READY assets are eligible; anything else is rejected explicitly. */
  private async requireEligibleAsset(
    organizationId: string,
    assetId: string,
  ): Promise<MediaAsset> {
    const asset = await this.deps.assets.findById(organizationId, assetId);
    if (!asset || asset.status === "DELETED") {
      throw new AppError("NOT_FOUND", "Asset not found");
    }
    if (asset.status !== "READY") {
      throw new AppError(
        "VALIDATION_FAILED",
        `Only READY assets can be analyzed (asset is ${asset.status})`,
      );
    }
    return asset;
  }

  /**
   * Record a terminal failure. The row is persisted as FAILED before the audit
   * entry, so an audit-sink error leaves a consistent, retryable row.
   */
  private async fail(
    actorUserId: string,
    analysis: AssetAnalysis,
    reason: string,
  ): Promise<AssetAnalysis> {
    const failed = await this.deps.analyses.update({
      ...analysis,
      status: "FAILED",
      failureReason: reason,
      updatedAt: this.deps.clock.now(),
    });
    await recordAudit(this.deps.identity, {
      organizationId: analysis.organizationId,
      actorUserId,
      action: AnalysisAuditAction.AnalysisFailed,
      resourceType: "asset_analysis",
      resourceId: analysis.id,
      metadata: { assetId: analysis.assetId, reason },
    });
    return failed;
  }
}

/** Keep the most severe occurrence of each flag code. */
function mergeFlags(
  provider: readonly SafetyFlag[],
  derived: readonly SafetyFlag[],
): SafetyFlag[] {
  const seen = new Map<string, SafetyFlag>();
  for (const flag of [...provider, ...derived]) {
    const existing = seen.get(flag.code);
    if (!existing || (existing.severity === "WARNING" && flag.severity === "BLOCKING")) {
      seen.set(flag.code, flag);
    }
  }
  return [...seen.values()];
}
