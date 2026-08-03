import {
  StoryboardService,
  type StoryboardScene,
  type StoryboardView,
  type VideoProject,
} from "@app/domain";
import {
  createPrismaAnalysisRepository,
  createPrismaPropertyRepositories,
  createPrismaStoryboardRepositories,
  getPrismaClient,
} from "@app/database";
import { createOfflinePromptModerator } from "@app/domain";
import { getIdentityServices } from "./identity";

let service: StoryboardService | undefined;

/**
 * Wire the storyboard service. Server-only.
 *
 * The offline moderator is the Phase 3C default (ADR-0014); a real moderation
 * vendor would be another `PromptModerator` wired here, with no change to
 * routes or domain code.
 */
export function getStoryboardService(): StoryboardService {
  if (service) return service;
  const identity = getIdentityServices();
  const prisma = getPrismaClient();
  const property = createPrismaPropertyRepositories(prisma);

  service = new StoryboardService({
    identity: identity.deps,
    properties: property.properties,
    assets: property.assets,
    analyses: createPrismaAnalysisRepository(prisma),
    storyboards: createPrismaStoryboardRepositories(prisma),
    moderator: createOfflinePromptModerator(),
    ids: identity.deps.ids,
  });
  return service;
}

/**
 * Public shape of a video project.
 *
 * Omits `organizationId` (implied by the authorized request) and
 * `compositionFingerprint` — the fingerprint is an internal freshness token,
 * not something a client needs or should compare for itself. Nothing about the
 * compiled prompt, the preservation rules, or the system negative constraints
 * appears here: those are server-side generation data (ADR-0014).
 */
export interface VideoProjectDto {
  readonly id: string;
  readonly propertyId: string;
  readonly name: string;
  readonly status: VideoProject["status"];
  readonly durationSeconds: number;
  readonly aspectRatio: string;
  readonly resolution: string;
  readonly cameraMotion: string | null;
  /** The customer's own text, returned so they can see what they submitted. */
  readonly prompt: string | null;
  readonly negativePrompt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toVideoProjectDto(project: VideoProject): VideoProjectDto {
  return {
    id: project.id,
    propertyId: project.propertyId,
    name: project.name,
    status: project.status,
    durationSeconds: project.durationSeconds,
    aspectRatio: project.aspectRatio,
    resolution: project.resolution,
    cameraMotion: project.cameraMotion,
    prompt: project.prompt,
    negativePrompt: project.negativePrompt,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

/**
 * Public shape of one planned scene.
 *
 * Carries no `compiledPrompt` in any form — not raw, not parsed. The compiled
 * prompt, the preservation rules, and the system negative constraints are
 * server-side generation data that Phase 4 consumes in process (ADR-0014);
 * nothing about them crosses the HTTP boundary. `propertyId` and the scene's
 * internal linkage are likewise omitted.
 */
export interface StoryboardSceneDto {
  readonly id: string;
  readonly assetId: string;
  readonly position: number;
  readonly durationSeconds: number;
  readonly roomType: StoryboardScene["roomType"];
  /** Which analysis revision this scene was composed from. */
  readonly sourceAnalysisRevision: number;
}

export function toStoryboardSceneDto(scene: StoryboardScene): StoryboardSceneDto {
  return {
    id: scene.id,
    assetId: scene.assetId,
    position: scene.position,
    durationSeconds: scene.durationSeconds,
    roomType: scene.roomType,
    sourceAnalysisRevision: scene.sourceAnalysisRevision,
  };
}

/**
 * A storyboard as the product shows it: the project, its scenes, and whether
 * the storyboard still matches the approved photos it was composed from.
 *
 * `fresh` is a boolean, not the fingerprint — a client has no use for the digest
 * and no way to recompute it, and exposing it would leak an internal token.
 */
export interface StoryboardReadDto {
  readonly project: VideoProjectDto;
  readonly scenes: readonly StoryboardSceneDto[];
  readonly fresh: boolean;
}

export function toStoryboardReadDto(view: StoryboardView): StoryboardReadDto {
  return {
    project: toVideoProjectDto(view.project),
    scenes: view.scenes.map(toStoryboardSceneDto),
    fresh: view.fresh,
  };
}
