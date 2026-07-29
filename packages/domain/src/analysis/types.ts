/** Room vocabulary from docs/ProductRequirements.md. */
export type RoomType =
  | "LIVING_ROOM"
  | "DINING_ROOM"
  | "KITCHEN"
  | "BEDROOM"
  | "CHILD_ROOM"
  | "STUDY"
  | "BATHROOM"
  | "WASHROOM"
  | "TOILET"
  | "ENTRANCE"
  | "HALLWAY"
  | "BALCONY"
  | "STORAGE"
  | "EXTERIOR"
  | "OTHER";

export const ROOM_TYPES: readonly RoomType[] = [
  "LIVING_ROOM",
  "DINING_ROOM",
  "KITCHEN",
  "BEDROOM",
  "CHILD_ROOM",
  "STUDY",
  "BATHROOM",
  "WASHROOM",
  "TOILET",
  "ENTRANCE",
  "HALLWAY",
  "BALCONY",
  "STORAGE",
  "EXTERIOR",
  "OTHER",
];

/**
 * Analysis lifecycle:
 *   PENDING → SUCCEEDED | FAILED
 * A refresh moves a terminal record back to PENDING before re-running.
 */
export type AnalysisStatus = "PENDING" | "SUCCEEDED" | "FAILED";

/**
 * Privacy/safety findings. `BLOCKING` findings must be resolved before an asset
 * may be used; `WARNING` findings only require acknowledgement (Phase 3B).
 */
export type SafetyFlagCode =
  | "PERSON_DETECTED"
  | "PERSONAL_INFORMATION"
  | "DOCUMENT_DETECTED"
  | "SUSPECTED_WATERMARK"
  | "UNSAFE_CONTENT"
  | "LOW_RESOLUTION"
  | "BLURRY"
  | "EXPOSURE_PROBLEM";

export type SafetySeverity = "BLOCKING" | "WARNING";

export interface SafetyFlag {
  readonly code: SafetyFlagCode;
  readonly severity: SafetySeverity;
  /** Sanitized, customer-safe explanation. Never a raw provider payload. */
  readonly message: string;
}

export interface DetectedObject {
  readonly label: string;
  readonly confidence: number;
}

/**
 * Per-asset AI analysis record (docs/DataModel.md `AssetAnalysis`). Scores are
 * normalized to 0..1. Low-confidence classification must be confirmed by a
 * human before generation (enforced in Phase 3B).
 */
/**
 * Outcome of the mandatory human review of one analysis revision.
 *
 * A decision is immutable for the revision it was made against: once APPROVED
 * or REJECTED, it cannot be edited. Refreshing the analysis produces a new
 * revision with the review state cleared, which is the only way to review the
 * same asset again.
 */
export type ReviewStatus = "UNREVIEWED" | "APPROVED" | "REJECTED";

export const REVIEW_STATUSES: readonly ReviewStatus[] = [
  "UNREVIEWED",
  "APPROVED",
  "REJECTED",
];

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === "string" && (REVIEW_STATUSES as readonly string[]).includes(value);
}

export interface AssetAnalysis {
  readonly id: string;
  readonly organizationId: string;
  readonly assetId: string;
  readonly provider: string;
  readonly status: AnalysisStatus;
  readonly roomType: RoomType | null;
  readonly confidence: number | null;
  readonly qualityScore: number | null;
  readonly brightnessScore: number | null;
  readonly blurScore: number | null;
  readonly duplicateGroup: string | null;
  readonly detectedObjects: readonly DetectedObject[];
  readonly safetyFlags: readonly SafetyFlag[];
  readonly suggestedOrder: number | null;
  readonly failureReason: string | null;
  /**
   * Identifies the persisted analysis *result*, not the attempt. Starts at 1
   * for the first successful analysis and increments only on a successful
   * refresh; a failed refresh leaves it unchanged.
   */
  readonly analysisRevision: number;
  readonly reviewStatus: ReviewStatus;
  /** Reviewer's stated reason. Required for rejection, optional for approval. */
  readonly reviewNote: string | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Confidence at or below this threshold requires human confirmation. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

export function isLowConfidence(analysis: AssetAnalysis): boolean {
  return analysis.confidence === null || analysis.confidence <= LOW_CONFIDENCE_THRESHOLD;
}

export function hasBlockingFlag(analysis: AssetAnalysis): boolean {
  return analysis.safetyFlags.some((f) => f.severity === "BLOCKING");
}

export function isRoomType(value: unknown): value is RoomType {
  return typeof value === "string" && (ROOM_TYPES as readonly string[]).includes(value);
}

/** True once a decision has been recorded against the current revision. */
export function isReviewed(analysis: AssetAnalysis): boolean {
  return analysis.reviewStatus !== "UNREVIEWED";
}
