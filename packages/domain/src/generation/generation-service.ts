import { AppError } from "@app/shared";
import { recordAudit } from "../identity/audit";
import { authorizeOrganization } from "../identity/authorization";
import type { IdentityServiceDeps, IdGenerator } from "../identity/ports";
import { assertApprovedCameraMotion } from "../storyboard/camera-motion";
import type { StoryboardScene, VideoProject } from "../storyboard/types";
import {
  assertSettingsSupported,
  type GenerationRequestSettings,
  type VideoModelCapability,
  type VideoModelCapabilityProvider,
} from "./capability";
import { GENERATION_AUDIT_RESOURCE_TYPE, GenerationAuditAction } from "./audit";
import {
  ActiveGenerationConflictError,
  type NewSceneGeneration,
  type SceneGenerationRepository,
  type StoryboardReader,
} from "./ports";
import { computeGenerationRequestHash } from "./request-identity";
import type { SceneGenerationQueue } from "./queue";
import type { SceneGeneration } from "./types";

export interface GenerationServiceDeps {
  /** Supplies membership lookup (authorization) and the audit sink. */
  readonly identity: IdentityServiceDeps;
  /** The narrow storyboard slice: freshness and the scoped project + scenes. */
  readonly storyboard: StoryboardReader;
  readonly generations: SceneGenerationRepository;
  readonly capabilities: VideoModelCapabilityProvider;
  readonly queue: SceneGenerationQueue;
  readonly ids: IdGenerator;
}

/**
 * Admit **one** storyboard scene for generation.
 *
 * The commercial job of this milestone is narrow and load-bearing: safely hand a
 * single scene to asynchronous execution exactly once, without ever paying a
 * provider twice for the same request and without ever admitting a storyboard
 * the customer has already invalidated. Whole-video orchestration is later work;
 * there is deliberately no batch method here.
 *
 * **What this service returns is a domain entity, not an HTTP DTO.** A
 * {@link SceneGeneration} carries `providerName`, `providerModelId` and
 * `providerPredictionId` — internal facts. A transport layer must project it;
 * ADR-0016 §9 and ADR-0017 govern what may cross the wire.
 *
 * No video provider is constructed or called anywhere in this class, and nothing
 * is written to object storage. Generation *execution* is Phase 4C's worker;
 * this service only records the intent and enqueues it.
 */
export class GenerationService {
  constructor(private readonly deps: GenerationServiceDeps) {}

  /**
   * Admit one scene for generation, or reuse an existing attempt for the same
   * request.
   *
   * The ordering is exact and every early exit is side-effect-free until a row
   * is actually created:
   *
   * 1. authorize `property:write` — before any read, capability lookup, write,
   *    enqueue or audit;
   * 2. `assertFresh` — the hard pre-spend gate, keeping its distinct
   *    `NEVER_COMPOSED` / `STALE` messages;
   * 3. `getStoryboard` — for the scoped project and scenes;
   * 4. reject if the freshness the read just re-derived is `false`;
   * 5. resolve the scene **only** inside those scenes;
   * 6. reject a scene with no compiled prompt;
   * 7. snapshot the capability once, and validate the request against it;
   * 8. compute the request hash;
   * 9. return an existing **active** attempt if one holds this identity;
   * 10. otherwise return the latest **succeeded** attempt if one does;
   * 11. otherwise `create` (at most once), then `enqueue`, then `audit`.
   *
   * @throws AppError FORBIDDEN when the actor lacks `property:write`.
   * @throws AppError NOT_FOUND when the project, or the scene within it, is not
   *   this organization's — the two are indistinguishable.
   * @throws AppError VALIDATION_FAILED when the storyboard is stale/absent, the
   *   scene has no compiled prompt, or the request exceeds model capability.
   * @throws AppError INTERNAL_ERROR when a create conflict cannot be reconciled
   *   to an existing attempt (a concurrency/infrastructure convergence failure,
   *   not an invalid request).
   */
  async startScene(
    actorUserId: string,
    organizationId: string,
    videoProjectId: string,
    storyboardSceneId: string,
  ): Promise<SceneGeneration> {
    // (1) Authorization first. Nothing — not even a project read — happens for a
    // caller who lacks write access to this organization.
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "property:write");

    // (2) The hard freshness gate, with its precise messages. A stale or
    // never-composed storyboard is refused here, before anything billable.
    await this.deps.storyboard.assertFresh(actorUserId, organizationId, videoProjectId);

    // (3) The scoped project and its scenes. `getStoryboard` resolves tenant and
    // project scope through its own queries, so what comes back is already this
    // organization's project and only its scenes.
    const view = await this.deps.storyboard.getStoryboard(
      actorUserId,
      organizationId,
      videoProjectId,
    );

    // (4) The read re-derived freshness; if that later, more current observation
    // says the storyboard is stale, do not admit it. This is not new I/O — it
    // reads the value `getStoryboard` already computed and returned.
    if (!view.fresh) {
      throw new AppError(
        "VALIDATION_FAILED",
        "The approved photos have changed since this storyboard was composed; compose it again",
      );
    }

    // (5) The scene is resolved ONLY from the scoped set. A scene belonging to
    // another project is simply not in this list, so it is indistinguishable
    // from an id that never existed — neither reveals whether the other project
    // or scene is real.
    const scene = view.scenes.find((candidate) => candidate.id === storyboardSceneId);
    if (!scene) throw new AppError("NOT_FOUND", "Storyboard scene not found");

    // (6) A scene with no compiled prompt cannot be generated. The prompt is an
    // opaque persisted string from here on: never parsed, rendered, logged, or
    // placed in an error or audit entry.
    if (scene.compiledPrompt === null) {
      throw new AppError(
        "VALIDATION_FAILED",
        "This scene has no compiled prompt; compose the storyboard again before generating",
      );
    }

    // (6a) The scene's camera motion must still be an approved value. A scene
    // composed before Phase 4C-0b can hold free text, and admitting it would
    // hash that text into the request identity, freeze it into the snapshot, and
    // hand it to the renderer. Refused here, before anything durable exists, and
    // before any capability or spend decision (ADR-0022).
    assertApprovedCameraMotion(scene.cameraMotion);

    // (7) One capability snapshot for the whole request. It supplies the
    // provider/model pair used for validation, the request hash, AND the
    // persisted row, so a configuration change mid-request cannot split those
    // three apart. Capability rules themselves live in `assertSettingsSupported`
    // and are not restated here.
    const capability = this.deps.capabilities.current();
    assertSettingsSupported(this.settingsFor(view.project, scene), capability);

    // (8) The local idempotency identity.
    const requestHash = computeGenerationRequestHash({
      assetId: scene.assetId,
      compiledPrompt: scene.compiledPrompt,
      durationSeconds: scene.durationSeconds,
      cameraMotion: scene.cameraMotion,
      aspectRatio: view.project.aspectRatio,
      resolution: view.project.resolution,
      providerName: capability.providerName,
      providerModelId: capability.providerModelId,
    });

    // (9) Active reuse. An attempt already in flight — in ANY active state,
    // including SUBMISSION_UNKNOWN — is returned as-is. Nothing is created,
    // enqueued, or audited, and a stranded QUEUED row is emphatically NOT
    // re-enqueued here: Phase 4C owns that recovery.
    const active = await this.deps.generations.findActiveByRequestIdentity(
      organizationId,
      videoProjectId,
      requestHash,
    );
    if (active) return active;

    // (10) Succeeded reuse, only when nothing is active. This prevents a second
    // charge for a result already produced; it makes no claim that the output is
    // retrievable (Phase 4D owns `outputStorageKey`). Terminal FAILED/CANCELLED
    // attempts do not match and therefore do not block a fresh attempt.
    const succeeded = await this.deps.generations.findLatestSucceededByRequestIdentity(
      organizationId,
      videoProjectId,
      requestHash,
    );
    if (succeeded) return succeeded;

    // (11) A genuinely new attempt. The compiled prompt is passed separately as
    // a proven `string`, so the snapshot cannot be written with a null prompt
    // even if this guard were ever moved or removed.
    return this.admitNewAttempt(
      actorUserId,
      organizationId,
      view.project,
      scene,
      scene.compiledPrompt,
      requestHash,
      capability,
    );
  }

  /**
   * Create the row, enqueue it, then audit it — in that order.
   *
   * The database partial unique index, not these lookups, is the concurrency
   * authority: two callers can both reach here having found nothing, so `create`
   * may still collide. That collision is reconciled once (never in a loop) by
   * re-reading the winner. Every other repository error propagates untouched.
   */
  private async admitNewAttempt(
    actorUserId: string,
    organizationId: string,
    project: VideoProject,
    scene: StoryboardScene,
    /** Proven non-null by the caller; typed as `string` so it cannot regress. */
    compiledPrompt: string,
    requestHash: string,
    capability: VideoModelCapability,
  ): Promise<SceneGeneration> {
    const input: NewSceneGeneration = {
      id: this.deps.ids.generate("gen"),
      // The authoritative project id, from the scoped read — not the raw argument.
      videoProjectId: project.id,
      sourceStoryboardSceneId: scene.id,
      assetId: scene.assetId,
      sourceAnalysisRevision: scene.sourceAnalysisRevision,
      requestHash,
      providerName: capability.providerName,
      providerModelId: capability.providerModelId,
      // The immutable request snapshot (ADR-0018), taken from the SAME resolved
      // `scene`, `project` and `capability` that produced `requestHash` above —
      // nothing is re-read in between, so the snapshot and the hash cannot
      // describe different requests. It is what makes an admitted attempt
      // executable after recomposition deletes the scene or the project's
      // settings are edited.
      //
      // The prompt arrives as a proven `string`, so this field can never be
      // silently null for a new attempt. Stored opaque and byte-identical to
      // what was hashed — never parsed, never re-serialized.
      requestCompiledPrompt: compiledPrompt,
      requestDurationSeconds: scene.durationSeconds,
      requestCameraMotion: scene.cameraMotion,
      requestAspectRatio: project.aspectRatio,
      requestResolution: project.resolution,
      state: "QUEUED",
      providerPredictionId: null,
      submittedAt: null,
      lastPolledAt: null,
      normalizedErrorCode: null,
      normalizedErrorMessage: null,
      outputStorageKey: null,
    };

    let created: SceneGeneration;
    try {
      // At most one create attempt. No retry loop.
      created = await this.deps.generations.create(organizationId, input);
    } catch (error) {
      if (error instanceof ActiveGenerationConflictError) {
        return this.reconcileConflict(organizationId, project.id, requestHash);
      }
      // Any other repository failure (P2003, a non-active P2002,
      // SceneGenerationNotFoundError, a transport error) is not this method's to
      // classify. It propagates unchanged.
      throw error;
    }

    // Ordering is fixed: enqueue BEFORE audit. A job that was never accepted by
    // the queue must not be recorded as requested for execution. If enqueue
    // throws, the durable QUEUED row is left exactly as it is — not deleted, not
    // failed, its active identity intact — and nothing is audited. A later
    // startScene finds that row via the active lookup and returns it without
    // enqueuing again; Phase 4C's sweep is the recovery mechanism.
    await this.deps.queue.enqueue({ generationId: created.id });

    // Only now, after a successful enqueue, is the request audited. Metadata is
    // an explicit allowlist — never a spread of the entity — so a future field
    // on SceneGeneration cannot leak into the log, and no prompt text, provider
    // secret, prediction id, temporary URL, or storage key is present. If the
    // audit sink fails here the error propagates; the row stays and the job
    // stays enqueued (no rollback, no second enqueue) — a documented consistency
    // window, per ADR-0017.
    await recordAudit(this.deps.identity, {
      organizationId,
      actorUserId,
      action: GenerationAuditAction.GenerationRequested,
      resourceType: GENERATION_AUDIT_RESOURCE_TYPE,
      resourceId: created.id,
      metadata: {
        videoProjectId: created.videoProjectId,
        sourceStoryboardSceneId: created.sourceStoryboardSceneId,
        assetId: created.assetId,
        sourceAnalysisRevision: created.sourceAnalysisRevision,
        durationSeconds: scene.durationSeconds,
        requestHash: created.requestHash,
        providerName: created.providerName,
        providerModelId: created.providerModelId,
        state: created.state,
      },
    });

    return created;
  }

  /**
   * Reconcile a create that lost the active-request race.
   *
   * The winner is another attempt for the same identity that landed first. Re-read
   * active, then succeeded; either is returned as the outcome of this request,
   * and neither is enqueued or audited again by the loser. If neither is found,
   * the winner reached a terminal-but-not-succeeded state in the gap (or a
   * genuine infrastructure inconsistency occurred). That is not an invalid
   * request, so it is a neutral INTERNAL_ERROR — never VALIDATION_FAILED — with a
   * message that names no id, hash, tenant, provider, or database detail.
   */
  private async reconcileConflict(
    organizationId: string,
    videoProjectId: string,
    requestHash: string,
  ): Promise<SceneGeneration> {
    const winner = await this.deps.generations.findActiveByRequestIdentity(
      organizationId,
      videoProjectId,
      requestHash,
    );
    if (winner) return winner;

    const succeededWinner = await this.deps.generations.findLatestSucceededByRequestIdentity(
      organizationId,
      videoProjectId,
      requestHash,
    );
    if (succeededWinner) return succeededWinner;

    throw new AppError(
      "INTERNAL_ERROR",
      "The generation request could not be completed; please try again",
    );
  }

  /**
   * Assemble the capability question for this scene.
   *
   * Duration and camera motion are the scene's (the scene is the unit that gets
   * generated); resolution, aspect ratio and the negative prompt are the
   * project's. The negative prompt is the stored project value — equivalent by
   * construction to the compiled prompt's user-negative, since both apply the
   * same blank-is-absent rule — so nothing here parses `compiledPrompt`.
   */
  private settingsFor(project: VideoProject, scene: StoryboardScene): GenerationRequestSettings {
    return {
      durationSeconds: scene.durationSeconds,
      resolution: project.resolution,
      aspectRatio: project.aspectRatio,
      cameraMotion: scene.cameraMotion,
      negativePrompt: project.negativePrompt,
    };
  }
}
