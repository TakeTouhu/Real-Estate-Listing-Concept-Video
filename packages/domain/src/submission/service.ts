import { sanitizeTransitionMetadata } from "../orchestration/transition-metadata";
import type { TransitionContext } from "../orchestration/ports";
import { decideSubmissionOutcome, isRecoverableStaleSubmitting } from "./outcome";
import type { SubmissionOutcomeDecision } from "./outcome";
import type { ProviderSubmissionObservation } from "./observation";
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
 * and — because every timestamp is anchored to `submissionBoundaryEnteredAt`
 * rather than to now — both produce byte-identical durable state for the same
 * attempt. That is what makes their race benign rather than a source of two
 * different deadlines for one uncertainty.
 *
 * **Nothing here contacts a provider.** This phase records reality that has
 * already been observed; it never goes and asks. The dependency set is a
 * repository, a clock and a policy, and there is no way to add a transport
 * without editing the port file.
 */

/** The event type a submission outcome writes. Not caller-supplied. */
export const SUBMISSION_OUTCOME_EVENT_TYPE = "SUBMISSION_OUTCOME_RECORDED";

/** The event type stale-submitting recovery writes. */
export const STALE_SUBMISSION_RECOVERY_EVENT_TYPE = "STALE_SUBMISSION_UNCERTAINTY_ENTERED";

/**
 * Attach the outcome facts to the caller's context.
 *
 * Actor, correlation and causation stay as supplied. The event type does not:
 * the label on the record of what a provider did is what an audit query and a
 * future reconciliation worker select on, and a caller able to write something
 * else could make a provider outcome indistinguishable from any other
 * transition.
 */
function withOutcomeRecord(
  context: TransitionContext,
  eventType: string,
  facts: {
    readonly certainty: string;
    readonly reconciliationDeadlineAt: number | null;
    readonly attemptId: string;
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

        // Read once, inside the lock. A stale judgement made before waiting for
        // the lock could declare an attempt lost that a worker finished while
        // this transaction queued.
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

        // Exactly the news already on file. No event, no timestamp moves, no
        // deadline extended — the whole point of anchoring them to the boundary.
        if (decision.kind === "REPLAY") {
          return { kind: "REPLAYED", attemptId: facts.attempt.attemptId };
        }
        if (decision.kind !== "APPLY") return translate(decision);

        const applied = await session.apply({
          expectedVersion: facts.attempt.stateVersion,
          write: decision.write,
          context: withOutcomeRecord(input.context, eventType, {
            attemptId: facts.attempt.attemptId,
            certainty: decision.write.submissionCertainty,
            reconciliationDeadlineAt: decision.write.reconciliationDeadlineAt,
          }),
        });
        if (applied.kind === "LOST") return { kind: "LOST_CONCURRENCY" };

        return {
          kind: "APPLIED",
          attemptId: facts.attempt.attemptId,
          stateVersion: applied.stateVersion,
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
