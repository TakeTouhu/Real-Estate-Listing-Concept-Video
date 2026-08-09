/**
 * Types for one **attempt** to generate one scene through a video provider.
 *
 * Phase 4A-1 is pure domain: no persistence, no provider call, no worker. What
 * lives here is the vocabulary the persistence layer (4A-2), the orchestration
 * service (4B) and the worker (4C) all have to agree on.
 */

/**
 * The lifecycle of one scene-generation attempt.
 *
 * The vocabulary is deliberately small, and every member exists because the
 * *external* call has that semantic — not because a workflow diagram wanted a
 * box.
 *
 * - `QUEUED` — the local job exists; the provider POST has not begun.
 * - `SUBMITTING` — the provider submission POST is in progress.
 * - `PROCESSING` — a provider prediction id is known, so status may be polled.
 * - `SUCCEEDED` — terminal.
 * - `FAILED_RETRYABLE` — the failure is *known* to be safe to retry; the job
 *   may later return to `QUEUED`.
 * - `FAILED_TERMINAL` — terminal.
 * - `SUBMISSION_UNKNOWN` — the POST may have been accepted, and therefore
 *   billed, but no prediction id was safely obtained. See
 *   {@link ACTIVE_SCENE_GENERATION_STATES} and ADR-0016.
 * - `CANCELLED` — pre-submission cancellation only, for the Phase 4 MVP.
 */
export type SceneGenerationState =
  | "QUEUED"
  | "SUBMITTING"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL"
  | "SUBMISSION_UNKNOWN"
  | "CANCELLED";

/** Every state, for exhaustive iteration in tests and in 4A-2's enum. */
export const SCENE_GENERATION_STATES: readonly SceneGenerationState[] = [
  "QUEUED",
  "SUBMITTING",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED_RETRYABLE",
  "FAILED_TERMINAL",
  "SUBMISSION_UNKNOWN",
  "CANCELLED",
];

/**
 * The facts that define **what would be generated**, and therefore what makes
 * two requests the same paid request.
 *
 * Everything here is already available on `VideoProject` and `StoryboardScene`
 * today. There are deliberately **no provider capability constants**: which
 * model the product ships on is Phase 4B's provider-fit review, and this module
 * only records *which* provider and model a request was addressed to.
 *
 * `compiledPrompt` is the persisted structured generation input — the exact
 * canonical JSON `StoryboardService` stored — not rendered provider prose.
 * Identity is textual, not semantic: two prompts that a human would call
 * equivalent are different requests, because proving otherwise is not something
 * this function can do.
 */
export interface GenerationRequestFacts {
  readonly assetId: string;
  /** The persisted canonical `CompiledPrompt` JSON, exactly as stored. */
  readonly compiledPrompt: string;
  readonly durationSeconds: number;
  readonly cameraMotion: string | null;
  readonly aspectRatio: string;
  readonly resolution: string;
  readonly providerName: string;
  readonly providerModelId: string;
}

/**
 * The immutable facts a persisted generation attempt carries so it can be
 * understood **without dereferencing the storyboard scene it came from**.
 *
 * That is not defensive over-modelling. `StoryboardService.compose` replaces a
 * project's scenes wholesale — `replaceForProject` deletes every row and
 * re-inserts with freshly generated ids — so an ordinary recomposition destroys
 * the scene a generation attempt was made from. An attempt may represent a paid
 * external call, so it has to outlive that. Hence no foreign key to
 * `StoryboardScene` and the deliberately non-relational field name below
 * (ADR-0016).
 *
 * Tenant ownership comes from the owning `VideoProject`, which is persistent —
 * never from a denormalized organization column.
 *
 * This is the minimum, not a scene snapshot: position, room type and duration
 * are not copied here. `requestHash` already fixes everything that decides what
 * would be generated, and a full snapshot would be history-keeping nobody has
 * asked for.
 */
export interface SceneGenerationProvenance {
  /**
   * Provenance only. **Not a foreign key** — the referenced row is routinely
   * deleted by recomposition, and this attempt must survive that.
   */
  readonly sourceStoryboardSceneId: string;
  readonly assetId: string;
  /** Which analysis revision the scene was composed from. Not request identity. */
  readonly sourceAnalysisRevision: number;
  /** Local idempotency identity, unique per project among active attempts. */
  readonly requestHash: string;
  /** Internal only. Never reaches a customer-facing DTO. */
  readonly providerName: string;
  /** Internal only. Never reaches a customer-facing DTO. */
  readonly providerModelId: string;
}
