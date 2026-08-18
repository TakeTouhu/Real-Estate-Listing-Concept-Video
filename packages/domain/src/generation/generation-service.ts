import { AppError } from "@app/shared";
import { recordAudit } from "../identity/audit";
import { authorizeOrganization } from "../identity/authorization";
import type { IdentityServiceDeps, IdGenerator } from "../identity/ports";
import { assertApprovedCameraMotion } from "../storyboard/camera-motion";
import { renderPrompt } from "./prompt-render";
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
import type { SceneGeneration } from "./types";

export interface GenerationServiceDeps {
  /** Supplies membership lookup (authorization) and the audit sink. */
  readonly identity: IdentityServiceDeps;
  /** The narrow storyboard slice: freshness and the scoped project + scenes. */
  readonly storyboard: StoryboardReader;
  readonly generations: SceneGenerationRepository;
  readonly capabilities: VideoModelCapabilityProvider;
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
 * this service only records the intent durably.
 *
 * **There is no queue transport.** The `QUEUED` row *is* the durable handoff: a
 * worker discovers executable work by its state, not by a message someone sent
 * it (ADR-0024). Admission therefore has nothing to hand off and nothing that
 * can fail in transit — it creates the row, audits it, and returns.
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
   * 1. authorize `property:write` — before any read, capability lookup, write
   *    or audit;
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
   * 11. otherwise `create` (at most once), then `audit`.
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
    // including SUBMISSION_UNKNOWN — is returned as-is. Nothing is created and
    // nothing is audited. A `QUEUED` row returned here is already executable
    // work by virtue of its state, so there is nothing to re-deliver.
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
   * Create the row, then audit it.
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
    // Render the provider prompt exactly once, here, for a genuinely new
    // attempt — after both reuse lookups, because a reused row already carries
    // its own frozen prompt and re-rendering for it would be both wasteful and
    // wrong: a corrupt snapshot must not stop a caller from being handed an
    // attempt that already exists.
    //
    // `renderPrompt` validates the stored structure and fails closed, so a
    // corrupt or legacy compiled prompt refuses **before** any row exists and
    // before any audit. From here on the worker submits this
    // exact string and never runs the renderer again (ADR-0023).
    const renderedPrompt = renderPrompt(compiledPrompt);

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
      // The execution artifact: what will actually be sent, frozen alongside
      // what was asked for. Renderer changes after this point apply to new
      // admissions only (ADR-0023).
      requestRenderedPrompt: renderedPrompt,
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

    // The row is now durable in `QUEUED`, which is the whole acceptance
    // condition: a worker discovers it by state (ADR-0024). Nothing is handed
    // to a transport, so nothing can be lost between here and execution.
    //
    // The audit therefore comes last, and the consistency window it leaves is
    // narrower than the one it replaces but still real: if this throws, the
    // error propagates while the row stays executable and un-audited. That
    // direction is deliberate. Eligibility is `state`, never audit existence —
    // gating execution on an audit row would turn a failing audit sink into
    // silent cancellation of durable customer work. The paid call itself is
    // audited by the worker at submission time, so a provider is never charged
    // without an audit entry for that charge (ADR-0024 §4).
    //
    // Metadata stays an explicit allowlist — never a spread of the entity — so
    // a future field on SceneGeneration cannot leak into the log, and no prompt
    // text, provider secret, prediction id, temporary URL, or storage key is
    // present.
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
   * and neither is audited again by the loser. If neither is found,
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
