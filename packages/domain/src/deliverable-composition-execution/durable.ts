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
 * OUTPUT_VERIFIED  → canonical final bytes exist, with a SHA-256 receipt
 * ```
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
 * ## No terminal failure state, on purpose
 *
 * There is no `FAILED` here. A composition that cannot complete is *operational
 * work*, not a verdict about the customer's job, and the reason is sharpest for
 * recomposition: the customer may already hold a perfectly good video while a
 * regeneration's replacement fails to encode. Terminalizing that job would
 * destroy a deliverable the customer already has, and consuming or releasing an
 * entitlement over an encoder failure charges the platform's problem to them.
 * So failures defer with a closed code and wait for a retry or an operator. A
 * settlement policy for permanently unencodable deliverables is a separate,
 * reviewed decision.
 */

import { AppError } from "@app/shared";

/** The closed durable status vocabulary. Nothing else may be persisted. */
export const COMPOSITION_STATUSES = ["PENDING", "RUNNING", "OUTPUT_VERIFIED"] as const;
export type DeliverableCompositionStatus = (typeof COMPOSITION_STATUSES)[number];

/**
 * Why a composition attempt stopped, in a closed application vocabulary.
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
  /** A source object's bytes no longer match the receipt the plan froze. */
  "SOURCE_INTEGRITY_MISMATCH",
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
 * Checked against the sum of the plan's frozen `sourceSizeBytes` **before any
 * download starts**, so an oversized deliverable costs nothing rather than
 * filling a worker's disk and taking unrelated work down with it.
 *
 * A machine-resource limit, not a product or billing rule. It says what one
 * worker will hold at once; it does not say what a customer may buy.
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
  /** Scene durations do not sum to the job's frozen requested duration. */
  | "SCENE_DURATION_SUM_MISMATCH"
  /** A job awaiting composition has no plan, or a partial one. */
  | "PLAN_NOT_EXECUTABLE"
  /** The job's frozen delivery target is outside composition profile v1. */
  | "UNSUPPORTED_COMPOSITION_TARGET"
  /** Work, job and deliverable disagree about whether composition finished. */
  | "PARTIAL_COMPOSITION_STATE"
  /** A finalize re-presented a different receipt for an already-verified object. */
  | "OUTPUT_RECEIPT_CONFLICT"
  /** The job's current deliverable pointer moved during composition. */
  | "CURRENT_DELIVERABLE_POINTER_MOVED";

const DEFECT_MESSAGES: Record<DeliverableCompositionExecutionDefectCode, string> = {
  PLAN_SOURCE_DISAGREEMENT:
    "A frozen composition input no longer agrees with the durable rows it names",
  SCENE_DURATION_SUM_MISMATCH:
    "The planned scene durations do not sum to the job's requested duration",
  PLAN_NOT_EXECUTABLE:
    "A job awaiting composition has no complete durable plan to execute",
  UNSUPPORTED_COMPOSITION_TARGET:
    "The job's frozen delivery target is not composable under this profile version",
  PARTIAL_COMPOSITION_STATE:
    "Composition work, job and deliverable disagree about whether composition completed",
  OUTPUT_RECEIPT_CONFLICT:
    "A composed deliverable already carries a different durable output receipt",
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

/** The reason code recorded on every composition-execution transition. */
export const COMPOSITION_EXECUTION_REASON_CODE = "DELIVERABLE_COMPOSITION_EXECUTION";
