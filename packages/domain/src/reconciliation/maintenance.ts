import { epochMillis, type EpochMillis } from "../pricing/units";
import type { TransitionContext } from "../orchestration/ports";
import { isReconciliationPolicy, type ReconciliationPolicy } from "../submission/reconciliation-window";
import type { SubmissionOutcomeService } from "../submission/service";
import { AppError } from "@app/shared";
import { validateReconciliationMaintenanceLimit } from "./limits";
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
 * ### Two cutoffs, one clock, neither of them the caller's
 *
 * The two queries ask different questions of different columns:
 *
 * ```text
 * due    reconciliationDeadlineAt    <= discoveryNow
 * stale  submissionBoundaryEnteredAt <= discoveryNow - policy.staleSubmittingAfterMs
 * ```
 *
 * An earlier version took a single `cutoff` from the caller and passed it to
 * both, which quietly required every caller to encode two different meanings in
 * one timestamp — and got the stale one wrong by a whole threshold. The runner
 * now reads its own clock **once** and derives both, from a validated policy it
 * cannot invent.
 *
 * That clock read is advisory. It narrows which rows are worth asking about and
 * decides nothing: each candidate goes to the single-attempt service, which
 * re-reads the row under lock against its own post-lock clock.
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
  /**
   * The validated Phase 2G-1 policy, for the stale threshold only.
   *
   * The opaque type, not a raw config: a threshold that never met the validator
   * would be a bound nobody agreed to, applied to a decision about whether a
   * paid submission is presumed lost. No default is invented here, and none
   * ships — how long an attempt may sit at the boundary is a production
   * activation decision.
   */
  readonly policy: ReconciliationPolicy;
}

export interface MaintenanceBatchInput {
  /**
   * A hard bound per category. Validated before any query runs.
   *
   * There is deliberately no `cutoff` here. Discovery time belongs to the
   * runner's injected clock: a caller-supplied instant would let one caller
   * sweep a window the policy never sanctioned, and it forced two different
   * predicates to share one timestamp.
   */
  readonly limit: number;
  readonly context: TransitionContext;
}

/** What one pass actually did, in closed counts rather than prose. */
export interface MaintenanceBatchReport {
  /** The single advisory instant both queries were narrowed by. */
  readonly discoveryNow: EpochMillis;
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
  // The same provenance check Phase 2G-1's service makes. A policy is opaque and
  // its constructor is private, so the only way to hold a non-policy here is an
  // explicit cast — which is exactly what a caller in a hurry writes.
  if (!isReconciliationPolicy(deps.policy)) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Reconciliation maintenance requires a validated reconciliation policy",
    );
  }

  return {
    /**
     * Sweep attempts abandoned at the submission boundary, then attempts whose
     * reconciliation window has closed.
     *
     * Stale first, deliberately — but *not* because a newly uncertain attempt is
     * safe from the second pass. It often is not: Phase 2G-1 freezes the
     * deadline at `submissionBoundaryEnteredAt + reconciliationWindow`, so an
     * attempt discovered long after it was abandoned can enter
     * `SUBMISSION_UNKNOWN` with a deadline that has *already* elapsed. The due
     * query in this same pass will then find it and the exhaustion service will
     * close it, which is correct: the platform's bound on that uncertainty ran
     * out before anyone noticed the attempt, and making the customer wait for
     * another batch would extend a window that is already over.
     *
     * The ordering exists so the second pass sees the first pass's work rather
     * than missing it. Correctness comes from each service re-checking under
     * lock.
     */
    async runOnce(input: MaintenanceBatchInput): Promise<MaintenanceBatchReport> {
      // Before any query. An invalid bound must never reach a SQL LIMIT, and it
      // must not reach one after a partial sweep either.
      const limit = validateReconciliationMaintenanceLimit(input.limit);

      // Exactly one read. Two would let the two queries disagree about now, and
      // a batch's own report could then describe a window that never existed.
      const discoveryNow = deps.clock.now();
      const staleCutoff = epochMillis(discoveryNow - deps.policy.staleSubmittingAfterMs);

      let staleUncertaintyEntered = 0;
      let exhausted = 0;
      let unchanged = 0;

      const stale: readonly ReconciliationCandidate[] =
        await deps.reconciliation.findStaleSubmittingCandidates({
          cutoff: staleCutoff,
          limit,
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
          cutoff: discoveryNow,
          limit,
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
        discoveryNow,
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
