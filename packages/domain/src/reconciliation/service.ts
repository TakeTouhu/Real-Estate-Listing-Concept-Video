import { sanitizeTransitionMetadata } from "../orchestration/transition-metadata";
import type { TransitionContext } from "../orchestration/ports";
import type { EntitlementAnomaly } from "../submission/entitlement-anomaly";
import {
  decideReconciliationExhaustion,
  decideReconciliationResolution,
  type ReconciliationWrite,
} from "./decide";
import { classifyReconciliationEntitlement } from "./entitlement";
import type {
  ExhaustReconciliationInput,
  ReconciliationDeps,
  ReconciliationExhaustionResult,
  ReconciliationResolutionResult,
  ResolveReconciliationInput,
} from "./ports";

/**
 * End an attempt's uncertainty — by learning the answer, or by running out of
 * time to learn it.
 *
 * Two operations that look symmetric and are not. Resolution writes down what a
 * provider turned out to have done and stamps when the platform established it.
 * Exhaustion writes down that nobody ever found out, and deliberately stamps no
 * resolution instant at all.
 *
 * **Nothing here contacts a provider.** Evidence arrives as an argument; the
 * dependency set is a repository and a clock. Whatever future layer polls,
 * receives a webhook, or takes an operator's determination normalizes its
 * findings before reaching this file, and there is no way to add a transport
 * without editing the port module.
 */

/** Attempt-side event types. Service-owned; never caller-supplied. */
export const RECONCILIATION_RESOLVED_ACCEPTED_EVENT_TYPE = "RECONCILIATION_RESOLVED_ACCEPTED";
export const RECONCILIATION_RESOLVED_REJECTED_EVENT_TYPE = "RECONCILIATION_RESOLVED_REJECTED";
export const RECONCILIATION_EXHAUSTED_EVENT_TYPE = "RECONCILIATION_EXHAUSTED";

/**
 * Reservation-side event types, distinct from the attempt's.
 *
 * The two describe different facts: one says what a provider did, the other
 * says what happened to a customer's entitlement as a result. An operator
 * asking "which units were handed back, and which were freed because we gave
 * up?" should not have to know which attempt-side route caused each one.
 */
export const RECONCILIATION_HOLD_RESTORED_EVENT_TYPE = "RECONCILIATION_HOLD_RESTORED";
export const RECONCILIATION_HOLD_RELEASED_EVENT_TYPE = "RECONCILIATION_HOLD_RELEASED";

/**
 * Attach the reconciliation facts to the caller's context.
 *
 * Actor, correlation and causation stay as supplied; the event type does not.
 * The label on the record of how uncertainty ended is what an audit query and a
 * future cost-accounting pass select on.
 *
 * The metadata is chosen so the decision is reconstructable from the database
 * alone — what was concluded, whether another attempt may follow, the deadline
 * it was judged against, when it resolved if it did, and what the customer's
 * entitlement looked like at the time. A crash between commit and the caller
 * reading the return value must not erase any of it. Every value is a closed
 * vocabulary member, an identifier or a number; the sanitizer's allowlist
 * refuses anything else.
 */
function withReconciliationRecord(
  context: TransitionContext,
  eventType: string,
  facts: {
    readonly attemptId: string;
    readonly certainty: string;
    readonly requestKind: string;
    readonly entitlementAnomaly: EntitlementAnomaly;
    readonly reconciliationDeadlineAt: number | null;
    readonly reconciliationResolvedAt: number | null;
    readonly retryable: boolean | null;
    readonly diagnosticCode: string | null;
    readonly remainingPendingUnknownAttempts: number;
  },
): TransitionContext {
  return {
    ...context,
    eventType,
    metadata: sanitizeTransitionMetadata({
      ...context.metadata,
      attemptId: facts.attemptId,
      submissionCertainty: facts.certainty,
      requestKind: facts.requestKind,
      entitlementAnomaly: facts.entitlementAnomaly,
      reconciliationDeadlineAt: facts.reconciliationDeadlineAt,
      reconciliationResolvedAt: facts.reconciliationResolvedAt,
      retryable: facts.retryable,
      // The reconciliation evidence's own classification. It lives here and not
      // on the attempt row, because `normalizedErrorCode` there belongs to the
      // *original* submission observation — overwriting it with a later finding
      // would erase why the attempt became uncertain in the first place.
      diagnosticCode: facts.diagnosticCode,
      // Why the customer's hold is where it is. When a conclusion decides
      // KEEP_HOLD there is no reservation event to carry the reason — nothing
      // transitioned — so the count that caused it lives here, on the attempt's
      // own event. A number, not sibling identifiers: the allowlist would refuse
      // an array, and an operator needs to know *that* siblings remained, not
      // which.
      remainingPendingUnknownAttempts: facts.remainingPendingUnknownAttempts,
    }),
  };
}

/**
 * Which reservation label a write's action implies, if any.
 *
 * `KEEP_HOLD` and `NONE` have none, and the difference matters: nothing
 * transitioned, so appending an event would put a transition in the log that
 * never happened. An operator counting entitlement suspensions would over-count
 * every multi-scene Job.
 */
function reservationEventTypeFor(write: ReconciliationWrite): string | null {
  switch (write.reservationAction) {
    case "RELEASE":
      return RECONCILIATION_HOLD_RELEASED_EVENT_TYPE;
    case "RESTORE":
      return RECONCILIATION_HOLD_RESTORED_EVENT_TYPE;
    case "KEEP_HOLD":
    case "NONE":
      return null;
  }
}

export function createReconciliationService(deps: ReconciliationDeps) {
  return {
    /**
     * Record conclusive evidence about an attempt whose acceptance was unknown.
     *
     * Never re-POSTs the attempt, and never invents a provider reference: only
     * an `ACCEPTED` observation may introduce one.
     */
    async resolveReconciliation(
      input: ResolveReconciliationInput,
    ): Promise<ReconciliationResolutionResult> {
      return deps.reconciliation.withReconcilingAttempt(
        { organizationId: input.organizationId, attemptId: input.attemptId },
        async (session): Promise<ReconciliationResolutionResult> => {
          const facts = await session.loadFacts();
          // Missing, cross-tenant and legacy-unorchestrated are one answer. A
          // distinguishable denial would confirm another tenant's row exists.
          if (facts === null) return { kind: "ATTEMPT_NOT_FOUND" };

          // Read once, after the locks. A resolver that judged the deadline on
          // a timestamp taken before it queued behind the lock could authorize
          // a resolution for a window that closed while it waited — the same
          // time-authority rule Phase 2F-1 and 2G-1 are built on.
          const now = deps.clock.now();

          const decision = decideReconciliationResolution({
            facts: facts.attempt,
            observation: input.observation,
            reservationState: facts.reservation?.state ?? null,
            otherPendingUnknownAttemptsInJob: facts.otherPendingUnknownAttemptsInJob,
            now,
          });

          switch (decision.kind) {
            case "REPLAY":
              return { kind: "REPLAYED", attemptId: facts.attempt.attemptId };
            case "CONFLICT":
              return { kind: "CONFLICTING_RESOLUTION", reason: decision.reason };
            case "NOT_RECONCILING":
              return { kind: "NOT_RECONCILING", reason: decision.reason };
            case "DEADLINE_EXPIRED":
              return { kind: "DEADLINE_EXPIRED" };
            case "RECONCILIATION_CLOSED":
              return { kind: "RECONCILIATION_CLOSED" };
            case "MALFORMED_OBSERVATION":
              return { kind: "OBSERVATION_MALFORMED" };
            case "APPLY":
              break;
          }

          const entitlementAnomaly = classifyReconciliationEntitlement({
            requestKind: facts.requestKind,
            reservationState: facts.reservation?.state ?? null,
          });
          const accepted = input.observation.kind === "ACCEPTED";

          const applied = await session.apply({
            expectedVersion: facts.attempt.stateVersion,
            write: decision.write,
            reservationEventType: reservationEventTypeFor(decision.write),
            context: withReconciliationRecord(
              input.context,
              accepted
                ? RECONCILIATION_RESOLVED_ACCEPTED_EVENT_TYPE
                : RECONCILIATION_RESOLVED_REJECTED_EVENT_TYPE,
              {
                attemptId: facts.attempt.attemptId,
                certainty: decision.write.submissionCertainty,
                requestKind: facts.requestKind,
                entitlementAnomaly,
                reconciliationDeadlineAt: facts.attempt.reconciliationDeadlineAt,
                reconciliationResolvedAt: decision.write.reconciliationResolvedAt,
                retryable: accepted ? null : input.observation.retryable,
                diagnosticCode: accepted ? null : input.observation.diagnosticCode,
                remainingPendingUnknownAttempts: facts.otherPendingUnknownAttemptsInJob,
              },
            ),
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
    },

    /**
     * Close an attempt whose reconciliation window has run out.
     *
     * The customer is made whole — a suspended hold is released — while the
     * provider-side cost stays uncertain, which is exactly what
     * `RECONCILIATION_EXHAUSTED + SUBMISSION_UNKNOWN` means to the Safety Guard.
     * No customer unit is consumed, here or anywhere in this phase.
     */
    async exhaustReconciliation(
      input: ExhaustReconciliationInput,
    ): Promise<ReconciliationExhaustionResult> {
      return deps.reconciliation.withReconcilingAttempt(
        { organizationId: input.organizationId, attemptId: input.attemptId },
        async (session): Promise<ReconciliationExhaustionResult> => {
          const facts = await session.loadFacts();
          if (facts === null) return { kind: "ATTEMPT_NOT_FOUND" };

          const now = deps.clock.now();

          const decision = decideReconciliationExhaustion({
            facts: facts.attempt,
            reservationState: facts.reservation?.state ?? null,
            otherPendingUnknownAttemptsInJob: facts.otherPendingUnknownAttemptsInJob,
            now,
          });

          switch (decision.kind) {
            case "ALREADY_EXHAUSTED":
              return { kind: "ALREADY_EXHAUSTED", attemptId: facts.attempt.attemptId };
            case "NOT_RECONCILING":
              return { kind: "NOT_RECONCILING", reason: decision.reason };
            case "NOT_DUE":
              return { kind: "NOT_DUE", dueAt: decision.dueAt };
            case "APPLY":
              break;
          }

          const entitlementAnomaly = classifyReconciliationEntitlement({
            requestKind: facts.requestKind,
            reservationState: facts.reservation?.state ?? null,
          });

          const applied = await session.apply({
            expectedVersion: facts.attempt.stateVersion,
            write: decision.write,
            reservationEventType: reservationEventTypeFor(decision.write),
            context: withReconciliationRecord(
              input.context,
              RECONCILIATION_EXHAUSTED_EVENT_TYPE,
              {
                attemptId: facts.attempt.attemptId,
                certainty: decision.write.submissionCertainty,
                requestKind: facts.requestKind,
                entitlementAnomaly,
                reconciliationDeadlineAt: facts.attempt.reconciliationDeadlineAt,
                // Stays null, and the event's own timestamp is the durable
                // record of when the platform stopped waiting. Stamping a
                // resolution instant here would put a fabricated success into
                // the field an auditor reads to find out when certainty was
                // regained — it never was.
                reconciliationResolvedAt: null,
                retryable: null,
                diagnosticCode: null,
                remainingPendingUnknownAttempts: facts.otherPendingUnknownAttemptsInJob,
              },
            ),
          });
          if (applied.kind === "LOST") return { kind: "LOST_CONCURRENCY" };

          return {
            kind: "EXHAUSTED",
            attemptId: facts.attempt.attemptId,
            stateVersion: applied.stateVersion,
            entitlementAnomaly,
          };
        },
      );
    },
  };
}

export type ReconciliationService = ReturnType<typeof createReconciliationService>;
