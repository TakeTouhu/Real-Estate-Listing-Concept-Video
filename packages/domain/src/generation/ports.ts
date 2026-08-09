import type { SceneGeneration, SceneGenerationState } from "./types";

/**
 * A generation attempt as it is first written. `createdAt` and `updatedAt` are
 * database-managed, matching the convention the other repositories use.
 */
export type NewSceneGeneration = Omit<SceneGeneration, "createdAt" | "updatedAt">;

/**
 * The fields a caller may change on a generation attempt — and nothing else.
 *
 * Identity and provenance are not merely ignored when supplied, they **cannot
 * be expressed**: `videoProjectId`, `requestHash`, `sourceStoryboardSceneId`,
 * `assetId`, `sourceAnalysisRevision`, `providerName` and `providerModelId` are
 * absent from this type, so "re-point this attempt at another project" or
 * "rewrite the request identity" is a compile error rather than a silent write.
 * That matters more here than elsewhere: the request identity is what stops a
 * second billed provider call, and an attempt that could be re-labelled after
 * the fact would make the audit trail of a paid call unreliable.
 *
 * `createdAt` and `updatedAt` are absent too — `updatedAt` is database-managed,
 * and writing back an in-memory copy would freeze the column.
 *
 * Every field is optional and **an absent key means "leave alone"**. That is
 * what gives {@link SceneGenerationRepository.update} its most important
 * property: advancing `state` cannot disturb `providerPredictionId`, because a
 * key that was never supplied is never written.
 */
export interface SceneGenerationUpdate {
  readonly state?: SceneGenerationState;
  /**
   * Explicitly settable and explicitly clearable, never touched implicitly.
   *
   * A known prediction id **outlives `PROCESSING`**: it stays meaningful on a
   * `SUCCEEDED`, `FAILED_RETRYABLE` or `FAILED_TERMINAL` row, because that is
   * what identifies the provider-side work that was actually paid for. Nothing
   * in this layer clears it as a side effect of a state change; only a caller
   * passing `null` on purpose does.
   */
  readonly providerPredictionId?: string | null;
  readonly submittedAt?: Date | null;
  readonly lastPolledAt?: Date | null;
  readonly normalizedErrorCode?: string | null;
  readonly normalizedErrorMessage?: string | null;
  readonly outputStorageKey?: string | null;
}

/**
 * Persistence port for scene-generation attempts.
 *
 * Deliberately four methods. There is no `delete` (generation history is
 * retained — it can record a paid call), no generic `save` (that would defeat
 * {@link SceneGenerationUpdate}), no listing (no caller needs one yet), and no
 * worker-claim method (the worker is a later milestone and its claiming
 * strategy is not decided).
 *
 * Every operation takes `organizationId` as an **addressing argument**, never
 * as payload. `SceneGeneration` carries no organization column: tenant scope is
 * resolved through the owning `VideoProject` inside the query itself, so a read
 * that forgets to scope is a missing predicate rather than a silently
 * unfiltered result.
 *
 * The port persists what it is asked to persist. It does **not** re-implement
 * the Phase 4A-1 transition table: whether a requested state change is legal is
 * the orchestration layer's question, answered with `assertTransition`.
 */
export interface SceneGenerationRepository {
  /**
   * Persist a new attempt under a project this organization owns.
   *
   * `organizationId` is an addressing argument here for the same reason it is
   * on every other method, and its absence would be a tenant hole rather than a
   * convenience: `input.videoProjectId` is caller-supplied, so without an
   * ownership check a caller could write an attempt into **another tenant's**
   * project. Worse, it could then read that tenant's state back out — a
   * colliding request would answer {@link ActiveGenerationConflictError}, which
   * discloses that the other organization has an attempt in flight for that
   * exact request.
   *
   * The ownership check therefore runs **before** the insert, so a foreign
   * caller never reaches the active-request index at all.
   *
   * @throws {SceneGenerationNotFoundError} when this organization owns no
   * project with that id — whether it does not exist or belongs elsewhere.
   * @throws {ActiveGenerationConflictError} when the project *is* this
   * organization's and an active attempt already holds this
   * `(videoProjectId, requestHash)`. The database decides that, not a prior
   * read — see the error's own note.
   */
  create(organizationId: string, input: NewSceneGeneration): Promise<SceneGeneration>;

  /** The attempt, or `null` when it does not exist **or** belongs elsewhere. */
  findById(organizationId: string, id: string): Promise<SceneGeneration | null>;

  /**
   * The active attempt holding this request identity, if there is one.
   *
   * A **convenience lookup**, not a concurrency control. The partial unique
   * index is the authoritative invariant, so a caller must never treat
   * `find` → `if absent` → `create` as its idempotency guarantee: two callers
   * can both find nothing. `create` still has to handle the collision.
   */
  findActiveByRequestIdentity(
    organizationId: string,
    videoProjectId: string,
    requestHash: string,
  ): Promise<SceneGeneration | null>;

  /**
   * Apply execution-field changes to one attempt.
   *
   * @throws {SceneGenerationNotFoundError} when no row in this organization has
   * that id — whether because it does not exist or because it belongs to
   * another tenant. The two are deliberately indistinguishable.
   */
  update(
    organizationId: string,
    id: string,
    changes: SceneGenerationUpdate,
  ): Promise<SceneGeneration>;
}

/**
 * Raised when a write would leave two **active** attempts holding one request
 * identity.
 *
 * The rule is enforced by a partial unique index, but *recognizing* the
 * violation is storage-specific — a driver error code, a set of covered fields.
 * That interpretation belongs in the adapter; callers react to this neutral
 * type and stay free of database vocabulary.
 *
 * It means exactly one thing: this request already has an attempt in flight (or
 * in `SUBMISSION_UNKNOWN`, or awaiting a safe retry). It is **not** a general
 * uniqueness error, and the adapter must not map every collision onto it.
 */
export class ActiveGenerationConflictError extends Error {
  constructor(message = "An active generation attempt already exists for this request") {
    super(message);
    this.name = "ActiveGenerationConflictError";
  }
}

/**
 * Raised when an update addresses a generation this organization cannot see.
 *
 * A distinct type rather than the plain `Error` the older repositories throw,
 * for a concrete reason: this record drives worker orchestration, and a worker
 * has to tell "the row is gone or not mine" apart from "the database failed"
 * to classify a retry correctly. Matching error-message strings to make that
 * decision would be a latent bug waiting on a wording change.
 *
 * The message is deliberately generic and constant. It names no id, no
 * organization, and no database detail, because an unknown id and another
 * tenant's id must produce **the same** error — anything else would let a
 * caller probe for the existence of rows it may not see.
 *
 * Scoped to this module on purpose. The older repositories keep their plain
 * `Error`; aligning them is a separate, layer-wide decision.
 */
export class SceneGenerationNotFoundError extends Error {
  constructor(message = "Scene generation not found") {
    super(message);
    this.name = "SceneGenerationNotFoundError";
  }
}
