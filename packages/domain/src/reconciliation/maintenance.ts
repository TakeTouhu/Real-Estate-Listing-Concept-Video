import type { EpochMillis } from "../pricing/units";
import type { TransitionContext } from "../orchestration/ports";
import type { SubmissionOutcomeService } from "../submission/service";
import type { ReconciliationCandidate, ReconciliationDeps } from "./ports";
import type { ReconciliationService } from "./service";

/**
 * One pass over the attempts that maintenance might need to touch.
 *
 * Deliberately **one** pass. It does not loop, does not sleep, does not schedule
 * itself and does not own a timer — a daemon is a different thing with different
 * failure modes, and nothing in this phase is authorized to become one. A caller
 * decides when to run a batch; this decides what one batch does.
 *
 * It also contains no provider call of any kind. Both of its jobs are about
 * *time* rather than about asking anyone anything: an attempt that sat at the
 * submission boundary too long, and an attempt whose reconciliation window
 * closed. Learning what a provider actually did is the later polling phase.
 *
 * ### Candidates are advisory, never authority
 *
 * Discovery takes no locks and holds none, so every row it returns is a
 * hypothesis about the past. Between the query and the act, another worker may
 * have resolved the attempt, a stale sweep may have moved it, or the deadline
 * may no longer be what the query thought. That is not a defect to design
 * around — it is why each candidate is handed to the single-attempt service,
 * which re-reads the row under lock, re-reads its own clock, and reaches its own
 * conclusion. A non-mutating answer from that service is a normal outcome here,
 * counted rather than treated as an error.
 */

export interface MaintenanceBatchDeps extends ReconciliationDeps {
  readonly reconciliationService: ReconciliationService;
  /** Phase 2G-1's service. The authoritative stale transition, not a copy of it. */
  readonly submissionOutcomes: SubmissionOutcomeService;
}

export interface MaintenanceBatchInput {
  /**
   * Rows due at or before this instant are candidates.
   *
   * Supplied rather than read from a clock here, so a caller can run a batch
   * over a deliberately conservative cutoff. It narrows discovery only; it never
   * reaches the services, which each judge against their own post-lock clock.
   */
  readonly cutoff: EpochMillis;
  /** A hard bound per category. Discovery is never unbounded. */
  readonly limit: number;
  readonly context: TransitionContext;
}

/** What one pass actually did, in closed counts rather than prose. */
export interface MaintenanceBatchReport {
  readonly staleCandidates: number;
  readonly staleUncertaintyEntered: number;
  readonly dueCandidates: number;
  readonly exhausted: number;
  /**
   * Candidates the authoritative service declined to act on.
   *
   * Expected and healthy: someone else got there first, or the row was never
   * what the query believed. A batch reporting only successes would be hiding
   * exactly the contention this design permits.
   */
  readonly unchanged: number;
}

export function createReconciliationMaintenance(deps: MaintenanceBatchDeps) {
  return {
    /**
     * Sweep attempts abandoned at the submission boundary, then attempts whose
     * reconciliation window has closed.
     *
     * Stale first, deliberately: a stale sweep *creates* uncertainty with a
     * deadline, and doing it before the exhaustion pass means a newly uncertain
     * attempt is never accidentally exhausted in the same batch that discovered
     * it — its deadline is in the future, so the second pass's own re-check
     * declines it. The ordering is a courtesy to the reader; the correctness
     * comes from each service re-checking under lock.
     */
    async runOnce(input: MaintenanceBatchInput): Promise<MaintenanceBatchReport> {
      let staleUncertaintyEntered = 0;
      let exhausted = 0;
      let unchanged = 0;

      const stale: readonly ReconciliationCandidate[] =
        await deps.reconciliation.findStaleSubmittingCandidates({
          cutoff: input.cutoff,
          limit: input.limit,
        });

      for (const candidate of stale) {
        const result = await deps.submissionOutcomes.enterUncertaintyForStaleSubmitting({
          organizationId: candidate.organizationId,
          attemptId: candidate.attemptId,
          // No diagnostic is invented for a sweep. Nobody observed anything;
          // the honest classification is the absence of one.
          normalizedErrorCode: null,
          context: input.context,
        });
        if (result.kind === "APPLIED") staleUncertaintyEntered += 1;
        else unchanged += 1;
      }

      const due: readonly ReconciliationCandidate[] =
        await deps.reconciliation.findDueReconciliationCandidates({
          cutoff: input.cutoff,
          limit: input.limit,
        });

      for (const candidate of due) {
        const result = await deps.reconciliationService.exhaustReconciliation({
          organizationId: candidate.organizationId,
          attemptId: candidate.attemptId,
          context: input.context,
        });
        if (result.kind === "EXHAUSTED") exhausted += 1;
        else unchanged += 1;
      }

      return {
        staleCandidates: stale.length,
        staleUncertaintyEntered,
        dueCandidates: due.length,
        exhausted,
        unchanged,
      };
    },
  };
}

export type ReconciliationMaintenance = ReturnType<typeof createReconciliationMaintenance>;
