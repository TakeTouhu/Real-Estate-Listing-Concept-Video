import {
  humanizeCameraMotion,
  isCameraMotion,
  StoryboardService,
  type StoryboardScene,
  type StoryboardView,
  type TargetOutputResolution,
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
  /**
   * The product deliverable, in the closed product vocabulary. Renamed from
   * `resolution` in Phase 4C-3B-2B: the old key is gone rather than kept as an
   * alias, because a client still reading `resolution` is a client that has not
   * been told the value never meant what it now means (ADR-0034).
   */
  readonly targetOutputResolution: TargetOutputResolution;
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
    targetOutputResolution: project.targetOutputResolution,
    cameraMotion: project.cameraMotion,
    prompt: project.prompt,
    negativePrompt: project.negativePrompt,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

/**
 * How one persisted camera motion should be shown to a customer.
 *
 * The DTO deliberately keeps the **token** — it is the API contract, and a client
 * that reads a project needs the same value it would send back. Labels are
 * presentation, so they are derived here, at the read surface, rather than baked
 * into the wire shape.
 *
 * There is no second vocabulary: this delegates to `isCameraMotion` and
 * `humanizeCameraMotion`, so adding an approved motion changes one domain
 * constant and this follows automatically.
 *
 * `approved: false` is the **legacy** case — a project written before Phase
 * 4C-0b can still hold arbitrary text (ADR-0022). Such a value stays readable
 * because it is the customer's own data, is returned unmodified, and is never
 * guessed onto a token. Callers mark it so it cannot be mistaken for an approved
 * option.
 */
export interface CameraMotionDisplay {
  readonly label: string;
  readonly approved: boolean;
}

export function cameraMotionDisplay(value: string | null): CameraMotionDisplay | null {
  if (value === null || value.trim().length === 0) return null;
  return isCameraMotion(value)
    ? { label: humanizeCameraMotion(value), approved: true }
    : { label: value, approved: false };
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
