import type { Yen } from "../pricing/units";
import type { TransitionContext } from "../orchestration/ports";
import type { ExecutionSourceObservation, PreparedSourceIdentity } from "../generation/execution-source";
import type { AuditLog } from "../identity/types";
import type {
  AttemptGateFacts,
  JobGateFacts,
  PricingGateFacts,
  ReservationGateFacts,
} from "./gate";
import type { AuthorizationClock } from "./clock";
import type { ProviderCostExposure } from "./exposure";
import type { RoutePolicy } from "./routing";
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
  /** False when a cost-bearing sibling's snapshot could not be reproduced. */
  readonly exposureVerified: boolean;
  /** The cycle this attempt's cost is attributed to, from its reservation. */
  readonly billingCycleKey: string | null;
}

/**
 * A source of billing-cycle revenue other than the cycle's own period.
 *
 * The gate reads revenue from its session (ADR-0091), and the database's
 * session reads it from the cycle's entitlement period on the gate's own
 * transaction. A composition passes one of these instead only to fix the
 * figure: a test steering the Safety Guard, or the unavailable reader where
 * the gate must fail closed whatever the database holds. Inferring a plan from
 * unrelated metadata (seat counts, usage, an organization name) would
 * hard-pause real customers against an invented number.
 *
 * `null` means unknown, which fails the gate closed.
 */
export interface BillingCycleRevenueReader {
  /** `null` when no authoritative figure exists for this organization/cycle. */
  revenueYen(input: {
    readonly organizationId: string;
    readonly billingCycleKey: string;
  }): Promise<Yen | null>;
}

/**
 * There is deliberately no per-scene revenue reader.
 *
 * An earlier draft had one, to feed a runtime `NO_NEGATIVE_UNIT_ECONOMICS`
 * check. That check has been removed from this gate: whether a route is
 * profitable to sell is decided when the route is commercially certified and
 * when a plan is configured, not when a customer asks for the rendition they
 * already bought. Keeping the port would have kept the temptation, and there is
 * no honest source for the figure either — dividing subscription revenue by a
 * scene count produces an average, which is precisely what a worst-case check
 * must not plan against.
 */

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
 * `loadFacts`, `readBillingCycleRevenue` and `arm` share one transaction, so
 * the facts the gate decided on are still the facts when the attempt moves.
 */
export interface PaidSubmissionAuthorizationSession {
  /** `null` when the attempt is missing, cross-tenant, or not orchestrated. */
  loadFacts(): Promise<PaidSubmissionFactsSnapshot | null>;
  /**
   * The revenue of the cycle this session holds the lock for (ADR-0091):
   * `billingCycleRevenueYen` over the cycle's entitlement period. `null` when
   * unknown, which fails the gate closed.
   */
  readBillingCycleRevenue(): Promise<Yen | null>;
  /**
   * The attempt's own source asset, locked against its writers until commit,
   * and its project's Property held against deletion (ADR-0096): a deletion
   * request or a re-processing waits for the arm, and the arm sees one already
   * committed. `null` when the organization has no such asset.
   */
  lockSource(): Promise<LockedPaidSubmissionSource | null>;
  /**
   * The Phase 4C-3B-2E compare-and-set, inside this same transaction, and the
   * paid call's audit entry with it when the attempt moves (ADR-0096).
   */
  arm(input: {
    readonly expectedVersion: number;
    readonly context: TransitionContext;
    readonly audit: PaidSubmissionAudit;
  }): Promise<ArmResult>;
}

/** What {@link PaidSubmissionAuthorizationSession.lockSource} found, locked. */
export interface LockedPaidSubmissionSource {
  readonly asset: ExecutionSourceObservation;
  /**
   * The attempt's project's Property is deleted. Its photos await deletion,
   * one statement each after the Property's, so the asset may still read
   * usable (ADR-0096 Decision 2).
   */
  readonly propertyDeleted: boolean;
}

/** The audit entry the arm writes in its own commit. */
export type PaidSubmissionAudit = Omit<AuditLog, "id" | "createdAt">;

export type ArmResult =
  | { readonly kind: "ARMED"; readonly stateVersion: number }
  | { readonly kind: "LOST" }
  | { readonly kind: "REFUSED_BY_BOUNDARY" };

export interface PaidSubmissionAuthorizationDeps {
  readonly authorization: PaidSubmissionAuthorizationRepository;
  /** Read inside the lock. See {@link AuthorizationClock}. */
  readonly clock: AuthorizationClock;
  /**
   * The routes an attempt may be authorized against. Production's when left
   * out; only a composition outside production passes the test route's
   * (ADR-0089).
   */
  readonly routePolicy?: RoutePolicy;
}

/**
 * The whole caller-supplied input. Every other fact is loaded or measured.
 *
 * There is no authorization instant here, and its absence is a control rather
 * than a simplification: the instant decides pricing eligibility, so a caller
 * that could choose it could authorize against a contract that expired. The
 * `context` a caller supplies carries actor, correlation and causation — who
 * asked and why — and the service overrides its `eventType`, because the label
 * on a paid authorization event is not the caller's to write either.
 */
export interface AuthorizePaidSubmissionInput {
  readonly organizationId: string;
  readonly attemptId: string;
  /**
   * The source preparation signed a URL for. The attempt moves only while its
   * asset, locked, is still this source (ADR-0096).
   */
  readonly source: PreparedSourceIdentity;
  readonly context: TransitionContext;
}

export type { PaidSubmissionAuthorizationOutcome };
