import { AppError } from "@app/shared";
import { recordAudit } from "../identity/audit";
import { authorizeOrganization } from "../identity/authorization";
import type { IdentityServiceDeps } from "../identity/ports";
import type { AssetAnalysisRepository } from "../analysis/ports";
import type { MediaAssetRepository } from "../property/ports";
import { allocateDurations, requireMinimumScenes, type DurationBounds } from "./duration";
import { selectEligibleAnalyses, type EligibleInput } from "./eligibility";
import { computeCompositionFingerprint } from "./fingerprint";
import type { PromptModerator } from "./moderation";
import { orderScenes } from "./ordering";
import { compileScenePrompt, type CompiledPrompt } from "./prompt";
import type { StoryboardRepositories } from "./ports";
import type { StoryboardScene, VideoProject } from "./types";

/** Audit vocabulary for this module. One action, one event per composition. */
export const StoryboardAuditAction = { StoryboardComposed: "storyboard.composed" } as const;

export interface StoryboardServiceDeps {
  /** Supplies membership lookup (authorization) and the audit sink. */
  readonly identity: IdentityServiceDeps;
  readonly assets: MediaAssetRepository;
  readonly analyses: AssetAnalysisRepository;
  readonly storyboards: StoryboardRepositories;
  readonly moderator: PromptModerator;
  readonly ids: { generate(prefix: string): string };
}

export interface ComposedStoryboard {
  readonly project: VideoProject;
  readonly scenes: readonly StoryboardScene[];
}

/**
 * Orchestration only.
 *
 * Every rule already lives in a tested function — eligibility, the minimum,
 * ordering, duration allocation, prompt compilation, moderation, and the
 * fingerprint. This service loads, delegates in order, and persists. It
 * deliberately restates none of those rules, so a change to any of them takes
 * effect here without an edit.
 */
export class StoryboardService {
  constructor(private readonly deps: StoryboardServiceDeps) {}

  /**
   * Compose a storyboard from the property's approved analyses.
   *
   * Writes are ordered rather than wrapped in a transaction: scenes first, then
   * the project. A failure between them leaves a project that is *not* marked
   * ready, which the next composition overwrites wholesale — whereas marking it
   * ready before the scenes existed would advertise a storyboard that is not
   * there. No transaction abstraction buys anything the ordering does not.
   *
   * `bounds` is supplied by the caller: this milestone defines no default and no
   * provider limit.
   */
  async compose(
    actorUserId: string,
    organizationId: string,
    videoProjectId: string,
    bounds: DurationBounds,
  ): Promise<ComposedStoryboard> {
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "property:write");

    const project = await this.deps.storyboards.projects.findById(organizationId, videoProjectId);
    if (!project) throw new AppError("NOT_FOUND", "Video project not found");

    const eligible = await this.eligibleInputs(organizationId, project.propertyId);
    requireMinimumScenes(eligible.length);

    const ordered = orderScenes(eligible);
    const durations = allocateDurations(ordered.length, project.durationSeconds, bounds);
    const prompts = await this.compilePrompts(project, ordered, durations);
    const fingerprint = computeCompositionFingerprint(eligible);

    const scenes = await this.deps.storyboards.scenes.replaceForProject(
      organizationId,
      videoProjectId,
      ordered.map((input, index) => ({
        id: this.deps.ids.generate("scn"),
        videoProjectId,
        propertyId: project.propertyId,
        assetId: input.assetId,
        position: index + 1,
        roomType: input.roomType,
        durationSeconds: durations[index]!,
        cameraMotion: project.cameraMotion,
        // Persistence encoding, not prose: the structure survives the round
        // trip, so Phase 4 consumes the reviewed prompt rather than recompiling
        // something different (ADR-0014).
        compiledPrompt: JSON.stringify(prompts[index]),
        sourceAnalysisRevision: input.analysisRevision,
      })),
    );

    const updated = await this.deps.storyboards.projects.update(organizationId, videoProjectId, {
      status: "STORYBOARD_READY",
      compositionFingerprint: fingerprint,
    });

    await recordAudit(this.deps.identity, {
      organizationId,
      actorUserId,
      action: StoryboardAuditAction.StoryboardComposed,
      resourceType: "video_project",
      resourceId: videoProjectId,
      metadata: { sceneCount: scenes.length, compositionFingerprint: fingerprint },
    });

    return { project: updated, scenes };
  }

  /**
   * Refuse a storyboard whose inputs have moved since it was composed.
   *
   * Freshness is *derived*: the current eligible set is re-read and re-digested
   * and compared with the stored fingerprint. Nothing marks a storyboard stale
   * in the background, and no module notifies this one when an analysis changes
   * (ADR-0012). Phase 4 calls this before generating.
   *
   * @throws AppError VALIDATION_FAILED when no fingerprint is stored, or when
   *   an approval has been added or removed or an analysis re-run.
   */
  async assertFresh(
    actorUserId: string,
    organizationId: string,
    videoProjectId: string,
  ): Promise<void> {
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId);

    const project = await this.deps.storyboards.projects.findById(organizationId, videoProjectId);
    if (!project) throw new AppError("NOT_FOUND", "Video project not found");
    if (!project.compositionFingerprint) {
      throw new AppError("VALIDATION_FAILED", "This project has no composed storyboard");
    }

    const eligible = await this.eligibleInputs(organizationId, project.propertyId);
    if (computeCompositionFingerprint(eligible) !== project.compositionFingerprint) {
      throw new AppError(
        "VALIDATION_FAILED",
        "The approved photos have changed since this storyboard was composed; compose it again",
      );
    }
  }

  /** Approved analyses for a property, organization-scoped throughout. */
  private async eligibleInputs(
    organizationId: string,
    propertyId: string,
  ): Promise<readonly EligibleInput[]> {
    const assets = await this.deps.assets.listByProperty(organizationId, propertyId);
    const analyses = await this.deps.analyses.listByAssetIds(
      organizationId,
      assets.map((a) => a.id),
    );
    return selectEligibleAnalyses(analyses);
  }

  /**
   * One structured prompt per scene, with the project's two user-authored
   * fields moderated **once each**.
   *
   * The text is identical for every scene, so compiling per scene would put the
   * same strings through the moderator 2N times — wasteful now and expensive
   * against a paid vendor. Instead the compiler runs once, which is what
   * performs the moderation, and the remaining scenes reuse its verified output
   * with their own facts substituted. No allow-all moderator is constructed:
   * nothing here could be mistaken for a moderation boundary that isn't one.
   */
  private async compilePrompts(
    project: VideoProject,
    ordered: readonly EligibleInput[],
    durations: readonly number[],
  ): Promise<readonly CompiledPrompt[]> {
    const facts = (input: EligibleInput, index: number) => ({
      assetId: input.assetId,
      position: index + 1,
      roomType: input.roomType,
      durationSeconds: durations[index]!,
      cameraMotion: project.cameraMotion,
    });

    const first = await compileScenePrompt(
      {
        sceneFacts: facts(ordered[0]!, 0),
        prompt: project.prompt,
        negativePrompt: project.negativePrompt,
      },
      this.deps.moderator,
    );

    return ordered.map((input, index) =>
      index === 0
        ? first
        : {
            preservation: [...first.preservation],
            sceneFacts: facts(input, index),
            userCustomization: first.userCustomization,
            negativeConstraints: {
              system: [...first.negativeConstraints.system],
              user: first.negativeConstraints.user,
            },
          },
    );
  }
}
