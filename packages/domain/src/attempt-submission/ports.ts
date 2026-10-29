/**
 * The attempt submission's ports: its persistence (GS-7c-2a, ADR-0097), which
 * orchestrated attempts wait to be sent and the ending of one whose
 * preparation was refused for good; and the one paid call (GS-7c-2b,
 * ADR-0098).
 *
 * Moving an attempt toward the provider is the paid-submission gate's
 * (ADR-0096); nothing in the persistence port does.
 */

import type { SystemGenerationCandidate } from "../generation/execution-ports";
import type { PreparedGeneration } from "../generation/execution-preflight";
import type { PreflightRefusalReason } from "../generation/execution-preflight-errors";
import type { TransitionContext } from "../orchestration/ports";
import type { ProviderSubmissionObservation } from "../submission/observation";

/** Where a discovery window starts: after this attempt, in discovery's order. */
export interface AttemptSubmissionCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface AttemptSubmissionCandidateQuery {
  /** Validated by {@link validateAttemptSubmissionBatchLimit}. */
  readonly limit: number;
  /**
   * Offer only attempts after this one, so a pass moves past attempts left
   * waiting by the passes before it (ADR-0098). `null` starts at the oldest.
   */
  readonly after: AttemptSubmissionCursor | null;
}

/** An attempt waiting to be sent, with the job it belongs to. */
export interface AttemptSubmissionCandidate extends SystemGenerationCandidate {
  readonly generationJobId: string;
}

export interface EndPreparationRefusalInput {
  readonly organizationId: string;
  readonly attemptId: string;
  /**
   * What preparation refused with. Only a reason whose disposition is
   * `TERMINAL` ends an attempt; any other is a caller defect and writes
   * nothing.
   */
  readonly reason: PreflightRefusalReason;
  /** Actor and correlation. The event type and reason code are the repository's. */
  readonly context: TransitionContext;
}

export type EndPreparationRefusalOutcome =
  | { readonly kind: "ENDED"; readonly attemptId: string; readonly stateVersion: number }
  /**
   * Nothing was written: no such orchestrated attempt in the organization, or it
   * is no longer `QUEUED` before submission. Identical, because the caller's
   * next action is identical and another tenant's row must not be confirmed.
   */
  | { readonly kind: "NOT_QUEUED" };

export interface AttemptSubmissionRepository {
  /**
   * Orchestrated attempts waiting to be sent, oldest first, with each one's
   * organization resolved through its project.
   *
   * Reads only. An attempt is offered while it is `QUEUED` before submission
   * under a `GENERATING` request and job, and its Property stands: the gate
   * refuses a deleted Property's attempt for good (ADR-0096), and offering it
   * would let such attempts fill the window ahead of others.
   */
  findSubmissionCandidates(
    query: AttemptSubmissionCandidateQuery,
  ): Promise<readonly AttemptSubmissionCandidate[]>;

  /**
   * End one `QUEUED` attempt whose preparation was refused for good, under the
   * cost-admission lock taken first, with its transition event, in one commit.
   */
  endPreparationRefusal(input: EndPreparationRefusalInput): Promise<EndPreparationRefusalOutcome>;
}

/**
 * The one paid call (ADR-0098): an adapter in `@app/video-providers` builds the
 * provider's request from the prepared generation, sends it once, and answers
 * with what it learned in the provider-neutral vocabulary the submission
 * outcome records.
 */
export interface PreparedGenerationSender {
  /** The provider it reaches. An attempt admitted for another is not sent. */
  readonly providerName: string;
  /**
   * At most one POST, never retried. An expected failure is an answer, not a
   * throw; a request whose fate is not known is `SUBMISSION_UNKNOWN`.
   */
  send(prepared: PreparedGeneration): Promise<ProviderSubmissionObservation>;
}
