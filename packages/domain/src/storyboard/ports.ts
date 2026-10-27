import type { TargetOutputResolution } from "../generation/model-catalog";
import type { StoryboardScene, VideoProject, VideoProjectStatus } from "./types";

/**
 * The fields a caller may change on a project — and nothing else.
 *
 * `organizationId`, `propertyId` and `createdAt` are identity and ownership:
 * they are not merely ignored when supplied, they cannot be expressed, so
 * "move this project to another property" is a type error rather than a silent
 * no-op. `updatedAt` is database-managed and likewise absent, since writing
 * back an in-memory copy would freeze the column.
 *
 * This is a narrower contract than the whole-entity `update` used by the older
 * repositories (`AssetAnalysisRepository`, `PropertyRepository`, …). The
 * divergence is deliberate and local: this port has no other callers yet, and
 * aligning the existing ones is a separate decision recorded in
 * `docs/decisions/TODO.md`.
 */
export interface VideoProjectUpdate {
  readonly name?: string;
  readonly status?: VideoProjectStatus;
  readonly durationSeconds?: number;
  readonly aspectRatio?: string;
  /**
   * There is deliberately no `resolution` alias beside this. Leaving the old
   * name writable would let a caller that was never updated keep setting the
   * ambiguous value, which is the exact drift ADR-0034 removes.
   */
  readonly targetOutputResolution?: TargetOutputResolution;
  readonly stylePreset?: string | null;
  readonly cameraMotion?: string | null;
  readonly prompt?: string | null;
  readonly negativePrompt?: string | null;
  readonly includeMusic?: boolean;
  readonly includeCaptions?: boolean;
  readonly brandTemplateId?: string | null;
  readonly compositionFingerprint?: string | null;
}

/**
 * Persistence ports for storyboards.
 *
 * Every project read is filtered by `organizationId`, so another tenant's row is
 * invisible rather than merely forbidden. Scene reads take the organization too
 * and resolve it through the owning project, because scenes carry no
 * organization column of their own.
 */
export interface VideoProjectRepository {
  create(input: Omit<VideoProject, "createdAt" | "updatedAt">): Promise<VideoProject>;
  findById(organizationId: string, id: string): Promise<VideoProject | null>;
  listByProperty(organizationId: string, propertyId: string): Promise<VideoProject[]>;
  /**
   * Apply mutable changes to one project. The organization is an addressing
   * argument, not payload, so a write can never target another tenant's row by
   * carrying a different id in the body.
   */
  update(
    organizationId: string,
    id: string,
    changes: VideoProjectUpdate,
  ): Promise<VideoProject>;
}

/** One composition: the scenes, and the fingerprint of the inputs they were composed from. */
export interface StoryboardComposition {
  readonly scenes: readonly Omit<StoryboardScene, "createdAt" | "updatedAt">[];
  readonly compositionFingerprint: string;
}

/** A project as one composition left it, with that composition's scenes. */
export interface SavedComposition {
  readonly project: VideoProject;
  readonly scenes: readonly StoryboardScene[];
}

export interface StoryboardSceneRepository {
  /** Scenes in position order, or empty when the project is not this tenant's. */
  listByProject(organizationId: string, videoProjectId: string): Promise<StoryboardScene[]>;
  /**
   * Save one composition in one commit: the project's scenes replaced
   * wholesale, and the project marked `STORYBOARD_READY` with the
   * composition's fingerprint (ADR-0086).
   *
   * Composition regenerates the whole sequence rather than diffing it, and a
   * partial replacement would leave positions colliding with the unique index.
   * The scenes and the fingerprint are one fact: written apart, two
   * compositions racing could leave one's scenes under the other's
   * fingerprint, a storyboard that reads as current while showing photos its
   * fingerprint does not describe.
   *
   * @throws when the project is not this tenant's; nothing is written.
   */
  saveComposition(
    organizationId: string,
    videoProjectId: string,
    composition: StoryboardComposition,
  ): Promise<SavedComposition>;
}

export interface StoryboardRepositories {
  readonly projects: VideoProjectRepository;
  readonly scenes: StoryboardSceneRepository;
}
