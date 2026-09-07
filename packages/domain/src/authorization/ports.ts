import type { EpochMillis, Yen } from "../pricing/units";
import type { TransitionContext } from "../orchestration/ports";
import type {
  AttemptGateFacts,
  JobGateFacts,
  PricingGateFacts,
  ReservationGateFacts,
} from "./gate";
import type { ProviderCostExposure } from "./exposure";
import type { PaidSubmissionAuthorizationOutcome } from "./types";

/**
 * What the authorization service needs from persistence, and nothing else.
 *
 * There is deliberately no provider client here, and no way to add one without
 * changing this file: the service is constructed from exactly these ports, so
 * "the gate cannot call a provider" is a fact about its type rather than a
 * promise in a comment. A test asserts the same thing from the outside.
 */

/** Everything one authorization decision reads, loaded under one lock. */
export interface PaidSubmissionFactsSnapshot {
  readonly attempt: AttemptGateFacts;
  readonly job: JobGateFacts;
  readonly reservation: ReservationGateFacts | null;
  readonly pricing: PricingGateFacts;
  readonly exposure: ProviderCostExposure;
  /** The cycle this attempt's cost is attributed to, from its reservation. */
  readonly billingCycleKey: string | null;
}

/**
 * The billing-cycle revenue the Safety Guard measures against.
 *
 * A port rather than a table read, because **no authoritative billing-cycle
 * revenue exists yet**. Nothing persists a subscription, a plan assignment or
 * an invoice, and the customer plan catalog prices plans without saying which
 * organization is on one. Inferring a plan from unrelated metadata — seat
 * counts, usage, an organization name — would hard-pause real customers
 * against an invented number.
 *
 * So the gate asks, and the default implementation answers "unknown", which
 * fails closed. Production activation must supply this from the billing layer.
 */
export interface BillingCycleRevenueReader {
  /** `null` when no authoritative figure exists for this organization/cycle. */
  revenueYen(input: {
    readonly organizationId: string;
    readonly billingCycleKey: string;
  }): Promise<Yen | null>;
}

/**
 * Revenue attributable to one scene, for the unit-economics check.
 *
 * Separate from cycle revenue and equally unsourced today. The worst-case
 * profitability question is per-scene — three paid attempts against what that
 * scene earned — and dividing cycle revenue by a scene count would be an
 * average, which is exactly what `NO_NEGATIVE_UNIT_ECONOMICS` refuses to plan
 * against.
 */
export interface SceneRevenueReader {
  /** `null` when no authoritative figure exists. */
  revenueYen(input: {
    readonly organizationId: string;
    readonly generationJobId: string;
  }): Promise<Yen | null>;
}

/**
 * The serialized cost-admission boundary.
 *
 * `withCostAdmission` runs its callback inside one database transaction that
 * already holds an organization + billing-cycle scoped lock. Two authorizations
 * for the same organization and cycle therefore cannot both read the same
 * exposure and both decide it is affordable — the second waits, re-reads, and
 * sees the first one's committed attempt.
 *
 * Scoped to organization *and* cycle rather than globally: one tenant's
 * incident must not pause another's, and last month's exposure must not block
 * this month's work.
 */
export interface PaidSubmissionAuthorizationRepository {
  withCostAdmission<T>(
    input: {
      readonly organizationId: string;
      readonly attemptId: string;
    },
    run: (session: PaidSubmissionAuthorizationSession) => Promise<T>,
  ): Promise<T>;
}

/**
 * The operations available inside a held cost-admission lock.
 *
 * `loadFacts` and `arm` share one transaction, so the facts the gate decided on
 * are still the facts when the attempt moves.
 */
export interface PaidSubmissionAuthorizationSession {
  /** `null` when the attempt is missing, cross-tenant, or not orchestrated. */
  loadFacts(): Promise<PaidSubmissionFactsSnapshot | null>;
  /** The Phase 4C-3B-2E compare-and-set, inside this same transaction. */
  arm(input: {
    readonly expectedVersion: number;
    readonly context: TransitionContext;
  }): Promise<ArmResult>;
}

export type ArmResult =
  | { readonly kind: "ARMED"; readonly stateVersion: number }
  | { readonly kind: "LOST" }
  | { readonly kind: "REFUSED_BY_BOUNDARY" };

export interface PaidSubmissionAuthorizationDeps {
  readonly authorization: PaidSubmissionAuthorizationRepository;
  readonly billingCycleRevenue: BillingCycleRevenueReader;
  readonly sceneRevenue: SceneRevenueReader;
}

/** The whole caller-supplied input. Every other fact is loaded. */
export interface AuthorizePaidSubmissionInput {
  readonly organizationId: string;
  readonly attemptId: string;
  readonly authorizationInstant: EpochMillis;
  readonly context: TransitionContext;
}

export type { PaidSubmissionAuthorizationOutcome };
