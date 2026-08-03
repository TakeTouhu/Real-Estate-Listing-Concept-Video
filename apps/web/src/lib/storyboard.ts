import { StoryboardService, type VideoProject } from "@app/domain";
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
