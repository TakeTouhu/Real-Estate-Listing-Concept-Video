/**
 * The durable deliverable-validation record: what the platform has permanently
 * concluded about whether the composed final object is *media a customer may be
 * shown*.
 *
 * ## Why this is not `ManagedOutputMediaValidation`
 *
 * That record is one-to-one with a `SceneGeneration` — a single provider
 * attempt's output — and its foreign key says so. A composed deliverable is not
 * a provider attempt: it is the concatenation of many, it has its own canonical
 * key, its own receipt, and its own version history. Widening that table's
 * binding to mean "either an attempt or a deliverable" would make every existing
 * row's `sceneGenerationId` optional and every existing query ambiguous, to
 * express a relationship that is genuinely different.
 *
 * So this is its own one-to-one record against the deliverable *version*, and it
 * reuses the media vocabulary — container family, invalid reasons, normalized
 * facts — because "is this file playable video" is the same question either way.
 *
 * ## Why it binds to the version and not to the composition row
 *
 * The version is the immutable identity a customer's pointer names. The
 * composition row is execution state: it carries a lease, an attempt count and a
 * retry code, and it is the thing Phase 5B rewrites. A verdict hung off
 * execution state would be a verdict about an attempt; a verdict hung off the
 * version is a verdict about the deliverable.
 *
 * ## The lifecycle
 *
 * ```text
 * (absent)           → a DELIVERABLE_VALIDATING job whose output nobody has judged
 * PENDING            → eligible again at or after nextAttemptAt
 * RUNNING            → one worker holds a lease
 * VALID              terminal, with normalized media facts
 * INVALID_MEDIA      terminal, with exactly one closed reason
 * INTEGRITY_MISMATCH terminal, the object is no longer the bytes Phase 5B published
 * ```
 *
 * `RETRYABLE_FAILURE` is deliberately **not** a status. It is not a verdict about
 * the video; it is the absence of one, and it returns the row to `PENDING` with a
 * future instant — exactly as the scene-level lifecycle does. A storage hiccup
 * must never become a permanent record that a customer's deliverable is unusable.
 *
 * ## What a terminal non-`VALID` verdict does *not* do
 *
 * It does not fail the job, consume a unit, release the reservation or move the
 * customer's pointer. Phase 5C publishes on `VALID` and otherwise leaves the
 * durable facts exactly where they were, for the same reason Phase 5B's `BLOCKED`
 * does: during a recomposition the customer may already hold a perfectly good
 * video, and terminalizing the job over a replacement that could not be validated
 * would destroy what they already have. A settlement policy for a permanently
 * unusable deliverable is a separate, reviewed decision and is not made here.
 */

import { AppError } from "@app/shared";
import type { SafePositiveByteCount, Sha256Digest } from "../completion/output";
import {
  ISO_BMFF_CONTAINER,
  MEDIA_INVALID_REASONS,
  type ManagedOutputContainerFamily,
  type ManagedOutputMediaFacts,
  type ManagedOutputMediaInvalidReason,
} from "../provider-output/media-validation";

/** The closed durable status vocabulary. Nothing else may be persisted. */
export const DELIVERABLE_VALIDATION_STATUSES = [
  "PENDING",
  "RUNNING",
  "VALID",
  "INVALID_MEDIA",
  "INTEGRITY_MISMATCH",
] as const;

export type DeliverableValidationStatus = (typeof DELIVERABLE_VALIDATION_STATUSES)[number];

/** The terminal subset. A terminal row is never reopened or overwritten. */
export const TERMINAL_DELIVERABLE_VALIDATION_STATUSES: readonly DeliverableValidationStatus[] = [
  "VALID",
  "INVALID_MEDIA",
  "INTEGRITY_MISMATCH",
];

export function isTerminalDeliverableValidationStatus(
  value: unknown,
): value is "VALID" | "INVALID_MEDIA" | "INTEGRITY_MISMATCH" {
  return (
    typeof value === "string" &&
    (TERMINAL_DELIVERABLE_VALIDATION_STATUSES as readonly string[]).includes(value)
  );
}

export function isDeliverableValidationStatus(
  value: unknown,
): value is DeliverableValidationStatus {
  return (
    typeof value === "string" &&
    (DELIVERABLE_VALIDATION_STATUSES as readonly string[]).includes(value)
  );
}

export function isDeliverableInvalidReason(
  value: unknown,
): value is ManagedOutputMediaInvalidReason {
  return typeof value === "string" && (MEDIA_INVALID_REASONS as readonly string[]).includes(value);
}

export function isDeliverableContainerFamily(
  value: unknown,
): value is ManagedOutputContainerFamily {
  return value === ISO_BMFF_CONTAINER;
}

// ---------------------------------------------------------------------------
// The immutable byte binding
// ---------------------------------------------------------------------------

/**
 * Which bytes this verdict is about, frozen when the record is created.
 *
 * Copied from the composition's durable output receipt, never from the object
 * that happens to be at the key today. Two things follow, and both matter:
 *
 * - A verdict can be read later as a statement about *specific* bytes. Without
 *   the binding, a `VALID` row created against one object would be read as
 *   permission to publish a different object that later occupied the same key.
 * - Every write after the claim can re-assert it. A composition receipt that
 *   ever disagreed with the validation's frozen copy is a discrepancy to
 *   surface, never a value to "repair" — repairing it is precisely how the
 *   evidence of a replaced object is destroyed.
 */
export interface DeliverableValidationReceiptBinding {
  readonly sha256: Sha256Digest;
  readonly sizeBytes: SafePositiveByteCount;
}

/**
 * The application-owned durable read model.
 *
 * Free of Prisma objects, Prisma enums, raw `bigint`s, storage keys, bucket
 * names and inspector output. Publication is deliberately **absent** from it: a
 * deliverable is published when the job says `DELIVERABLE_READY`, the job's
 * pointer names this version and the hold is `CONSUMED`, and duplicating that
 * into a fourth column would create a fourth thing to disagree.
 */
export type DurableDeliverableValidationRecord =
  | {
      readonly status: "PENDING";
      readonly receipt: DeliverableValidationReceiptBinding;
      readonly attemptCount: number;
      readonly version: number;
      /** Epoch ms at which the row becomes eligible again. */
      readonly nextAttemptAt: number;
    }
  | {
      readonly status: "RUNNING";
      readonly receipt: DeliverableValidationReceiptBinding;
      readonly attemptCount: number;
      readonly version: number;
      /** Epoch ms. Lease expiry is crash recovery, not a deadline. */
      readonly leaseExpiresAt: number;
    }
  | {
      readonly status: "VALID";
      readonly receipt: DeliverableValidationReceiptBinding;
      readonly attemptCount: number;
      readonly version: number;
      readonly facts: ManagedOutputMediaFacts;
      readonly validatedAt: number;
    }
  | {
      readonly status: "INVALID_MEDIA";
      readonly receipt: DeliverableValidationReceiptBinding;
      readonly attemptCount: number;
      readonly version: number;
      readonly reason: ManagedOutputMediaInvalidReason;
      readonly validatedAt: number;
    }
  | {
      readonly status: "INTEGRITY_MISMATCH";
      readonly receipt: DeliverableValidationReceiptBinding;
      readonly attemptCount: number;
      readonly version: number;
      readonly validatedAt: number;
    };

// ---------------------------------------------------------------------------
// Lease, retry and batch bounds
// ---------------------------------------------------------------------------

/**
 * Fifteen minutes by default, one hour at most.
 *
 * Crash recovery, not a deadline. Shorter than composition's lease because this
 * work downloads one already-bounded object and runs an inspector, rather than
 * downloading gigabytes and running an encoder. Duplicate execution is tolerable
 * for the same reasons: the object is immutable and first-wins, the verdict is
 * derived from its bytes, and finalize is CAS-protected.
 */
export const DEFAULT_DELIVERABLE_VALIDATION_LEASE_MS = 15 * 60_000;
export const MAX_DELIVERABLE_VALIDATION_LEASE_MS = 60 * 60_000;

export function validateDeliverableValidationLeaseMs(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 60_000 ||
    value > MAX_DELIVERABLE_VALIDATION_LEASE_MS
  ) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      `Deliverable validation lease must be an integer between 60000 and ${MAX_DELIVERABLE_VALIDATION_LEASE_MS} milliseconds`,
    );
  }
  return value;
}

/** Five minutes before a deferred validation becomes eligible again. */
export const DEFAULT_DELIVERABLE_VALIDATION_RETRY_DELAY_MS = 5 * 60_000;
export const MAX_DELIVERABLE_VALIDATION_RETRY_DELAY_MS = 60 * 60_000;

export function validateDeliverableValidationRetryDelayMs(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1_000 ||
    value > MAX_DELIVERABLE_VALIDATION_RETRY_DELAY_MS
  ) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      `Deliverable validation retry delay must be an integer between 1000 and ${MAX_DELIVERABLE_VALIDATION_RETRY_DELAY_MS} milliseconds`,
    );
  }
  return value;
}

/** The largest candidate batch one sweep may claim. */
export const MAX_DELIVERABLE_VALIDATION_BATCH_SIZE = 25;

/**
 * Prove a candidate-query limit is usable, or refuse.
 *
 * Not clamping: silently substituting 25 for 5000 lets a caller believe it swept
 * far more than it did.
 */
export function validateDeliverableValidationBatchLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_DELIVERABLE_VALIDATION_BATCH_SIZE
  ) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Deliverable validation batch limit must be an integer between 1 and ${MAX_DELIVERABLE_VALIDATION_BATCH_SIZE}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Defects
// ---------------------------------------------------------------------------

/**
 * The fixed defect codes deliverable validation and publication may raise.
 *
 * Each is an internal consistency violation — a state the application believes
 * it cannot produce. None carries customer input, provider text, a storage
 * location or an id, and none is repaired.
 */
export type DeliverableValidationDefectCode =
  /** A job awaiting validation has no verified composition behind it. */
  | "COMPOSITION_NOT_VERIFIED"
  /** The composition's durable receipt is absent or malformed. */
  | "COMPOSITION_RECEIPT_INCOMPLETE"
  /** A validation row and the composition it names disagree about the receipt. */
  | "VALIDATION_RECEIPT_CONFLICT"
  /** A terminal verdict was re-presented with different facts. */
  | "VALIDATION_VERDICT_CONFLICT"
  /** Job, reservation, version and validation disagree about publication. */
  | "PARTIAL_PUBLICATION_STATE"
  /** Publication would move the pointer to a version of another job. */
  | "FOREIGN_DELIVERABLE_VERSION"
  /** The reservation does not admit a consume in this cycle. */
  | "RESERVATION_NOT_CONSUMABLE"
  /** `validate()` returned something the closed outcome parser rejects. */
  | "VALIDATOR_RESULT_MALFORMED"
  /** `validate()` threw. Not evidence about the media. */
  | "VALIDATOR_FAILED"
  /** A persisted row cannot be read back into the domain's own range or shape. */
  | "PERSISTED_RECORD_MALFORMED";

const DEFECT_MESSAGES: Record<DeliverableValidationDefectCode, string> = {
  COMPOSITION_NOT_VERIFIED:
    "A job awaiting deliverable validation has no verified composed output",
  COMPOSITION_RECEIPT_INCOMPLETE:
    "A verified composition carries no complete durable output receipt",
  VALIDATION_RECEIPT_CONFLICT:
    "A deliverable validation names a different receipt than the composition it belongs to",
  VALIDATION_VERDICT_CONFLICT:
    "A terminal deliverable verdict already exists with different facts",
  PARTIAL_PUBLICATION_STATE:
    "Job, reservation, deliverable version and validation disagree about publication",
  FOREIGN_DELIVERABLE_VERSION:
    "Publication would name a deliverable version belonging to another job",
  RESERVATION_NOT_CONSUMABLE:
    "The entitlement hold does not admit a consume for this publication",
  VALIDATOR_RESULT_MALFORMED:
    "The deliverable media validator returned a result outside its contract",
  VALIDATOR_FAILED: "The deliverable media validator failed unexpectedly",
  PERSISTED_RECORD_MALFORMED:
    "A persisted deliverable-validation record is outside the domain's range",
};

export class DeliverableValidationDefect extends Error {
  readonly code: DeliverableValidationDefectCode;

  constructor(code: DeliverableValidationDefectCode) {
    super(DEFECT_MESSAGES[code]);
    this.name = "DeliverableValidationDefect";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Event vocabulary
// ---------------------------------------------------------------------------

/** Fixed application-owned event types. Nothing external reaches these. */
export const DELIVERABLE_VALIDATED_EVENT_TYPE = "deliverable.validated";
export const DELIVERABLE_PUBLISHED_EVENT_TYPE = "deliverable.published";
export const JOB_DELIVERABLE_READY_EVENT_TYPE = "job.deliverable_ready";
export const RESERVATION_CONSUMED_EVENT_TYPE = "reservation.consumed";

/**
 * The states the deliverable aggregate is recorded as entering.
 *
 * Past participles, continuing the stream Phase 5A and 5B write — `PLANNED`,
 * `COMPOSING`, `OUTPUT_VERIFIED` — so a reader of one aggregate's history sees
 * one vocabulary.
 */
export const DELIVERABLE_VALIDATED_STATE = "VALIDATED";
export const DELIVERABLE_PUBLISHED_STATE = "PUBLISHED";

// A terminal non-`VALID` verdict appends **no** transition event, on any
// aggregate, for exactly the reason Phase 5B's `BLOCKED` appends none.
//
// The job really does stay `DELIVERABLE_VALIDATING`, so a job event would assert
// a state change that did not happen; and a `DELIVERABLE_INVALID` aggregate
// state would put a customer-visible failure in the transition stream that no
// reviewed state machine contains, which every later reader would then have to
// interpret. The durable row already says it exactly — `INVALID_MEDIA` or
// `INTEGRITY_MISMATCH`, with an instant and, where there is one, a closed reason.

/** The reason code recorded on every Phase 5C transition. */
export const DELIVERABLE_VALIDATION_REASON_CODE = "DELIVERABLE_VALIDATION";
export const DELIVERABLE_PUBLICATION_REASON_CODE = "DELIVERABLE_PUBLICATION";
