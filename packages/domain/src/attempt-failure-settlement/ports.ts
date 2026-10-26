/**
 * The attempt failure settlement ports (ADR-0083).
 *
 * Discovery is a hint and the settlement is the authority, as for Transaction F:
 * `findAttemptFailureCandidates` returns identifiers only, and
 * `settleAttemptFailure` re-reads and re-decides everything under its own locks.
 * There is no work row and no lease. The settlement is one database transaction
 * with no external effect, so two workers offered the same request serialize on
 * its locks, and the second finds it settled.
 */

import type { TransitionContext } from "../orchestration/ports";
import type { AttemptFailureRefusal } from "./settlement";

/** Identifiers only. Nothing here is a decision. */
export interface AttemptFailureCandidate {
  readonly organizationId: string;
  readonly generationSceneRequestId: string;
}

export interface AttemptFailureCandidateQuery {
  readonly limit: number;
}

export interface SettleAttemptFailureInput {
  /**
   * The tenant the caller believes owns the request. Never trusted on its own:
   * ownership is proved through Scene → Job → VideoProject in the statements
   * that lock the rows, so a mismatched id locks nothing and finds nothing.
   */
  readonly organizationId: string;
  readonly generationSceneRequestId: string;
  /**
   * The one instant the settlement records: the request's `failedAt` and, when
   * this settlement releases it, the reservation's `releasedAt`.
   */
  readonly settledAt: number;
  readonly context: TransitionContext;
}

export type AttemptFailureSettlementOutcome =
  | {
      readonly kind: "SETTLED";
      readonly settlement: "INITIAL_FAILED" | "REGENERATION_ROLLED_BACK";
      /** Whether this commit released the Unit. False when reconciliation already had. */
      readonly unitReleased: boolean;
    }
  | { readonly kind: "NOT_SETTLEABLE"; readonly reason: AttemptFailureRefusal }
  /** No such request visible to this organization. */
  | { readonly kind: "NOT_FOUND" };

export interface AttemptFailureSettlementRepository {
  /** Bounded, deterministic, one row per request. A hint only. */
  findAttemptFailureCandidates(
    query: AttemptFailureCandidateQuery,
  ): Promise<readonly AttemptFailureCandidate[]>;

  /** The settlement, in one short database transaction with no external I/O. */
  settleAttemptFailure(input: SettleAttemptFailureInput): Promise<AttemptFailureSettlementOutcome>;
}
