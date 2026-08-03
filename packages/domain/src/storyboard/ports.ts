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
  readonly resolution?: string;
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

export interface StoryboardSceneRepository {
  /** Scenes in position order, or empty when the project is not this tenant's. */
  listByProject(organizationId: string, videoProjectId: string): Promise<StoryboardScene[]>;
  /**
   * Replace a project's scenes wholesale, in one transaction.
   *
   * Composition regenerates the whole sequence rather than diffing it, and a
   * partial replacement would leave positions colliding with the unique index.
   */
  replaceForProject(
    organizationId: string,
    videoProjectId: string,
    scenes: readonly Omit<StoryboardScene, "createdAt" | "updatedAt">[],
  ): Promise<StoryboardScene[]>;
}

export interface StoryboardRepositories {
  readonly projects: VideoProjectRepository;
  readonly scenes: StoryboardSceneRepository;
}
