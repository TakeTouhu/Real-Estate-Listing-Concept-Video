/**
 * The durable composition-execution record: what the platform has actually done
 * about turning one frozen deliverable plan into one managed final object.
 *
 * ## The lifecycle
 *
 * ```text
 * (absent)         → a COMPOSITION_PENDING job whose plan nobody has claimed
 * PENDING          → eligible again at or after nextAttemptAt
 * RUNNING          → one worker holds a lease
 * BLOCKED          → automatic execution cannot progress against these facts
 * OUTPUT_VERIFIED  → canonical final bytes exist, with a SHA-256 receipt
 * ```
 *
 * ## `PENDING` is for transient failures only
 *
 * The split between `PENDING` and `BLOCKED` is the difference between "try again
 * later" and "trying again cannot help". A source object that could not be read
 * this minute may read fine in five; a plan whose frozen source bytes total
 * three gigabytes will total three gigabytes forever. Deferring the second kind
 * produces an automatic infinite retry the moment a scheduler exists — the work
 * is re-offered every five minutes, fails identically every time, and nothing
 * in the system ever says so.
 *
 * So a deterministic refusal terminates automatic work with a closed
 * `blockCode`, and `PENDING` is never used as a generic "something went wrong".
 *
 * ## What `OUTPUT_VERIFIED` does and does not claim
 *
 * It claims exactly this: an object exists at the canonical deliverable key, and
 * its digest and byte count were established by reading the bytes that are
 * actually there.
 *
 * It does **not** claim the file is playable, that the container is well formed,
 * that a customer may see it, that the deliverable pointer moved, or that
 * anything was billed. Deliverable-level media validation is Phase 5C's, and it
 * deliberately does not reuse `ManagedOutputMediaValidation` — that record is
 * one-to-one with a *provider attempt*, and a composed deliverable is not one.
 *
 * ## `BLOCKED` is not customer failure
 *
 * There is no `FAILED` here, and `BLOCKED` is not one. It terminates *this
 * phase's automatic work* and nothing else: the job does not become
 * `FAILED_TERMINAL`, no unit is consumed, no reservation is released, the
 * deliverable pointer does not move, and no customer-facing failure is recorded.
 *
 * The reason is sharpest for recomposition: the customer may already hold a
 * perfectly good video while a regeneration's replacement cannot be encoded.
 * Terminalizing that job would destroy a deliverable they already have, and
 * settling an entitlement over an encoder limit charges the platform's problem
 * to them. A settlement policy for permanently uncomposable deliverables is a
 * separate, reviewed decision, and Phase 5B deliberately does not implement an
 * unblock operation either — an operator path is its own reviewed surface.
 */

import { AppError } from "@app/shared";

/** The closed durable status vocabulary. Nothing else may be persisted. */
export const COMPOSITION_STATUSES = [
  "PENDING",
  "RUNNING",
  "BLOCKED",
  "OUTPUT_VERIFIED",
] as const;
export type DeliverableCompositionStatus = (typeof COMPOSITION_STATUSES)[number];

/**
 * Why a composition attempt stopped and will be tried again, in a closed
 * application vocabulary.
 *
 * `lastRetryCode` means exactly one thing: *why this work is currently deferred
 * for automatic retry*. It is therefore cleared the moment the work stops being
 * deferred — on claim, and on block — rather than kept as a trailing note about
 * an earlier attempt. `attemptCount` already records that the work was tried,
 * and a column that sometimes means "why it is waiting" and sometimes means
 * "what once went wrong" is a column no operator can read. Retry-reason history
 * is a separate audited design, not an overload of this field.
 *
 * Every member is a *class* of operational failure, not a description of one.
 * No ffmpeg stderr, no S3 message, no OS errno, no path, no bucket, no customer
 * text ever becomes one of these — the whole point of a closed list is that the
 * column cannot grow a free-text field by accident, and the most widely read
 * table in an incident is the wrong place to discover a customer's filename.
 */
export const COMPOSITION_RETRY_CODES = [
  /** A canonical source object could not be read this time. */
  "SOURCE_READ_RETRYABLE",
  /** The composer ran and did not produce a usable result. */
  "COMPOSER_RETRYABLE",
  /** The composed object could not be published or re-read this time. */
  "OUTPUT_PUBLISH_RETRYABLE",
] as const;
export type DeliverableCompositionRetryCode = (typeof COMPOSITION_RETRY_CODES)[number];

export function isCompositionRetryCode(
  value: unknown,
): value is DeliverableCompositionRetryCode {
  return (
    typeof value === "string" &&
    (COMPOSITION_RETRY_CODES as readonly string[]).includes(value)
  );
}

/**
 * Why automatic composition stopped for good, in a closed vocabulary.
 *
 * Every member is *deterministic against the currently durable facts*: the plan
 * is immutable, the profile is frozen, and the canonical source objects are
 * first-wins, so re-running the identical work would reach the identical answer.
 * That is the whole distinction from a retry code — these say "later will not be
 * different", and putting one of them in `lastRetryCode` would manufacture an
 * infinite automatic loop.
 */
export const COMPOSITION_BLOCK_CODES = [
  /** The plan's frozen source bytes exceed what one worker may materialize. */
  "SOURCE_BYTES_LIMIT_EXCEEDED",
  /** The frozen scene durations do not sum to the job's requested duration. */
  "DURATION_INVARIANT_MISMATCH",
  /** A canonical source object's bytes no longer match the frozen receipt. */
  "SOURCE_INTEGRITY_MISMATCH",
  /** The composed object exceeds the deliverable ceiling. */
  "OUTPUT_SIZE_LIMIT_EXCEEDED",
] as const;
export type DeliverableCompositionBlockCode = (typeof COMPOSITION_BLOCK_CODES)[number];

export function isCompositionBlockCode(
  value: unknown,
): value is DeliverableCompositionBlockCode {
  return (
    typeof value === "string" &&
    (COMPOSITION_BLOCK_CODES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// The canonical deliverable object key
// ---------------------------------------------------------------------------

declare const managedDeliverableOutputKeyBrand: unique symbol;

/**
 * A canonical key for one composed deliverable, produced only by
 * {@link managedDeliverableOutputKey}.
 *
 * Deliberately a **different brand** from `ManagedGenerationOutputKey`. A
 * provider attempt's output and a composed deliverable are different identities
 * with different lifecycles, and a single type covering both would let a
 * deliverable be published over an attempt's object — or an attempt's key be
 * handed to the deliverable publisher — with the compiler's blessing. Widening
 * either brand to a plain string to make them interchangeable would throw away
 * the only structural defence there is.
 */
export type ManagedDeliverableOutputKey = string & {
  readonly [managedDeliverableOutputKeyBrand]: "ManagedDeliverableOutputKey";
};

/**
 * The one place a string becomes a deliverable key.
 *
 * ```text
 * org/{organizationId}/deliverables/{deliverableVersionId}/output
 * ```
 *
 * Two identifiers, both application-generated, and nothing else. No project or
 * property name, no customer filename, no timestamp, no ordinal: a key built
 * from external text is a path traversal and a cross-tenant write waiting for
 * the first unexpected input, and a key carrying an ordinal would change if the
 * ordinal were ever recomputed. The deliverable version id is immutable, so the
 * key is too.
 *
 * Extensionless, for the same reason the generation key is: the receipt proves a
 * digest and a byte count, not a container. Phase 5B *intends* MP4 and sets the
 * object's content type accordingly, but the key asserts nothing a later
 * validation has not yet established.
 */
export function managedDeliverableOutputKey(input: {
  readonly organizationId: string;
  readonly deliverableVersionId: string;
}): ManagedDeliverableOutputKey {
  if (
    input.organizationId.trim().length === 0 ||
    input.deliverableVersionId.trim().length === 0
  ) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Managed deliverable key requires a non-blank organization and deliverable version id",
    );
  }
  return [
    "org",
    input.organizationId,
    "deliverables",
    input.deliverableVersionId,
    "output",
  ].join("/") as ManagedDeliverableOutputKey;
}

/** The content type the canonical deliverable object is stored with. */
export const DELIVERABLE_OUTPUT_CONTENT_TYPE = "video/mp4";

// ---------------------------------------------------------------------------
// Resource bounds
// ---------------------------------------------------------------------------

/**
 * The most local disk one composition may consume for its *sources*, 2 GiB.
 *
 * Checked by the runner against the sum of the plan's frozen `sourceSizeBytes`
 * after the claim and **before any external adapter is called**, so an
 * oversized deliverable costs nothing rather than filling a worker's disk and
 * taking unrelated work down with it.
 *
 * The comparison is of frozen numbers against a constant, so its answer never
 * changes: an overrun is `BLOCKED / SOURCE_BYTES_LIMIT_EXCEEDED`, never a
 * deferral. Deferring it would re-offer the identical arithmetic every five
 * minutes forever.
 *
 * A machine-resource limit, not a product or billing rule. It says what one
 * worker will hold at once; it does not say what a customer may buy. Raising it
 * is a deployment decision, and a row blocked under the old value stays blocked
 * until an operator path exists — this phase deliberately has none.
 */
export const MAX_DELIVERABLE_COMPOSITION_SOURCE_BYTES = 2 * 1_073_741_824;

/** The largest composed object that may be published, 512 MiB. */
export const MAX_DELIVERABLE_OUTPUT_BYTES = 536_870_912;

// ---------------------------------------------------------------------------
// Lease, retry and batch bounds
// ---------------------------------------------------------------------------

/**
 * Thirty minutes by default, two hours at most.
 *
 * Crash recovery, not a deadline: it says how long the system waits before
 * assuming the owner died. It is deliberately far longer than the media
 * lifecycle's lease because this work downloads gigabytes and runs an encoder,
 * and it must always exceed the configured composer timeout plus the I/O around
 * it — otherwise a healthy long encode gets its lease stolen and two workers
 * encode the same deliverable for no reason. There is no heartbeat in this
 * phase; duplicate execution is tolerable because the plan and profile are
 * immutable, publication is first-wins, and finalize is CAS-protected.
 */
export const DEFAULT_COMPOSITION_LEASE_MS = 30 * 60_000;
export const MAX_COMPOSITION_LEASE_MS = 2 * 60 * 60_000;

export function validateCompositionLeaseMs(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 60_000 ||
    value > MAX_COMPOSITION_LEASE_MS
  ) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      `Composition lease must be an integer between 60000 and ${MAX_COMPOSITION_LEASE_MS} milliseconds`,
    );
  }
  return value;
}

/** Five minutes before a deferred composition becomes eligible again. */
export const DEFAULT_COMPOSITION_RETRY_DELAY_MS = 5 * 60_000;
export const MAX_COMPOSITION_RETRY_DELAY_MS = 60 * 60_000;

export function validateCompositionRetryDelayMs(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1_000 ||
    value > MAX_COMPOSITION_RETRY_DELAY_MS
  ) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      `Composition retry delay must be an integer between 1000 and ${MAX_COMPOSITION_RETRY_DELAY_MS} milliseconds`,
    );
  }
  return value;
}

/** The largest candidate batch one sweep may claim. */
export const MAX_COMPOSITION_BATCH_SIZE = 25;

/**
 * Prove a candidate-query limit is usable, or refuse.
 *
 * Not clamping: silently substituting 25 for 5000 lets a caller believe it swept
 * far more than it did. `Number.isSafeInteger` rejects `NaN`, both infinities,
 * fractions and anything past 2^53-1 — every value a SQL `LIMIT` must never see.
 */
export function validateCompositionBatchLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_COMPOSITION_BATCH_SIZE) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Composition batch limit must be an integer between 1 and ${MAX_COMPOSITION_BATCH_SIZE}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Defects
// ---------------------------------------------------------------------------

/**
 * The fixed defect codes composition execution may raise.
 *
 * Each is an internal consistency violation — a state the application believes
 * it cannot produce — or a deployment fault. None carries customer input,
 * provider text, a storage location or an id, and none is repaired.
 */
export type DeliverableCompositionExecutionDefectCode =
  /** The frozen plan and the rows it names no longer agree. */
  | "PLAN_SOURCE_DISAGREEMENT"
  /** A job awaiting composition has no plan, or a partial one. */
  | "PLAN_NOT_EXECUTABLE"
  /** Work, job and deliverable disagree about whether composition finished. */
  | "PARTIAL_COMPOSITION_STATE"
  /** A finalize re-presented a different receipt for an already-verified object. */
  | "OUTPUT_RECEIPT_CONFLICT"
  /** A block re-presented a different code for an already-blocked row. */
  | "COMPOSITION_BLOCK_CONFLICT"
  /** The job's current deliverable pointer moved during composition. */
  | "CURRENT_DELIVERABLE_POINTER_MOVED";

const DEFECT_MESSAGES: Record<DeliverableCompositionExecutionDefectCode, string> = {
  PLAN_SOURCE_DISAGREEMENT:
    "A frozen composition input no longer agrees with the durable rows it names",
  PLAN_NOT_EXECUTABLE:
    "A job awaiting composition has no complete durable plan to execute",
  PARTIAL_COMPOSITION_STATE:
    "Composition work, job and deliverable disagree about whether composition completed",
  OUTPUT_RECEIPT_CONFLICT:
    "A composed deliverable already carries a different durable output receipt",
  COMPOSITION_BLOCK_CONFLICT:
    "A blocked composition already carries a different durable block reason",
  CURRENT_DELIVERABLE_POINTER_MOVED:
    "Composition execution changed the job's current deliverable pointer",
};

export class DeliverableCompositionExecutionDefect extends Error {
  readonly code: DeliverableCompositionExecutionDefectCode;

  constructor(code: DeliverableCompositionExecutionDefectCode) {
    super(DEFECT_MESSAGES[code]);
    this.name = "DeliverableCompositionExecutionDefect";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Event vocabulary
// ---------------------------------------------------------------------------

/** Fixed application-owned event types. Nothing external reaches these. */
export const DELIVERABLE_COMPOSING_EVENT_TYPE = "deliverable.composing";
export const DELIVERABLE_OUTPUT_VERIFIED_EVENT_TYPE = "deliverable.output_verified";
export const JOB_COMPOSING_EVENT_TYPE = "job.composing";
export const JOB_DELIVERABLE_VALIDATING_EVENT_TYPE = "job.deliverable_validating";

/** The states a deliverable aggregate is recorded as entering. */
export const DELIVERABLE_COMPOSING_STATE = "COMPOSING";
export const DELIVERABLE_OUTPUT_VERIFIED_STATE = "OUTPUT_VERIFIED";

// Blocking appends **no** transition event, and there is deliberately no
// `COMPOSITION_BLOCKED` state in either vocabulary.
//
// The job really does stay `COMPOSING`, so a job event would assert a state
// change that did not happen; and inventing a deliverable lifecycle state to
// carry the fact would put a value in the transition-event stream that no
// reviewed state machine contains, which every later reader would then have to
// interpret. The durable work row already says it exactly — `status = BLOCKED`
// with a `blockCode` and a `blockedAt` — and a future operator recovery
// lifecycle can introduce a reviewed event model if it needs one.

/** The reason code recorded on every composition-execution transition. */
export const COMPOSITION_EXECUTION_REASON_CODE = "DELIVERABLE_COMPOSITION_EXECUTION";
