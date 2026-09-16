/**
 * The durable media-validation record: what the platform has permanently
 * concluded about whether an already-byte-verified managed output is *media*.
 *
 * ## Why this is not another orchestration state
 *
 * `OUTPUT_VERIFIED` is terminal for the provider-attempt byte-integrity
 * lifecycle and keeps its exact meaning — canonical managed bytes were copied
 * and byte-level integrity was verified. Appending a media state after it would
 * retroactively redefine what every already-`OUTPUT_VERIFIED` row claimed, and
 * would tie a question about container structure to a state machine about
 * provider execution. Media validity is an orthogonal fact, so it gets its own
 * one-to-one durable record and its own closed vocabulary.
 *
 * ## The lifecycle
 *
 * ```text
 * (absent)  → discovered by the runner, never written at completion time
 * PENDING   → eligible at or after nextAttemptAt
 * RUNNING   → one worker holds a lease
 * VALID              terminal, with normalized media facts
 * INVALID_MEDIA      terminal, with exactly one closed reason
 * INTEGRITY_MISMATCH terminal, the object is no longer the verified bytes
 * ```
 *
 * `RETRYABLE_FAILURE` — the validator's transient outcome — is deliberately
 * **not** in this vocabulary. It is not a verdict about the video; it is the
 * absence of one. It returns the row to `PENDING` with a future attempt time,
 * so a storage hiccup can never become a permanent record that a customer's
 * output is unusable.
 */

import { AppError } from "@app/shared";
import type { Sha256Digest, SafePositiveByteCount } from "../completion/output";
import {
  ISO_BMFF_CONTAINER,
  MEDIA_INVALID_REASONS,
  type ManagedOutputContainerFamily,
  type ManagedOutputMediaFacts,
  type ManagedOutputMediaInvalidReason,
} from "../provider-output/media-validation";

/** The closed durable status vocabulary. Nothing else may be persisted. */
export const MEDIA_VALIDATION_STATUSES = [
  "PENDING",
  "RUNNING",
  "VALID",
  "INVALID_MEDIA",
  "INTEGRITY_MISMATCH",
] as const;

export type ManagedOutputMediaValidationStatus = (typeof MEDIA_VALIDATION_STATUSES)[number];

/** The terminal subset. A terminal row is never reopened or overwritten. */
export const TERMINAL_MEDIA_VALIDATION_STATUSES: readonly ManagedOutputMediaValidationStatus[] = [
  "VALID",
  "INVALID_MEDIA",
  "INTEGRITY_MISMATCH",
];

export function isTerminalMediaValidationStatus(
  value: unknown,
): value is "VALID" | "INVALID_MEDIA" | "INTEGRITY_MISMATCH" {
  return (
    typeof value === "string" &&
    (TERMINAL_MEDIA_VALIDATION_STATUSES as readonly string[]).includes(value)
  );
}

export function isManagedOutputMediaValidationStatus(
  value: unknown,
): value is ManagedOutputMediaValidationStatus {
  return (
    typeof value === "string" && (MEDIA_VALIDATION_STATUSES as readonly string[]).includes(value)
  );
}

export function isManagedOutputMediaInvalidReason(
  value: unknown,
): value is ManagedOutputMediaInvalidReason {
  return typeof value === "string" && (MEDIA_INVALID_REASONS as readonly string[]).includes(value);
}

export function isManagedOutputContainerFamily(
  value: unknown,
): value is ManagedOutputContainerFamily {
  return value === ISO_BMFF_CONTAINER;
}

/**
 * The immutable byte binding every validation record carries.
 *
 * A validation answers a question about *specific bytes*, so the record names
 * them permanently. Without this, a record created against one object could be
 * read later as a verdict about a different object that happens to sit at the
 * same key — which is exactly the situation `INTEGRITY_MISMATCH` exists to
 * detect, and would be silently erased by "repairing" the record.
 */
export interface ManagedOutputMediaValidationReceiptBinding {
  readonly sha256: Sha256Digest;
  readonly sizeBytes: SafePositiveByteCount;
}

/**
 * The application-owned durable read model.
 *
 * Deliberately free of Prisma objects, Prisma enum types, raw `bigint`s,
 * provider identifiers, provider URLs, S3 metadata and inspector output. A
 * later lifecycle-policy phase can distinguish every durable case from this
 * alone, and no Scene or Job policy is attached to it yet.
 */
export type DurableMediaValidationRecord =
  | {
      readonly status: "PENDING";
      readonly receipt: ManagedOutputMediaValidationReceiptBinding;
      readonly attemptCount: number;
      readonly version: number;
      /** Epoch ms, or `null` when immediately eligible. */
      readonly nextAttemptAt: number | null;
    }
  | {
      readonly status: "RUNNING";
      readonly receipt: ManagedOutputMediaValidationReceiptBinding;
      readonly attemptCount: number;
      readonly version: number;
      /** Epoch ms. Lease expiry is crash recovery, not a deadline. */
      readonly leaseExpiresAt: number;
    }
  | {
      readonly status: "VALID";
      readonly receipt: ManagedOutputMediaValidationReceiptBinding;
      readonly attemptCount: number;
      readonly version: number;
      readonly facts: ManagedOutputMediaFacts;
      readonly validatedAt: number;
    }
  | {
      readonly status: "INVALID_MEDIA";
      readonly receipt: ManagedOutputMediaValidationReceiptBinding;
      readonly attemptCount: number;
      readonly version: number;
      readonly reason: ManagedOutputMediaInvalidReason;
      readonly validatedAt: number;
    }
  | {
      readonly status: "INTEGRITY_MISMATCH";
      readonly receipt: ManagedOutputMediaValidationReceiptBinding;
      readonly attemptCount: number;
      readonly version: number;
      readonly validatedAt: number;
    };

/**
 * The fixed defect codes this lifecycle may raise.
 *
 * Every one is an internal contract violation, not customer input and not a
 * statement about the video. None carries a `cause`, a message from an external
 * system, or the offending value: a storage error, an inspector's stderr and a
 * Prisma exception are all external data, and the default rendering of a thrown
 * value is where such content escapes without anyone choosing to log it.
 */
export type MediaValidationLifecycleDefectCode =
  /** `validate()` returned something the closed outcome parser rejects. */
  | "VALIDATOR_RESULT_MALFORMED"
  /** `validate()` threw. Not evidence about the media. */
  | "VALIDATOR_FAILED"
  /** A persisted row cannot be read back into the domain's own range/shape. */
  | "PERSISTED_RECORD_MALFORMED"
  /** A record's frozen receipt disagrees with the attempt's durable receipt. */
  | "RECEIPT_BINDING_CONFLICT";

const DEFECT_MESSAGES: Record<MediaValidationLifecycleDefectCode, string> = {
  VALIDATOR_RESULT_MALFORMED: "The media validator returned a result outside its contract",
  VALIDATOR_FAILED: "The media validator failed unexpectedly",
  PERSISTED_RECORD_MALFORMED: "A persisted media-validation record is outside the domain's range",
  RECEIPT_BINDING_CONFLICT:
    "A media-validation record is bound to different bytes than the attempt's verified receipt",
};

export class MediaValidationLifecycleDefect extends Error {
  readonly code: MediaValidationLifecycleDefectCode;

  constructor(code: MediaValidationLifecycleDefectCode) {
    super(DEFECT_MESSAGES[code]);
    this.name = "MediaValidationLifecycleDefect";
    this.code = code;
  }
}

/**
 * The largest media-validation batch one pass may claim.
 *
 * A frozen number rather than configuration, matching the reconciliation
 * maintenance bound: it states how much work a pass may take before yielding,
 * and a deployment needing more throughput should run more passes.
 */
export const MAX_MEDIA_VALIDATION_BATCH_SIZE = 100;

/**
 * Prove a candidate-query limit is usable, or refuse.
 *
 * Not clamping, for the same reason the reconciliation limit does not: silently
 * substituting 100 for 5000 lets a caller believe it swept far more than it
 * did. `Number.isSafeInteger` rejects `NaN`, both infinities, fractions and
 * anything past 2^53-1 in one predicate — every value a SQL `LIMIT` must never
 * receive.
 */
export function validateMediaValidationBatchLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MEDIA_VALIDATION_BATCH_SIZE) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Media validation batch limit must be an integer between 1 and ${MAX_MEDIA_VALIDATION_BATCH_SIZE}`,
    );
  }
  return value;
}

/**
 * How long a claimed lease is owned before another worker may reclaim it.
 *
 * Five minutes by default, because the operation may stream a large managed
 * object out of object storage before it inspects it, and a two-minute
 * assumption would make ordinary work look like a crash.
 *
 * **Lease expiry is crash recovery, not a deadline.** Nothing requires the
 * validation to finish before this instant; it states how long the system waits
 * before assuming the owner died. A validation that outlives its lease may be
 * redundantly re-executed, and the stale worker's finalize loses safely against
 * the lease token and version. That is acceptable precisely because this work
 * has no paid-provider side effect — it re-reads an object the platform already
 * owns. No heartbeat exists in this phase.
 */
export const DEFAULT_MEDIA_VALIDATION_LEASE_MS = 5 * 60_000;
/** One hour. Past this a "lease" stops being crash recovery in any useful sense. */
export const MAX_MEDIA_VALIDATION_LEASE_MS = 60 * 60_000;

export function validateMediaValidationLeaseMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > MAX_MEDIA_VALIDATION_LEASE_MS) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Media validation lease must be an integer between 1000 and ${MAX_MEDIA_VALIDATION_LEASE_MS} milliseconds`,
    );
  }
  return value;
}

/**
 * How long a released row waits before it is eligible again.
 *
 * A fixed delay, on purpose. A production backoff curve and a dead-letter
 * policy are real decisions about how long to keep retrying a storage problem
 * and when to escalate it, and this dormant phase has no authority to make
 * them. Thirty seconds is enough to stop a tight loop.
 */
export const DEFAULT_MEDIA_VALIDATION_RETRY_DELAY_MS = 30_000;
export const MAX_MEDIA_VALIDATION_RETRY_DELAY_MS = 60 * 60_000;

export function validateMediaValidationRetryDelayMs(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1_000 ||
    value > MAX_MEDIA_VALIDATION_RETRY_DELAY_MS
  ) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Media validation retry delay must be an integer between 1000 and ${MAX_MEDIA_VALIDATION_RETRY_DELAY_MS} milliseconds`,
    );
  }
  return value;
}
