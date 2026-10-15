import {
  effectiveRoomType,
  isCorrected,
  hasBlockingFlag,
  isLowConfidence,
  type AssetAnalysis,
  type MediaAsset,
  type Permission,
  type RoomType,
  type SafetyFlag,
} from "@app/domain";

/**
 * Presentation model for the review surface. Pure — no React, no fetch — so
 * every rule below is unit-testable without a DOM.
 *
 * It decides only what to *show*. Whether a decision is permitted is settled by
 * AnalysisService; the flags here exist so a reviewer is not offered an action
 * that is certain to fail.
 */

/** Where an asset sits in the review workflow. */
export type ReviewBucket = "AWAITING" | "DECIDED" | "NOT_REVIEWABLE";

/** An immutable decision, as recorded against one analysis revision. */
export interface DecisionRecord {
  readonly status: "APPROVED" | "REJECTED";
  readonly note: string | null;
  /** Reviewer's user id. Never expanded into a name or email. */
  readonly reviewedBy: string | null;
  readonly reviewedAt: Date | null;
  readonly analysisRevision: number;
}

export interface ReviewActions {
  readonly canApprove: boolean;
  readonly canReject: boolean;
  /** Why no decision is offered, or null when both actions are available. */
  readonly unavailableReason: string | null;
}

/**
 * Correction state as the review page shows it.
 *
 * `effectiveRoomType` comes from the analysis DTO, already resolved on the
 * server — the browser never recomputes `roomTypeOverride ?? roomType`
 * (ADR-0015).
 */
export interface CorrectionState {
  /** Humanized, for display beside what the reviewer chose. */
  readonly analyzerRoomType: string;
  readonly effectiveRoomType: string;
  /** Raw enum value, so a select can preselect it. Null when uncorrected. */
  readonly roomTypeOverride: RoomType | null;
  readonly orderOverride: number | null;
  readonly corrected: boolean;
  /**
   * Presentation only: whether to offer the correction controls. The API is the
   * security boundary and enforces the same rule independently.
   */
  readonly canCorrect: boolean;
}

export interface ReviewItem {
  readonly assetId: string;
  readonly filename: string;
  readonly bucket: ReviewBucket;
  readonly roomLabel: string;
  /** Null while an asset has no analysis row at all. */
  readonly analysisRevision: number | null;
  readonly blockingFlags: readonly SafetyFlag[];
  readonly warningFlags: readonly SafetyFlag[];
  readonly lowConfidence: boolean;
  /** Why the asset is not reviewable yet; null outside that bucket. */
  readonly notReviewableReason: string | null;
  readonly decision: DecisionRecord | null;
  readonly actions: ReviewActions;
  /** Null only while an asset has no analysis row at all. */
  readonly correction: CorrectionState | null;
}

export interface ReviewBoard {
  readonly awaiting: readonly ReviewItem[];
  readonly decided: readonly ReviewItem[];
  readonly notReviewable: readonly ReviewItem[];
  /** Presentation-level authorization; the API enforces it independently. */
  readonly canReview: boolean;
}

const NO_PERMISSION = "Your role cannot approve or reject photos.";
const BLOCKED = "This photo has a blocking safety finding and cannot be approved; reject it instead.";

export function humanizeRoomType(roomType: AssetAnalysis["roomType"]): string {
  if (!roomType) return "Unclassified";
  return roomType.toLowerCase().split("_").join(" ").replace(/^./, (c) => c.toUpperCase());
}

function bucketOf(analysis: AssetAnalysis | undefined): ReviewBucket {
  if (!analysis || analysis.status !== "SUCCEEDED") return "NOT_REVIEWABLE";
  return analysis.reviewStatus === "UNREVIEWED" ? "AWAITING" : "DECIDED";
}

function pendingReason(analysis: AssetAnalysis | undefined): string {
  if (!analysis) return "Not analyzed yet.";
  if (analysis.status === "FAILED") return analysis.failureReason ?? "Analysis failed.";
  return "Analysis in progress.";
}

function actionsOf(
  analysis: AssetAnalysis | undefined,
  bucket: ReviewBucket,
  canReview: boolean,
): ReviewActions {
  if (bucket !== "AWAITING" || !analysis) {
    return { canApprove: false, canReject: false, unavailableReason: null };
  }
  if (!canReview) return { canApprove: false, canReject: false, unavailableReason: NO_PERMISSION };
  const blocked = hasBlockingFlag(analysis);
  return { canApprove: !blocked, canReject: true, unavailableReason: blocked ? BLOCKED : null };
}

/**
 * Correction state for one analysis.
 *
 * `canCorrect` mirrors the domain's rule as presentation: only a `SUCCEEDED`,
 * still-undecided analysis is correctable, and only by a member who may review.
 * A decided or not-yet-reviewable row still reports its values, so the page can
 * show them read-only.
 */
function correctionOf(
  analysis: AssetAnalysis | undefined,
  bucket: ReviewBucket,
  canReview: boolean,
): CorrectionState | null {
  if (!analysis) return null;
  return {
    analyzerRoomType: humanizeRoomType(analysis.roomType),
    effectiveRoomType: humanizeRoomType(effectiveRoomType(analysis)),
    roomTypeOverride: analysis.roomTypeOverride,
    orderOverride: analysis.orderOverride,
    corrected: isCorrected(analysis),
    canCorrect: bucket === "AWAITING" && canReview,
  };
}

/**
 * Join assets to their analyses and bucket them.
 *
 * Every photo is its own row. Look-alike photos are not grouped or flagged
 * (ADR-0052 Decision 14): which of them to use is the customer's call.
 */
export function buildReviewBoard(
  assets: readonly MediaAsset[],
  analyses: readonly AssetAnalysis[],
  /** The viewer's effective permissions in the organization. */
  permissions: readonly Permission[],
): ReviewBoard {
  const canReview = permissions.includes("analysis.review");
  const byAsset = new Map(analyses.map((a) => [a.assetId, a]));

  const items = assets.map((asset): ReviewItem => {
    const analysis = byAsset.get(asset.id);
    const bucket = bucketOf(analysis);
    const flags = analysis?.safetyFlags ?? [];
    return {
      assetId: asset.id,
      filename: asset.originalFilename,
      bucket,
      roomLabel: humanizeRoomType(analysis?.roomType ?? null),
      analysisRevision: analysis?.analysisRevision ?? null,
      blockingFlags: flags.filter((f) => f.severity === "BLOCKING"),
      warningFlags: flags.filter((f) => f.severity === "WARNING"),
      lowConfidence: analysis ? isLowConfidence(analysis) : false,
      notReviewableReason: bucket === "NOT_REVIEWABLE" ? pendingReason(analysis) : null,
      decision:
        analysis && analysis.reviewStatus !== "UNREVIEWED"
          ? {
              status: analysis.reviewStatus,
              note: analysis.reviewNote,
              reviewedBy: analysis.reviewedBy,
              reviewedAt: analysis.reviewedAt,
              analysisRevision: analysis.analysisRevision,
            }
          : null,
      actions: actionsOf(analysis, bucket, canReview),
      correction: correctionOf(analysis, bucket, canReview),
    };
  });

  return {
    awaiting: items.filter((i) => i.bucket === "AWAITING"),
    decided: items.filter((i) => i.bucket === "DECIDED"),
    notReviewable: items.filter((i) => i.bucket === "NOT_REVIEWABLE"),
    canReview,
  };
}
