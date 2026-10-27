import type { DisclosureMode } from "../disclosure/mode";
import type { GenerationReservationAllocation } from "../entitlement/ports";
import type { TargetOutputResolution } from "../generation/model-catalog";
import type { AuditLog } from "../identity/types";
import type {
  GenerationJob,
  GenerationReservation,
  GenerationScene,
  SceneGenerationRequestRecord,
  TransitionContext,
} from "./ports";
import type { GenerationQualityTier } from "./types";

/**
 * Starting a whole video: the start commit (GS-4b, ADR-0087).
 *
 * One commit creates the job, reserves its Units, copies the storyboard's
 * scenes and creates each scene's first request, and records the audit entry;
 * or it writes nothing. The service that decides whether a start may be made
 * (GS-4c) builds the record; this is the contract the database keeps.
 */

/**
 * The quality a project is generated at, from its resolution.
 *
 * 720p is Normal and 1080p is HQ, the only quality choice the product offers
 * (ADR-0052 Decision 6), so the project's resolution is its one source of
 * truth and a start never carries a quality of its own choosing.
 */
export function qualityTierForResolution(resolution: TargetOutputResolution): GenerationQualityTier {
  switch (resolution) {
    case "720p":
      return "NORMAL";
    case "1080p":
      return "HIGH_QUALITY";
  }
}

/** One storyboard scene the start will copy, with the ids its copies take. */
export interface GenerationStartScene {
  readonly storyboardSceneId: string;
  readonly generationSceneId: string;
  readonly initialRequestId: string;
}

/** What the commit records, and hands to `audit` to describe. */
export interface GenerationStartSummary {
  readonly job: GenerationJob;
  readonly reservation: GenerationReservation;
  readonly allocations: readonly GenerationReservationAllocation[];
  readonly sceneCount: number;
}

export type GenerationStartAudit = Omit<AuditLog, "id" | "createdAt">;

export interface GenerationStartRecord {
  readonly organizationId: string;
  readonly videoProjectId: string;
  /**
   * The customer's start key. A second start with the same key on the same
   * project answers with the job the first one started, and writes nothing.
   */
  readonly idempotencyKey: string;
  readonly jobId: string;
  readonly reservationId: string;
  readonly requestedByUserId: string;
  /**
   * The quality the customer confirmed. The commit derives the quality again
   * from the project it locks, and refuses if the two differ.
   */
  readonly qualityTier: GenerationQualityTier;
  readonly disclosureMode: DisclosureMode;
  /** From the server clock. Selects the Unit period, as in Transaction B. */
  readonly startedAt: Date;
  /**
   * The storyboard the service judged current: its fingerprint and its scenes
   * in position order. The commit refuses unless the project still holds
   * exactly this composition.
   */
  readonly storyboard: {
    readonly compositionFingerprint: string;
    readonly scenes: readonly GenerationStartScene[];
  };
  readonly context: TransitionContext;
  /** The audit entry, written in the same commit. */
  readonly audit: (started: GenerationStartSummary) => GenerationStartAudit;
}

/**
 * How a start ended. Only `STARTED` wrote anything; every refusal leaves the
 * database as it was.
 */
export type GenerationStartOutcome =
  | {
      readonly kind: "STARTED";
      readonly job: GenerationJob;
      readonly reservation: GenerationReservation;
      readonly allocations: readonly GenerationReservationAllocation[];
      readonly scenes: readonly GenerationScene[];
      readonly requests: readonly SceneGenerationRequestRecord[];
    }
  /** A start with this key already started this job. */
  | { readonly kind: "EXISTING"; readonly job: GenerationJob }
  /** No such project in this organization. */
  | { readonly kind: "PROJECT_NOT_FOUND" }
  /** The project no longer holds the composition the service judged current. */
  | { readonly kind: "STORYBOARD_CHANGED" }
  /** The project's resolution no longer gives the quality the customer confirmed. */
  | { readonly kind: "QUALITY_CHANGED" }
  | { readonly kind: "DURATION_NOT_SUPPORTED" }
  | { readonly kind: "DISCLOSURE_MODE_NOT_SUPPORTED" }
  | { readonly kind: "NO_ENTITLEMENT_PERIOD" }
  | { readonly kind: "INSUFFICIENT_ENTITLEMENT"; readonly eligibleUnits: number };

export interface GenerationStartRepository {
  /**
   * The start commit, under the project row held `FOR SHARE` (ADR-0086,
   * ADR-0087). Leaves the job `RESERVED` and its scenes and requests `PENDING`:
   * it admits no attempt.
   */
  start(record: GenerationStartRecord): Promise<GenerationStartOutcome>;
  /**
   * The job a start with this key started on this project, or `null`. Read
   * scoped to the organization, so another tenant's key is never answered
   * (ADR-0088).
   */
  findStarted(organizationId: string, videoProjectId: string, idempotencyKey: string): Promise<GenerationJob | null>;
}
