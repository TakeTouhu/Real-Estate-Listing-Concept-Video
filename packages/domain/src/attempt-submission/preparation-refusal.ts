/**
 * What preparation's refusal does to an orchestrated attempt (GS-7c-2a,
 * ADR-0097).
 *
 * The launch commit admits each scene's first attempt `QUEUED` (ADR-0095), and
 * the sender prepares it with the execution preflight before the paid-submission
 * gate (ADR-0096). When preparation refuses, the canonical disposition of its
 * reason decides, and nothing here re-decides it:
 *
 * - a `TERMINAL` reason can never become preparable under the admitted request,
 *   so the attempt **ends** before submission, `QUEUED →
 *   CANCELLED_PRE_SUBMISSION`, with the reason as its durable code. The attempt
 *   failure settlement (Transaction K, ADR-0083) then fails the request and
 *   releases the job's Unit (ADR-0052 Decision 19);
 * - a `RETRYABLE` reason may pass on a later pass, so the attempt stays
 *   `QUEUED` and nothing is written.
 *
 * `CANCELLED_PRE_SUBMISSION` because it is the one ended state an attempt may
 * reach without having entered the provider boundary: the schema requires a
 * boundary instant on every other state past `QUEUED`
 * (`scene_generations_submission_boundary_check`), and stamping one on an
 * attempt that never reached the provider would record a crossing that never
 * happened, in the column crash recovery reads to judge a submission.
 * `FAILED_RETRYABLE` would also promise a retry nothing makes (ADR-0083
 * Decision 2).
 */

import { AppError } from "@app/shared";
import type { AttemptSubmissionCursor } from "./ports";
import {
  preflightDispositionFor,
  type PreflightRefusalReason,
} from "../generation/execution-preflight-errors";

/** The one state a refused orchestrated attempt ends in. */
export type PreparationRefusalEndState = "CANCELLED_PRE_SUBMISSION";

/** The event the ending writes on the attempt. Not caller-supplied. */
export const ATTEMPT_PREPARATION_REFUSED_EVENT_TYPE = "attempt.preparation_refused";

/**
 * Where a refused orchestrated attempt goes, or `null` when it stays `QUEUED`.
 *
 * From the canonical disposition only: a second list of which refusals end an
 * attempt would eventually disagree with the one preparation is built on.
 */
export function preparationRefusalEnding(
  reason: PreflightRefusalReason,
): PreparationRefusalEndState | null {
  return preflightDispositionFor(reason) === "TERMINAL" ? "CANCELLED_PRE_SUBMISSION" : null;
}

/** The largest batch one discovery may return, matching the other sweeps' bound. */
export const MAX_ATTEMPT_SUBMISSION_BATCH_SIZE = 100;

/** Prove a candidate-query limit is usable, or refuse. Never clamped. */
export function validateAttemptSubmissionBatchLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ATTEMPT_SUBMISSION_BATCH_SIZE) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Attempt submission batch limit must be an integer between 1 and ${MAX_ATTEMPT_SUBMISSION_BATCH_SIZE}`,
    );
  }
  return value;
}

/** Prove a window's start is usable, or refuse: a real instant and an id. */
export function validateAttemptSubmissionCursor(
  value: AttemptSubmissionCursor | null,
): AttemptSubmissionCursor | null {
  if (value === null) return null;
  if (
    !(value.createdAt instanceof Date) ||
    !Number.isFinite(value.createdAt.getTime()) ||
    typeof value.id !== "string" ||
    value.id.length === 0
  ) {
    throw new AppError("VALIDATION_FAILED", "Attempt submission cursor must name an instant and an attempt");
  }
  return value;
}
