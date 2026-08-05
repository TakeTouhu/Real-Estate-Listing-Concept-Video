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
   * The reviewer's corrected room classification, or null when the analyzer's
   * {@link AssetAnalysis.roomType} stands.
   *
   * Stored **beside** the analyzer's value rather than over it, so the model's
   * own answer stays recoverable and `confidence` keeps describing the value it
   * was produced for. Resolve the two with `effectiveRoomType` — never read
   * `roomType` directly where the corrected value is meant (ADR-0015).
   */
  readonly roomTypeOverride: RoomType | null;
  /**
   * The reviewer's sort priority, lower appearing earlier.
   *
   * A **global priority, not an absolute final position**: it competes with the
   * automatic room rank rather than pinning a photo to index N, and duplicate
   * values across photos are allowed and resolve deterministically. It is
   * deliberately *not* a fallback for `suggestedOrder` — how the two combine is
   * the storyboard ordering primitive's decision, not this model's (ADR-0015).
   */
  readonly orderOverride: number | null;
  /** Who last corrected this revision, and when. Null while uncorrected. */
  readonly correctedBy: string | null;
  readonly correctedAt: Date | null;
  /**
   * Identifies the persisted analysis *result*, not the attempt:
   *
   * - first successful analysis → revision 1;
   * - successful refresh → previous revision + 1;
   * - failed refresh → revision unchanged.
   *
   * The transition is decided by whether the run was a refresh, never inferred
   * from the row reaching `SUCCEEDED`: an initial analysis and a refresh both
   * end in `SUCCEEDED`, and only the latter advances the revision.
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

/** Reviewer input for approving one analysis revision. */
export interface ApproveInput {
  /**
   * Required when the asset's duplicate group has more than one member: names
   * the single member to approve, and must equal the asset being approved.
   */
  readonly primaryAssetId?: string;
  /** Optional for approval; recorded as null when absent. */
  readonly reason?: string;
}

/** Reviewer input for rejecting one analysis revision. */
export interface RejectInput {
  /** Required and non-blank: a rejection without a stated cause is not reviewable. */
  readonly reason: string;
}

/**
 * One field of a correction, wrapped so that "leave it alone" and "clear it"
 * cannot be confused.
 *
 * The obvious shape — `roomType?: RoomType | null` — collapses the two: without
 * `exactOptionalPropertyTypes`, `{ roomType: undefined }` and `{}` are the same
 * type, so a caller that forwards an unset value would silently clear a
 * reviewer's correction. Wrapping makes the distinction structural: the field's
 * *presence* says whether to touch it, and `set` says what to write.
 */
export type CorrectionField<T> = {
  readonly set: T | null;
};

/**
 * A reviewer's correction to one analysis revision.
 *
 * Absent field → the stored override is left unchanged.
 * `{ set: null }` → the stored override is cleared.
 * `{ set: value }` → the stored override is set.
 *
 * An input specifying neither field is refused rather than treated as a no-op:
 * it is a caller mistake, not an intention (ADR-0015).
 */
export interface CorrectInput {
  readonly roomType?: CorrectionField<RoomType>;
  /** The reviewer's sort priority. Positive whole numbers only when setting. */
  readonly order?: CorrectionField<number>;
}
