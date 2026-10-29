/**
 * The attempt submission's persistence port (GS-7c-2a, ADR-0097): which
 * orchestrated attempts wait to be sent, and the ending of one whose
 * preparation was refused for good.
 *
 * Sending itself is the paid-submission gate's (ADR-0096) and the provider
 * port's; nothing here moves an attempt toward the provider.
 */

import type { SystemGenerationCandidate } from "../generation/execution-ports";
import type { PreflightRefusalReason } from "../generation/execution-preflight-errors";
import type { TransitionContext } from "../orchestration/ports";

export interface AttemptSubmissionCandidateQuery {
  /** Validated by {@link validateAttemptSubmissionBatchLimit}. */
  readonly limit: number;
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
  ): Promise<readonly SystemGenerationCandidate[]>;

  /**
   * End one `QUEUED` attempt whose preparation was refused for good, under the
   * cost-admission lock taken first, with its transition event, in one commit.
   */
  endPreparationRefusal(input: EndPreparationRefusalInput): Promise<EndPreparationRefusalOutcome>;
}
