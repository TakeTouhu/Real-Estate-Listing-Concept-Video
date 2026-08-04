import { AppError } from "@app/shared";
import { recordAudit } from "../identity/audit";
import { authorizeOrganization } from "../identity/authorization";
import type { Clock, IdentityServiceDeps, IdGenerator } from "../identity/ports";
import type { MediaAssetRepository, ObjectStorage } from "../property/ports";
import type { MediaAsset } from "../property/types";
import { AnalysisAuditAction } from "./audit";
import { deriveQualityFlags } from "./normalization";
import {
  DuplicateApprovalConflictError,
  type AssetAnalysisRepository,
  type ImageAnalysisProvider,
  type ReviewTransaction,
} from "./ports";
import { resolveDuplicateGroup, roomOrderRank, type DuplicateCandidate } from "./rules";
import { hasBlockingFlag, type ApproveInput, type AssetAnalysis, type RejectInput, type SafetyFlag } from "./types";

export interface AnalyzeOptions {
  /** Recompute an analysis that already SUCCEEDED, reusing the same row. */
  readonly refresh?: boolean;
}

export interface AnalysisServiceDeps {
  /** Supplies membership lookup (authorization) and the audit sink. */
  readonly identity: IdentityServiceDeps;
  readonly assets: MediaAssetRepository;
  readonly analyses: AssetAnalysisRepository;
  readonly storage: ObjectStorage;
  readonly provider: ImageAnalysisProvider;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Spans the two writes a rejection makes; see ReviewTransaction. */
  readonly reviewTx: ReviewTransaction;
}

/**
 * Analysis orchestration.
 *
 * Consistency model. This is **not** transactional atomicity: it is
 * failure-consistent, retry-safe, and idempotent at the persisted
 * analysis-row level. Every write is a single-row transition, so there is no
 * partially-updated row to unwind.
 *
 * - A row is reserved as `PENDING` *before* the provider is called, so a crash
 *   leaves a visible PENDING row rather than nothing at all.
 * - A provider failure transitions that row to `FAILED`; it can never produce a
 *   `SUCCEEDED` record.
 * - If a repository write fails, the row keeps its previous status and the error
 *   surfaces. Re-running the request resumes from that status.
 * - Retries converge: an existing `SUCCEEDED` row is returned untouched, and a
 *   `PENDING`/`FAILED` row is reused rather than duplicated, so repeated
 *   requests yield the same persisted result.
 *
 * Audit consistency boundary — intentional, and not atomic. The terminal row is
 * persisted *before* its audit entry. If the audit sink then fails, the error
 * propagates to the caller (it is never swallowed) but **the analysis row
 * remains `SUCCEEDED`**, so that transition may end up without an audit entry.
 * The ordering is deliberate: the alternative discards a completed analysis
 * because of a logging outage. Making the two writes atomic requires a shared
 * database transaction spanning both rows, or a transactional outbox — see
 * `docs/decisions/TODO.md`.
 */
export class AnalysisService {
  constructor(private readonly deps: AnalysisServiceDeps) {}

  /**
   * Analyze one READY asset. Safe to call repeatedly: at most one analysis row
   * exists per asset, and a completed analysis is never recomputed unless
   * `refresh` is requested.
   */
  async analyzeAsset(
    actorUserId: string,
    organizationId: string,
    assetId: string,
    options: AnalyzeOptions = {},
  ): Promise<AssetAnalysis> {
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "property:write");
    const asset = await this.requireEligibleAsset(organizationId, assetId);

    const refresh = options.refresh === true;
    const reserved = await this.reserve(organizationId, assetId, refresh);
    if (reserved.status === "SUCCEEDED") return reserved;

    await recordAudit(this.deps.identity, {
      organizationId,
      actorUserId,
      action: refresh
        ? AnalysisAuditAction.AnalysisRefreshed
        : AnalysisAuditAction.AnalysisRequested,
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

    const duplicateGroup = resolveDuplicateGroup(
      asset.perceptualHash,
      assetId,
      await this.duplicateCandidates(organizationId, assetId),
    );

    // Single terminal write; if it throws, the row stays PENDING and a retry
    // recomputes the same values.
    //
    // The revision advances here and only here, keyed on `refresh` rather than
    // on the row reaching SUCCEEDED: an initial analysis and a refresh both end
    // in SUCCEEDED, and only the latter is a new result superseding an old one.
    // A refresh that fails never reaches this write, so it leaves the revision
    // untouched.
    const succeeded = await this.deps.analyses.update({
      ...reserved,
      analysisRevision: refresh ? reserved.analysisRevision + 1 : reserved.analysisRevision,
      status: "SUCCEEDED",
      roomType: result.roomType,
      confidence: result.confidence,
      qualityScore: result.qualityScore,
      brightnessScore: result.brightnessScore,
      blurScore: result.blurScore,
      duplicateGroup,
      detectedObjects: result.detectedObjects,
      safetyFlags,
      suggestedOrder: roomOrderRank(result.roomType),
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
   * caller, unless refreshing), or one reserved as PENDING.
   *
   * The unique index on `assetId` is the concurrency control. When two requests
   * race, the loser's insert is rejected and it adopts the winner's row instead
   * of creating a second one.
   */
  private async reserve(
    organizationId: string,
    assetId: string,
    refresh: boolean,
  ): Promise<AssetAnalysis> {
    const existing = await this.deps.analyses.findByAssetId(organizationId, assetId);
    if (existing) {
      if (existing.status === "SUCCEEDED" && !refresh) return existing;
      // Stale result, review *and* correction fields are cleared as the row is
      // reserved, so a refresh that then fails cannot leave last run's values
      // behind on a FAILED row, and cannot leave a decision — or a human
      // correction — attached to a result that no longer exists. A correction
      // belongs to the revision it was made against: once the analyzer has been
      // re-run, "this is a bathroom, not a kitchen" is a statement about a
      // classification that no longer exists (ADR-0015). The revision itself is
      // not touched here — it advances only on a successful terminal write.
      return this.deps.analyses.update({
        ...existing,
        status: "PENDING",
        reviewStatus: "UNREVIEWED",
        reviewNote: null,
        reviewedBy: null,
        reviewedAt: null,
        roomTypeOverride: null,
        orderOverride: null,
        correctedBy: null,
        correctedAt: null,
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
        roomTypeOverride: null,
        orderOverride: null,
        correctedBy: null,
        correctedAt: null,
        analysisRevision: 1,
        reviewStatus: "UNREVIEWED",
        reviewNote: null,
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

  /**
   * Analyses for a property's assets. Read-level authorization: any member of
   * the organization may read, including REVIEWER, who cannot start an analysis.
   */
  async listForProperty(
    actorUserId: string,
    organizationId: string,
    propertyId: string,
  ): Promise<AssetAnalysis[]> {
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId);
    const assets = await this.deps.assets.listByProperty(organizationId, propertyId);
    return this.deps.analyses.listByAssetIds(
      organizationId,
      assets.map((a) => a.id),
    );
  }

  /** One asset's analysis, organization-scoped. Read-level authorization. */
  async getForAsset(
    actorUserId: string,
    organizationId: string,
    assetId: string,
  ): Promise<AssetAnalysis> {
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId);
    const analysis = await this.deps.analyses.findByAssetId(organizationId, assetId);
    if (!analysis) throw new AppError("NOT_FOUND", "Analysis not found for this asset");
    return analysis;
  }

  /**
   * Siblings eligible for duplicate comparison: same organization, carrying a
   * perceptual hash, excluding the subject asset. Both the asset lookup and the
   * analysis lookup are organization-scoped, so another tenant's photo can never
   * influence a duplicate group.
   */
  private async duplicateCandidates(
    organizationId: string,
    selfAssetId: string,
  ): Promise<DuplicateCandidate[]> {
    const hashed = await this.deps.assets.listWithPerceptualHash(organizationId);
    const siblings = hashed.filter((a) => a.id !== selfAssetId);
    const analyses = await this.deps.analyses.listByAssetIds(
      organizationId,
      siblings.map((a) => a.id),
    );
    const groups = new Map(analyses.map((a) => [a.assetId, a.duplicateGroup]));
    return siblings.map((a) => ({
      assetId: a.id,
      perceptualHash: a.perceptualHash,
      duplicateGroup: groups.get(a.id) ?? null,
    }));
  }


  /**
   * Approve one analysis revision.
   *
   * The decision is immutable for the revision it is made against: a row that
   * already carries a decision is refused, and only a refresh (which clears the
   * review state and starts a new revision) makes the asset reviewable again.
   *
   * Duplicate groups are a soft block. When the asset's group has more than one
   * member the caller must name `primaryAssetId`, and it must be this asset —
   * the reviewer chooses the primary rather than approving by accident. Whether
   * another member is *already* approved is decided by the PostgreSQL partial
   * unique index on `(organizationId, duplicateGroup) WHERE reviewStatus =
   * 'APPROVED'`, not by a read here: a pre-check would be a check-then-act race.
   */
  async approve(
    actorUserId: string,
    organizationId: string,
    assetId: string,
    input: ApproveInput = {},
  ): Promise<AssetAnalysis> {
    const { analysis, asset } = await this.requireReviewable(
      actorUserId,
      organizationId,
      assetId,
    );
    if (hasBlockingFlag(analysis)) {
      throw new AppError(
        "VALIDATION_FAILED",
        "An analysis with a blocking safety finding cannot be approved; reject it instead",
      );
    }
    await this.requirePrimaryChoice(organizationId, analysis, assetId, input.primaryAssetId);

    const reason = optionalReason(input.reason);
    const approved = await this.writeDecision(analysis, "APPROVED", reason, actorUserId);
    await this.recordDecision(
      AnalysisAuditAction.AnalysisApproved,
      actorUserId,
      approved,
      asset,
      reason,
    );
    return approved;
  }

  /**
   * Reject one analysis revision and mark its asset `REJECTED`, so downstream
   * generation excludes it through the existing status checks rather than a
   * parallel rule.
   *
   * Both writes go through {@link ReviewTransaction}: they commit together or
   * not at all. The audit entry is deliberately outside that boundary — see the
   * class-level note and `docs/decisions/TODO.md`.
   */
  async reject(
    actorUserId: string,
    organizationId: string,
    assetId: string,
    input: RejectInput,
  ): Promise<AssetAnalysis> {
    const { analysis, asset } = await this.requireReviewable(
      actorUserId,
      organizationId,
      assetId,
    );
    const reason = (input.reason ?? "").trim();
    if (reason.length === 0) {
      throw new AppError("VALIDATION_FAILED", "A rejection reason is required");
    }

    const now = this.deps.clock.now();
    const rejected = await this.deps.reviewTx.run(async ({ analyses, assets }) => {
      const updated = await analyses.update({
        ...analysis,
        reviewStatus: "REJECTED",
        reviewNote: reason,
        reviewedBy: actorUserId,
        reviewedAt: now,
        updatedAt: now,
      });
      await assets.update({ ...asset, status: "REJECTED", updatedAt: now });
      return updated;
    });

    await this.recordDecision(
      AnalysisAuditAction.AnalysisRejected,
      actorUserId,
      rejected,
      asset,
      reason,
    );
    return rejected;
  }

  /** Authorize the reviewer and load an analysis that is eligible for a decision. */
  private async requireReviewable(
    actorUserId: string,
    organizationId: string,
    assetId: string,
  ): Promise<{ analysis: AssetAnalysis; asset: MediaAsset }> {
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "video:review");
    const analysis = await this.deps.analyses.findByAssetId(organizationId, assetId);
    if (!analysis) throw new AppError("NOT_FOUND", "Analysis not found for this asset");
    if (analysis.status !== "SUCCEEDED") {
      throw new AppError(
        "VALIDATION_FAILED",
        `Only a completed analysis can be reviewed (analysis is ${analysis.status})`,
      );
    }
    if (analysis.reviewStatus !== "UNREVIEWED") {
      throw new AppError(
        "VALIDATION_FAILED",
        "This analysis revision has already been reviewed; refresh the analysis to review it again",
      );
    }
    const asset = await this.deps.assets.findById(organizationId, assetId);
    if (!asset) throw new AppError("NOT_FOUND", "Asset not found");
    return { analysis, asset };
  }

  /**
   * A multi-member duplicate group requires the reviewer to name the primary,
   * and it must be the asset being approved. Only the group's membership is
   * read here; whether a member is already approved is the database's call.
   */
  private async requirePrimaryChoice(
    organizationId: string,
    analysis: AssetAnalysis,
    assetId: string,
    primaryAssetId: string | undefined,
  ): Promise<void> {
    if (!analysis.duplicateGroup) return;
    const members = await this.duplicateGroupMembers(organizationId, analysis.duplicateGroup);
    if (members.length < 2) return;

    if (!primaryAssetId) {
      throw new AppError(
        "VALIDATION_FAILED",
        "This photo has near-duplicates; choose the primary asset before approving",
      );
    }
    if (primaryAssetId !== assetId) {
      throw new AppError(
        "VALIDATION_FAILED",
        "primaryAssetId must be the asset being approved",
      );
    }
  }

  /** Analyses sharing a duplicate group, organization-scoped. */
  private async duplicateGroupMembers(
    organizationId: string,
    duplicateGroup: string,
  ): Promise<AssetAnalysis[]> {
    const hashed = await this.deps.assets.listWithPerceptualHash(organizationId);
    const analyses = await this.deps.analyses.listByAssetIds(
      organizationId,
      hashed.map((a) => a.id),
    );
    return analyses.filter((a) => a.duplicateGroup === duplicateGroup);
  }

  /**
   * Persist a decision, turning the repository's neutral duplicate-group
   * conflict into a validation failure. Recognizing the underlying constraint
   * violation is the adapter's job, so no database vocabulary reaches here.
   *
   * The conflict is never retried or reconciled: unlike the insert race in
   * `reserve`, losing this one means another member is already the approved
   * primary, which is a decision for the reviewer, not the system.
   */
  private async writeDecision(
    analysis: AssetAnalysis,
    reviewStatus: "APPROVED" | "REJECTED",
    reason: string | null,
    actorUserId: string,
  ): Promise<AssetAnalysis> {
    const now = this.deps.clock.now();
    try {
      return await this.deps.analyses.update({
        ...analysis,
        reviewStatus,
        reviewNote: reason,
        reviewedBy: actorUserId,
        reviewedAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (error instanceof DuplicateApprovalConflictError) {
        throw new AppError(
          "VALIDATION_FAILED",
          "Another photo in this duplicate group is already approved",
        );
      }
      throw error;
    }
  }

  private recordDecision(
    action: string,
    actorUserId: string,
    analysis: AssetAnalysis,
    asset: MediaAsset,
    reason: string | null,
  ): Promise<unknown> {
    return recordAudit(this.deps.identity, {
      organizationId: analysis.organizationId,
      actorUserId,
      action,
      resourceType: "asset_analysis",
      resourceId: analysis.id,
      metadata: {
        analysisId: analysis.id,
        assetId: asset.id,
        propertyId: asset.propertyId,
        organizationId: analysis.organizationId,
        actorId: actorUserId,
        reason,
        analysisRevision: analysis.analysisRevision,
      },
    });
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

function optionalReason(reason: string | undefined): string | null {
  const trimmed = (reason ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
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
