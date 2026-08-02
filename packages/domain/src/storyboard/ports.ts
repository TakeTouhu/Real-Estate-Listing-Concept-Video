import type { StoryboardScene, VideoProject } from "./types";

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
  update(project: VideoProject): Promise<VideoProject>;
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
