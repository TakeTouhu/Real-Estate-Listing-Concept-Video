import { yen } from "../pricing/units";
import { evaluatePaidSubmissionGate } from "./gate";
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
 *   → evaluate the pure gate
 *   → if permitted, compare-and-set QUEUED → SUBMITTING
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
 * On every refusal the attempt is left exactly as it was. A gate that says no
 * has not discovered anything about the provider, so writing a provider-state
 * transition would be manufacturing history for something that did not happen.
 */
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

          // Revenue is read through ports because nothing persists it yet, and
          // both are `null` today — which fails closed inside the gate rather
          // than defaulting to a number nobody published.
          const billingCycleRevenueYen =
            facts.billingCycleKey === null
              ? null
              : await deps.billingCycleRevenue.revenueYen({
                  organizationId: input.organizationId,
                  billingCycleKey: facts.billingCycleKey,
                });
          const sceneRevenueYen = await deps.sceneRevenue.revenueYen({
            organizationId: input.organizationId,
            generationJobId: facts.job.id,
          });

          const decision = evaluatePaidSubmissionGate({
            authorizationInstant: input.authorizationInstant,
            attempt: facts.attempt,
            job: facts.job,
            reservation: facts.reservation,
            pricing: facts.pricing,
            commercial: {
              billingCycleRevenueYen,
              exposure: facts.exposure,
              // A scene with no known revenue is worth nothing to the
              // worst-case check, which makes any positive provider cost
              // negative economics — the fail-closed direction.
              sceneRevenueYen: sceneRevenueYen ?? yen(0),
            },
          });
          if (decision.kind === "REFUSED") return decision.outcome;

          // Only now, and only inside the same transaction and lock.
          const armed = await session.arm({
            expectedVersion: decision.expectedStateVersion,
            context: input.context,
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
