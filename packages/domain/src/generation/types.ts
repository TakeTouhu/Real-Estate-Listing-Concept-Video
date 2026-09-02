/**
 * Types for one **attempt** to generate one scene through a video provider.
 *
 * Phase 4A-1 is pure domain: no persistence, no provider call, no worker. What
 * lives here is the vocabulary the persistence layer (4A-2), the orchestration
 * service (4B) and the worker (4C) all have to agree on.
 */

import type { ResolutionNormalization, TargetOutputResolution } from "./model-catalog";

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
 *
 * **V2.** There used to be a single `resolution: string` here, and it was
 * ambiguous: for the only wired model, what the customer asked for and what the
 * provider was told to generate were the same string, so one field could stand
 * for both. It cannot once a second model exists — H3 Max serves a 1080p target
 * from a 768P generation — so the one field is replaced by five explicit facts
 * and there is deliberately **no `resolution` alias** left to fall back on
 * (ADR-0034). All five are hashed; see `computeGenerationRequestHash` for why
 * the two derivable ones are included on purpose.
 */
export interface GenerationRequestFacts {
  readonly assetId: string;
  /** The persisted canonical `CompiledPrompt` JSON, exactly as stored. */
  readonly compiledPrompt: string;
  readonly durationSeconds: number;
  readonly cameraMotion: string | null;
  readonly aspectRatio: string;
  /** The product deliverable the customer asked for. A quality class. */
  readonly targetOutputResolution: TargetOutputResolution;
  /** The provider's own token for what the model is asked to generate. */
  readonly nativeGenerationResolution: string;
  /** How the native generation reaches the target. Delivery semantics. */
  readonly resolutionNormalization: ResolutionNormalization;
  /** `false` means the delivered file carries the size but not the detail. */
  readonly nativeMeetsTarget: boolean;
  /** The catalog's stable internal key — what was selected, not where it lives. */
  readonly modelKey: string;
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

/**
 * The immutable **execution snapshot**: everything needed to rebuild the exact
 * provider request this attempt was admitted for, taken at admission and never
 * changed afterwards.
 *
 * This exists because {@link SceneGenerationProvenance} alone cannot rebuild a
 * request. `requestHash` is a one-way digest — it *identifies* a request and
 * cannot reconstruct one — and the row it came from is not reachable later:
 * `sourceStoryboardSceneId` is provenance with no foreign key, and
 * recomposition deletes every scene of a project. Project settings are worse
 * than unreachable, they are *mutable*: `VideoProjectUpdate` can change
 * `aspectRatio` and `resolution` after admission, so reading them at execution
 * time could submit — and pay for — a request the customer never approved under
 * this identity. "Still queryable later" is not "safe to read later" (ADR-0018).
 *
 * The set is exactly the {@link GenerationRequestFacts} not already persisted
 * elsewhere on the row. Together with `assetId`, `providerName` and
 * `providerModelId`, an attempt therefore carries every hash fact and can
 * **recompute its own `requestHash`** — an invariant, not a convention.
 *
 * Nothing beyond that is copied. Scene position, room type, and project
 * presentation settings are absent because they do not reach the provider.
 *
 * Every field is nullable **only** for rows written before this snapshot
 * existed. Those legacy rows are not backfilled — fabricating a snapshot from
 * today's storyboard would forge a request that was never admitted — so `null`
 * means "this attempt predates the contract and cannot be reconstructed", and
 * consumers must fail closed rather than fall back to current state.
 */
export interface SceneGenerationRequestSnapshot {
  /**
   * The canonical `CompiledPrompt` JSON exactly as admitted, byte-identical to
   * the string that was hashed.
   *
   * Stored opaque and never re-serialized: parsing and re-encoding could change
   * the bytes and silently break the hash invariant. Rendering it into provider
   * prose is a later, single implementation at the provider boundary (ADR-0014);
   * no second representation is persisted here.
   *
   * Contains customer-authored text. Byte-identical copies already live in
   * `storyboard_scenes.compiledPrompt` and `video_projects.prompt`, so this adds
   * no new class of data — but it must never reach audit metadata, an error
   * message, or a log.
   */
  readonly requestCompiledPrompt: string | null;
  /** The scene's own allocated duration — not the project's total. */
  readonly requestDurationSeconds: number | null;
  /**
   * Null is genuinely meaningful here, not only a legacy marker: a request may
   * legitimately carry no camera motion. It is stored exactly as admitted,
   * untrimmed, matching what the hash saw.
   */
  readonly requestCameraMotion: string | null;
  /** Snapshotted because the project's value is mutable after admission. */
  readonly requestAspectRatio: string | null;
  /**
   * **V1 only, and never written again.**
   *
   * This is the ambiguous single `resolution` the identity contract used before
   * ADR-0034 — a string that meant "what the customer asked for" and "what the
   * provider generates" at the same time, which was only ever true because one
   * model happened to make them coincide.
   *
   * It is retained rather than dropped because the rows that carry it were
   * hashed over it: deleting the column would destroy the only evidence of what
   * a V1 attempt was admitted for, and rewriting those values into the V2 fields
   * would be a guess about which of the two meanings each one had. So V1 rows
   * keep it and stay unreconstructable, and a V2 row must have it `null` —
   * a row with both vocabularies populated is corruption, and the database
   * enforces that rather than trusting callers.
   */
  readonly requestResolution: string | null;
  /**
   * The V2 delivery snapshot: which model was selected, what the customer asked
   * for, and exactly how this model was going to satisfy it.
   *
   * These five are all-or-none, enforced in the database. `null` across all
   * five means the attempt was admitted under V1 and predates the contract;
   * **they are not backfilled**, because reconstructing them would mean deciding
   * what a V1 `requestResolution` meant, which is the ambiguity that caused this
   * change. Consumers fail closed (`generationRequestFactsFrom`).
   *
   * `requestModelKey` is the catalog key rather than the provider model id: the
   * id is already on the row as `providerModelId`, and the key is what execution
   * resolves the catalog by, so a vendor renaming an endpoint cannot silently
   * repoint an admitted attempt at a different entry.
   */
  readonly requestModelKey: string | null;
  readonly requestTargetOutputResolution: TargetOutputResolution | null;
  /** The provider's own token, stored verbatim and never parsed. */
  readonly requestNativeGenerationResolution: string | null;
  readonly requestResolutionNormalization: ResolutionNormalization | null;
  /**
   * Frozen at admission, not recomputed at execution.
   *
   * A later catalog correction must not be able to turn an attempt the customer
   * was told is upscaled into one described as native, or the reverse.
   */
  readonly requestNativeMeetsTarget: boolean | null;
  /**
   * The exact positive provider prompt string produced at admission.
   *
   * The other five fields fix *what was asked for*; this one fixes *what will be
   * sent*. They are not the same guarantee. `requestCompiledPrompt` is the
   * hashed structure, but the bytes a provider receives are a function of that
   * structure **and the renderer's code** — headings, section order, the
   * camera-motion phrasing, the trimming rule. None of that is in the hash, so
   * a generation admitted under one renderer and executed after a deploy could
   * have submitted text the customer's approved request never described, under a
   * hash that still validated (ADR-0020, *Consequences*).
   *
   * Rendering it once, at admission, closes that: the worker submits this string
   * verbatim and never runs the renderer for an admitted attempt. Renderer
   * changes therefore apply to new admissions only.
   *
   * Contains customer-authored text — it is a projection of
   * `requestCompiledPrompt`, whose bytes already live on the same row and on
   * `storyboard_scenes.compiledPrompt`. So it adds no new class of data, and the
   * same rule applies: never in audit metadata, an error message, or a log.
   * (Until ADR-0024 this list also named a queue payload; there is no longer a
   * transport for one to travel on.)
   *
   * Null means the attempt predates this contract. Consumers **fail closed**
   * rather than re-rendering, because re-rendering is exactly the drift this
   * field exists to prevent (see `frozenExecutionPromptFrom`).
   */
  readonly requestRenderedPrompt: string | null;
}

/**
 * One persisted attempt to generate one scene through a video provider.
 *
 * Three parts, and the split is not cosmetic. {@link SceneGenerationProvenance}
 * records *where the request came from*; {@link SceneGenerationRequestSnapshot}
 * fixes *what was asked for*, immutably, so the request survives its source
 * being deleted or edited; the fields below record *what happened* and are the
 * only ones a worker writes.
 *
 * The first two never change after admission — neither is expressible in
 * `SceneGenerationUpdate`, so re-labelling a paid attempt is a compile error.
 *
 * Ownership is the `videoProjectId` relation and nothing else. There is no
 * `organizationId` column — tenant scope resolves through the owning project,
 * exactly as `StoryboardScene`'s does, so a read that forgets to scope is a
 * missing join rather than a silently unfiltered query.
 *
 * `providerPredictionId`, `normalizedErrorCode`, `normalizedErrorMessage` and
 * `outputStorageKey` are **internal only**. None of them appears in a
 * customer-facing DTO — there is no such DTO in this milestone, and ADR-0016 §9
 * governs when there is.
 *
 * Deliberately absent: any temporary provider output URL. Phase 4D copies a
 * completed output into managed storage and persists the managed key, so a URL
 * that expires never needs to survive a worker step. Also absent: a retry
 * counter, because no worker exists yet to have a retry policy.
 */
export interface SceneGeneration
  extends SceneGenerationProvenance,
    SceneGenerationRequestSnapshot {
  readonly id: string;
  /** The persistent owner. Tenant scope resolves through this project. */
  readonly videoProjectId: string;
  readonly state: SceneGenerationState;
  /**
   * Internal only. Non-null exactly when a provider prediction is known, which
   * is what `PROCESSING` asserts.
   */
  readonly providerPredictionId: string | null;
  readonly submittedAt: Date | null;
  readonly lastPolledAt: Date | null;
  /**
   * Normalized **execution** error code. Internal diagnostics, never a customer
   * message.
   *
   * Not provider-only: a generation can fail before any provider is contacted,
   * and a preflight refusal is persisted here as its exact
   * `PreflightRefusalReason` (ADR-0027).
   */
  readonly normalizedErrorCode: string | null;
  /**
   * Sanitized **execution** error message. Internal diagnostics.
   *
   * A preflight refusal deliberately writes `null` here rather than its message
   * text: the reason code is already a closed machine-readable vocabulary, and
   * a stale message left beside a fresh code would describe a different failure
   * (ADR-0027).
   */
  readonly normalizedErrorMessage: string | null;
  /** Managed-storage key for the copied output. Null until Phase 4D. */
  readonly outputStorageKey: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
