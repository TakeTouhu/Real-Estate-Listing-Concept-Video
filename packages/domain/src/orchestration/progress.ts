import { AppError } from "@app/shared";
import { authorizeOrganization } from "../identity/authorization";
import type { IdentityServiceDeps } from "../identity/ports";
import type { PropertyRepository } from "../property/ports";
import { findReachableProperty } from "../property/reach";
import type { VideoProjectRepository } from "../storyboard/ports";
import type { GenerationJobState, GenerationQualityTier, GenerationReservationState } from "./types";

/**
 * A project's video as its customer sees it (GS-11a, ADR-0113): the phase it
 * is in, what became of its Units, and how far its scenes are. Read only.
 *
 * The phases are UXFlow's normalized states. None of them names a provider, a
 * model, an attempt or a retry, and nothing here carries one.
 */

/**
 * Where a video is. A video never passes through UXFlow's "analyzing": the
 * photos are analyzed before the storyboard is composed, and a video starts
 * from a composed storyboard.
 */
export type VideoProgressPhase =
  /** Started, with its Units reserved, and not generating yet. */
  | "QUEUED"
  | "GENERATING_SCENES"
  | "COMPOSING"
  | "VALIDATING"
  /** Delivered to the organization's workspace. */
  | "COMPLETED"
  /** Delivered, and a new version of it is being made. */
  | "REVISING"
  | "FAILED"
  | "CANCELLED";

/**
 * What became of the Units the video reserved. `RESERVED` covers every hold
 * that is neither used nor back, whatever is still settling it. `NONE` is a
 * video that never reserved any.
 */
export type VideoProgressUnits = "RESERVED" | "CONSUMED" | "RELEASED" | "NONE";

/** The newest video of a project, as the database holds it. */
export interface VideoProgressRecord {
  readonly jobId: string;
  readonly jobState: GenerationJobState;
  readonly qualityTier: GenerationQualityTier;
  readonly durationSeconds: number;
  /** The Units the video needs, frozen when it started. */
  readonly requiredUnits: number;
  /** Its reservation's state, or `null` when it has none. */
  readonly reservationState: GenerationReservationState | null;
  readonly sceneCount: number;
  /** How many of its scenes are made. */
  readonly scenesReady: number;
}

export interface VideoProgressRepository {
  /**
   * The project's newest video, or `null` when it has none. Read in one
   * snapshot, so its phase, Units and scenes are of one moment. Only a project
   * of the named organization is read.
   */
  findLatest(organizationId: string, videoProjectId: string): Promise<VideoProgressRecord | null>;
}

export interface VideoProgress {
  readonly phase: VideoProgressPhase;
  readonly qualityTier: GenerationQualityTier;
  readonly durationSeconds: number;
  readonly units: { readonly count: number; readonly state: VideoProgressUnits };
  readonly scenes: { readonly ready: number; readonly total: number };
  /**
   * What the customer quotes to support about this video (UXFlow, "Error
   * recovery"): the video's own id, which support can look up, and which
   * names nothing outside VTaVision.
   */
  readonly supportReference: string;
}

/** The phase a job's state is shown as. Every state has one. */
export function videoProgressPhaseOf(state: GenerationJobState): VideoProgressPhase {
  switch (state) {
    case "CREATED":
    case "RESERVING":
    case "RESERVED":
      return "QUEUED";
    case "GENERATING":
      return "GENERATING_SCENES";
    // Every scene is made: the video is being put together from them.
    case "SCENES_READY":
    case "COMPOSITION_PENDING":
    case "COMPOSING":
      return "COMPOSING";
    case "DELIVERABLE_VALIDATING":
      return "VALIDATING";
    case "DELIVERABLE_READY":
      return "COMPLETED";
    case "REVISING":
      return "REVISING";
    case "FAILED_TERMINAL":
      return "FAILED";
    case "CANCELLED":
      return "CANCELLED";
  }
}

/** What a reservation's state says of its Units. */
export function videoProgressUnitsOf(state: GenerationReservationState | null): VideoProgressUnits {
  switch (state) {
    case null:
      return "NONE";
    case "RESERVING":
    case "RESERVED":
    case "RECONCILIATION_HOLD":
      return "RESERVED";
    case "CONSUMED":
      return "CONSUMED";
    case "RELEASED":
      return "RELEASED";
  }
}

/**
 * The customer's view of one video.
 *
 * @throws AppError INTERNAL_ERROR for a video that ended without one but used
 *   its Units: it contradicts ADR-0052 Decision 19, and the customer is told a
 *   failed video used no Unit, so it is surfaced rather than described.
 */
export function videoProgressOf(record: VideoProgressRecord): VideoProgress {
  const phase = videoProgressPhaseOf(record.jobState);
  const units = videoProgressUnitsOf(record.reservationState);
  if ((phase === "FAILED" || phase === "CANCELLED") && units === "CONSUMED") {
    throw new AppError("INTERNAL_ERROR", "A video that ended without one used its Units", {
      details: { jobId: record.jobId },
    });
  }
  return {
    phase,
    qualityTier: record.qualityTier,
    durationSeconds: record.durationSeconds,
    units: { count: record.requiredUnits, state: units },
    scenes: { ready: record.scenesReady, total: record.sceneCount },
    supportReference: record.jobId,
  };
}

export interface VideoProgressServiceDeps {
  /** Membership lookup for authorization and reach. */
  readonly identity: IdentityServiceDeps;
  readonly properties: Pick<PropertyRepository, "findById">;
  readonly projects: Pick<VideoProjectRepository, "findById">;
  readonly progress: VideoProgressRepository;
}

export class VideoProgressService {
  constructor(private readonly deps: VideoProgressServiceDeps) {}

  /**
   * The project's newest video, or `null` when none was started. Its readers
   * are the storyboard's: `video.view`, and the project's Property in reach.
   *
   * @throws AppError FORBIDDEN when the member lacks `video.view`.
   * @throws AppError NOT_FOUND when the project is not this organization's or
   *   its Property is out of the member's reach: answered alike, before
   *   anything about its video is read.
   */
  async progress(actorUserId: string, organizationId: string, videoProjectId: string): Promise<VideoProgress | null> {
    const actor = await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "video.view");
    const project = await this.deps.projects.findById(organizationId, videoProjectId);
    if (
      project === null ||
      (await findReachableProperty(this.deps.identity, this.deps.properties, actor, project.propertyId)) === null
    ) {
      throw new AppError("NOT_FOUND", "Video project not found");
    }
    const record = await this.deps.progress.findLatest(organizationId, project.id);
    return record === null ? null : videoProgressOf(record);
  }
}
