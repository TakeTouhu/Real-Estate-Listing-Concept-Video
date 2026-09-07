import { sanitizeTransitionMetadata } from "../orchestration/transition-metadata";
import type { TransitionContext } from "../orchestration/ports";
import { evaluatePaidSubmissionGate, type PaidSubmissionAuthorizationAudit } from "./gate";
import { ROUTING_POLICY_VERSION } from "./routing";
import type {
  AuthorizePaidSubmissionInput,
  PaidSubmissionAuthorizationDeps,
} from "./ports";
import type { PaidSubmissionAuthorizationOutcome } from "./types";

/**
 * May this one persisted attempt cross `QUEUED → SUBMITTING`?
 *
 * The service that answers it, and the last thing that runs before a provider
 * would be contacted — by something else, in a later phase. **Nothing here
 * calls a provider.** There is no HTTP client, no provider adapter and no
 * transport of any kind in its dependencies, and the type of
 * {@link PaidSubmissionAuthorizationDeps} is what enforces that.
 *
 * The order is deliberate and load-bearing:
 *
 * ```text
 * open the organization+cycle cost-admission lock
 *   → load every fact from the persistence graph
 *   → read the authorization instant from the clock
 *   → evaluate the pure gate
 *   → if permitted, compare-and-set QUEUED → SUBMITTING
 *     with the authorization record attached to its event
 *   → commit
 * → return AUTHORIZED
 * ```
 *
 * Facts are loaded *inside* the lock so two authorizations cannot both plan
 * against the same exposure, and the CAS happens inside the same transaction so
 * the lock is still held when the attempt actually moves. Returning
 * `AUTHORIZED` before that commit would hand out permission to spend money on
 * the strength of a decision that had not yet been recorded.
 *
 * The instant is read *after* the lock, not before it and not by the caller. A
 * request that waited behind a long queue must be judged at the time it reached
 * the front: pricing eligibility is a function of time, and evaluating with a
 * stale instant is how an expired contract authorizes a payment.
 *
 * On every refusal the attempt is left exactly as it was. A gate that says no
 * has not discovered anything about the provider, so writing a provider-state
 * transition would be manufacturing history for something that did not happen.
 */

/**
 * The event type a paid authorization writes, fixed here.
 *
 * Not caller-supplied. The label on the one event that records permission to
 * spend money is what an audit query selects on, and a caller able to write
 * something else could make a paid authorization indistinguishable from any
 * other transition — not necessarily on purpose, but a copied context object is
 * enough.
 */
export const PAID_SUBMISSION_AUTHORIZED_EVENT_TYPE = "PAID_SUBMISSION_AUTHORIZED";

/**
 * Attach the authorization record to the caller's context.
 *
 * Actor, correlation and causation stay as the caller supplied them — who asked
 * and why is theirs to say. The event type and the financial facts are not: they
 * are overwritten, and any caller-supplied value under the same keys is
 * replaced rather than merged, so a caller cannot pre-seed a friendlier guard
 * state into its own authorization record.
 */
function withAuthorizationRecord(
  context: TransitionContext,
  audit: PaidSubmissionAuthorizationAudit,
  billingCycleKey: string | null,
): TransitionContext {
  return {
    ...context,
    eventType: PAID_SUBMISSION_AUTHORIZED_EVENT_TYPE,
    metadata: sanitizeTransitionMetadata({
      ...context.metadata,
      billingCycleKey,
      authorizationPolicyVersion: audit.authorizationPolicyVersion,
      routingPolicyVersion: ROUTING_POLICY_VERSION,
      safetyGuardState: audit.safetyGuard.state,
      billingCycleRevenueYen: audit.billingCycleRevenueYen,
      knownActualCostYen: audit.exposure.knownActualCostYen,
      settledEstimatedCostYen: audit.exposure.settledEstimatedCostYen,
      uncertainCostYen: audit.exposure.uncertainCostYen,
      inFlightCostYen: audit.exposure.inFlightCostYen,
      nextProjectedCostYen: audit.exposure.nextProjectedCostYen,
      projectedContributionProfitYen: audit.safetyGuard.projectedContributionProfitYen,
      warningFloorYen: audit.safetyGuard.thresholds.warningFloorYen,
      hardPauseFloorYen: audit.safetyGuard.thresholds.hardPauseFloorYen,
      pricingSnapshotId: audit.pricingSnapshotId,
    }),
  };
}

export function createPaidSubmissionAuthorizationService(
  deps: PaidSubmissionAuthorizationDeps,
) {
  return {
    async authorize(
      input: AuthorizePaidSubmissionInput,
    ): Promise<PaidSubmissionAuthorizationOutcome> {
      return deps.authorization.withCostAdmission(
        { organizationId: input.organizationId, attemptId: input.attemptId },
        async (session): Promise<PaidSubmissionAuthorizationOutcome> => {
          const facts = await session.loadFacts();
          // Missing, cross-tenant and legacy-unorchestrated are one answer. A
          // distinguishable denial would confirm another tenant's row exists.
          if (facts === null) return { kind: "ATTEMPT_NOT_FOUND" };

          // Read once, inside the lock, and used for every time-dependent part
          // of this decision. Two reads could straddle a contract's expiry.
          const authorizationInstant = deps.clock.now();

          // Revenue is read through a port because nothing persists it yet, and
          // it is `null` today — which fails closed inside the gate rather than
          // defaulting to a number nobody published.
          const billingCycleRevenueYen =
            facts.billingCycleKey === null
              ? null
              : await deps.billingCycleRevenue.revenueYen({
                  organizationId: input.organizationId,
                  billingCycleKey: facts.billingCycleKey,
                });

          const decision = evaluatePaidSubmissionGate({
            authorizationInstant,
            attempt: facts.attempt,
            job: facts.job,
            reservation: facts.reservation,
            pricing: facts.pricing,
            commercial: { billingCycleRevenueYen, exposure: facts.exposure },
          });
          if (decision.kind === "REFUSED") return decision.outcome;

          // Only now, and only inside the same transaction and lock. The
          // authorization record commits atomically with the state change, so
          // there is no window in which the boundary is crossed and the reason
          // it was allowed is not yet written down.
          const armed = await session.arm({
            expectedVersion: decision.expectedStateVersion,
            context: withAuthorizationRecord(
              input.context,
              decision.audit,
              facts.billingCycleKey,
            ),
          });
          if (armed.kind === "LOST") return { kind: "LOST_CONCURRENCY" };
          if (armed.kind === "REFUSED_BY_BOUNDARY") {
            // The boundary re-checks the pricing binding from the stored row.
            // Disagreeing with the gate here means the persisted snapshot moved
            // under both of them; refuse rather than force it through.
            return {
              kind: "PRICING_INELIGIBLE",
              reason: "PRICING_SNAPSHOT_BINDING_INVALID",
            };
          }

          return {
            kind: "AUTHORIZED",
            attemptId: decision.attemptId,
            armedStateVersion: armed.stateVersion,
            safetyGuardWarning: decision.safetyGuardWarning,
          };
        },
      );
    },
  };
}

export type PaidSubmissionAuthorizationService = ReturnType<
  typeof createPaidSubmissionAuthorizationService
>;
