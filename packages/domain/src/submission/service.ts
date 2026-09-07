import { sanitizeTransitionMetadata } from "../orchestration/transition-metadata";
import type { TransitionContext } from "../orchestration/ports";
import { decideSubmissionOutcome, isRecoverableStaleSubmitting } from "./outcome";
import type { SubmissionOutcomeDecision } from "./outcome";
import type { ProviderSubmissionObservation } from "./observation";
import { classifyEntitlementAnomaly, type EntitlementAnomaly } from "./entitlement-anomaly";
import { isReconciliationPolicy } from "./reconciliation-window";
import { AppError } from "@app/shared";
import type {
  EnterUncertaintyForStaleInput,
  RecordSubmissionObservationInput,
  SubmissionOutcomeDeps,
  SubmissionOutcomeResult,
} from "./ports";

/**
 * Persist what is known about one submission, once.
 *
 * Two entry points, one rule set. A worker that watched the POST reports what
 * it saw; a sweeper that finds an attempt abandoned at the boundary reports
 * that nobody knows. Both land in the same place, through the same evaluator,
 * and produce the same durable shape for the same attempt — the reconciliation
 * *deadline* in particular, which is derived from the submission boundary, so
 * neither route can grant itself a longer window by looking later.
 *
 * **Nothing here contacts a provider.** This phase records reality that has
 * already been observed; it never goes and asks. The dependency set is a
 * repository, a clock and a policy, and there is no way to add a transport
 * without editing the port file.
 */

/** The event type a submission outcome writes on the attempt. Not caller-supplied. */
export const SUBMISSION_OUTCOME_EVENT_TYPE = "SUBMISSION_OUTCOME_RECORDED";

/** The event type stale-submitting recovery writes on the attempt. */
export const STALE_SUBMISSION_RECOVERY_EVENT_TYPE = "STALE_SUBMISSION_UNCERTAINTY_ENTERED";

/**
 * The event type the *reservation's* own transition writes.
 *
 * Deliberately not either of the attempt labels. The two events describe
 * different facts — one says what a provider did, the other says a customer's
 * entitlement was suspended because nobody could say what the provider did —
 * and an operator querying for entitlement suspensions should not have to know
 * which attempt-side route happened to cause each one.
 */
export const SUBMISSION_UNCERTAINTY_HOLD_EVENT_TYPE = "SUBMISSION_UNCERTAINTY_HOLD";

/**
 * Attach the outcome facts to the caller's context.
 *
 * Actor, correlation and causation stay as supplied. The event type does not:
 * the label on the record of what a provider did is what an audit query and a
 * future reconciliation worker select on, and a caller able to write something
 * else could make a provider outcome indistinguishable from any other
 * transition.
 *
 * `entitlementAnomaly` rides along for a reason that outlives this process. An
 * anomaly discovered here is reported in the return value, but a crash between
 * commit and the caller reading it would leave no trace that money was spent
 * against bookkeeping that did not add up. Writing it into the same transaction
 * as the outcome makes it reconstructable from the database alone.
 */
function withOutcomeRecord(
  context: TransitionContext,
  eventType: string,
  facts: {
    readonly certainty: string;
    readonly reconciliationDeadlineAt: number | null;
    readonly attemptId: string;
    readonly entitlementAnomaly: EntitlementAnomaly;
    readonly requestKind: string;
  },
): TransitionContext {
  return {
    ...context,
    eventType,
    metadata: sanitizeTransitionMetadata({
      ...context.metadata,
      attemptId: facts.attemptId,
      submissionCertainty: facts.certainty,
      reconciliationDeadlineAt: facts.reconciliationDeadlineAt,
      entitlementAnomaly: facts.entitlementAnomaly,
      requestKind: facts.requestKind,
    }),
  };
}

function translate(
  decision: Exclude<SubmissionOutcomeDecision, { kind: "APPLY" } | { kind: "REPLAY" }>,
): SubmissionOutcomeResult {
  switch (decision.kind) {
    case "CONFLICT":
      return { kind: "CONFLICTING_OBSERVATION", reason: decision.reason };
    case "NOT_AT_BOUNDARY":
      return { kind: "ATTEMPT_NOT_AT_BOUNDARY", reason: decision.reason };
    case "MALFORMED_OBSERVATION":
      return { kind: "OBSERVATION_MALFORMED" };
  }
}

export function createSubmissionOutcomeService(deps: SubmissionOutcomeDeps) {
  // Types cannot stop `as unknown as ReconciliationPolicy`, so the one
  // construction boundary asks at runtime too. This is defence in depth, not
  // the validation: it proves the policy was built by the validator rather than
  // re-deriving its numbers, because a second copy of the bounds here is a
  // second thing to drift. A forged policy is a programming defect, so it
  // throws rather than returning a business outcome.
  if (!isReconciliationPolicy(deps.policy)) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Submission outcome service requires a validated reconciliation policy",
    );
  }

  /** The shared body: load, decide, and only then write. */
  async function record(
    input: {
      readonly organizationId: string;
      readonly attemptId: string;
      readonly context: TransitionContext;
    },
    observation: ProviderSubmissionObservation,
    eventType: string,
    requireStale: boolean,
  ): Promise<SubmissionOutcomeResult> {
    return deps.outcomes.withAttemptOutcome(
      { organizationId: input.organizationId, attemptId: input.attemptId },
      async (session): Promise<SubmissionOutcomeResult> => {
        const facts = await session.loadFacts();
        // Missing, cross-tenant and legacy-unorchestrated are one answer. A
        // distinguishable denial would confirm another tenant's row exists.
        if (facts === null) return { kind: "ATTEMPT_NOT_FOUND" };

        // Read once, inside the lock. Everything this write stamps — the
        // acceptance instant, the moment uncertainty became durable — comes from
        // this one value, and so does the staleness judgement. A stale judgement
        // made before waiting for the lock could declare an attempt lost that a
        // worker finished while this transaction queued.
        const now = deps.clock.now();

        const decision = decideSubmissionOutcome({
          facts: facts.attempt,
          observation,
          policy: deps.policy,
          now,
        });

        // The staleness guard applies only to the sweeper, and only to an
        // attempt that would otherwise be applied. An attempt that already has
        // an outcome is a replay or a conflict regardless of how long it sat.
        if (requireStale && decision.kind === "APPLY") {
          const staleness = isRecoverableStaleSubmitting({
            facts: facts.attempt,
            policy: deps.policy,
            now,
          });
          if (!staleness.stale) {
            return { kind: "NOT_STALE_YET", staleAt: staleness.staleAt };
          }
        }

        // Exactly the provider reality already on file. No event, no timestamp
        // moves, no deadline extended, and — because replay identity is what the
        // provider did rather than where the attempt landed — no false conflict
        // just because execution has since moved on.
        if (decision.kind === "REPLAY") {
          return { kind: "REPLAYED", attemptId: facts.attempt.attemptId };
        }
        if (decision.kind !== "APPLY") return translate(decision);

        // Classified from persisted facts only: the request kind comes through
        // the chain, the reservation state from the row locked above.
        const entitlementAnomaly = classifyEntitlementAnomaly({
          requestKind: facts.requestKind,
          reservationState: facts.reservation?.state ?? null,
        });

        const applied = await session.apply({
          expectedVersion: facts.attempt.stateVersion,
          write: decision.write,
          reservationEventType: SUBMISSION_UNCERTAINTY_HOLD_EVENT_TYPE,
          context: withOutcomeRecord(input.context, eventType, {
            attemptId: facts.attempt.attemptId,
            certainty: decision.write.submissionCertainty,
            reconciliationDeadlineAt: decision.write.reconciliationDeadlineAt,
            entitlementAnomaly,
            requestKind: facts.requestKind,
          }),
        });
        if (applied.kind === "LOST") return { kind: "LOST_CONCURRENCY" };

        return {
          kind: "APPLIED",
          attemptId: facts.attempt.attemptId,
          stateVersion: applied.stateVersion,
          entitlementAnomaly,
        };
      },
    );
  }

  return {
    /** Record an outcome a caller directly observed. */
    async recordObservation(
      input: RecordSubmissionObservationInput,
    ): Promise<SubmissionOutcomeResult> {
      return record(input, input.observation, SUBMISSION_OUTCOME_EVENT_TYPE, false);
    },

    /**
     * Convert one attempt abandoned at the boundary into durable uncertainty.
     *
     * Never a re-POST, and never a return to `QUEUED`. The provider may already
     * hold and bill for this request; the only honest thing to record is that
     * nobody knows, and the only safe thing to do about it is wait for
     * reconciliation.
     */
    async enterUncertaintyForStaleSubmitting(
      input: EnterUncertaintyForStaleInput,
    ): Promise<SubmissionOutcomeResult> {
      return record(
        input,
        { kind: "SUBMISSION_UNKNOWN", normalizedErrorCode: input.normalizedErrorCode },
        STALE_SUBMISSION_RECOVERY_EVENT_TYPE,
        true,
      );
    },
  };
}

export type SubmissionOutcomeService = ReturnType<typeof createSubmissionOutcomeService>;
