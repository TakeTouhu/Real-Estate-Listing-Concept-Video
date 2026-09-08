import type { EpochMillis } from "../pricing/units";
import type { TransitionContext } from "../orchestration/ports";
import type {
  GenerationReservationState,
  SceneGenerationRequestKind,
} from "../orchestration/types";
import type { EntitlementAnomaly } from "../submission/entitlement-anomaly";
import type { SubmissionClock } from "../submission/ports";
import type {
  NotReconcilingReason,
  ReconcilingAttemptFacts,
  ReconciliationConflictReason,
  ReconciliationWrite,
} from "./decide";
import type { ReconciliationResolutionObservation } from "./observation";

/**
 * What resolving or exhausting an uncertain attempt needs from persistence.
 *
 * A repository and a clock. **No provider client, no HTTP, and no way to add one
 * without editing this file** — evidence arrives as an argument to the service,
 * never as something this layer fetches. The polling, webhook and manual-
 * determination mechanisms that will one day produce that evidence belong to a
 * later phase with a different dependency set.
 */

/** What the reservation looked like when the conclusion landed. */
export interface ReconciliationReservationFacts {
  readonly id: string;
  readonly state: GenerationReservationState;
  readonly stateVersion: number;
}

/** Everything one decision reads, loaded under one lock. */
export interface ReconciliationFacts {
  readonly attempt: ReconcilingAttemptFacts;
  /** `null` when the job has no reservation at all — an anomaly, not a block. */
  readonly reservation: ReconciliationReservationFacts | null;
  /** The parent logical request's kind, read through the persisted chain. */
  readonly requestKind: SceneGenerationRequestKind;
}

/**
 * The serialized write boundary.
 *
 * `withReconcilingAttempt` runs its callback inside one transaction already
 * holding the locks this phase needs, in the order Phase 4C-3B-2F-1 fixed and
 * Phase 4C-3B-2G-1 joined: organization+cycle advisory lock, then the
 * reservation row `FOR UPDATE`, then the attempt compare-and-set. Taking them in
 * that order is what keeps reconciliation from deadlocking against paid
 * authorization and against outcome recording.
 */
export interface ReconciliationRepository {
  withReconcilingAttempt<T>(
    input: { readonly organizationId: string; readonly attemptId: string },
    run: (session: ReconciliationSession) => Promise<T>,
  ): Promise<T>;

  /**
   * Bounded, advisory discovery of attempts whose window has closed.
   *
   * Returns identifiers only. It takes no locks and holds none: by the time a
   * caller acts on a row another worker may already have resolved it, which is
   * why every candidate still goes through the single-attempt service and is
   * re-checked there under lock. Treating this list as authority is the mistake
   * it is shaped to prevent.
   */
  findDueReconciliationCandidates(
    input: ReconciliationCandidateQuery,
  ): Promise<readonly ReconciliationCandidate[]>;

  /**
   * The same, for attempts abandoned at the submission boundary.
   *
   * Advisory in exactly the same way. The authoritative stale transition is
   * Phase 2G-1's, which re-reads the row and its own post-lock clock; this only
   * narrows which rows are worth asking about.
   */
  findStaleSubmittingCandidates(
    input: ReconciliationCandidateQuery,
  ): Promise<readonly ReconciliationCandidate[]>;
}

export interface ReconciliationCandidateQuery {
  /** Rows at or before this instant qualify. Never "now" chosen by the query. */
  readonly cutoff: EpochMillis;
  /** A hard bound. Discovery never returns an unbounded batch. */
  readonly limit: number;
}

/** Identifiers only — deliberately not enough to decide anything with. */
export interface ReconciliationCandidate {
  readonly organizationId: string;
  readonly attemptId: string;
}

export interface ReconciliationSession {
  /** `null` when the attempt is missing, cross-tenant, or not orchestrated. */
  loadFacts(): Promise<ReconciliationFacts | null>;
  /**
   * Apply the decided write as one compare-and-set, with its transition event
   * and — when the write says so — the reservation move, in the same commit.
   */
  apply(input: {
    readonly expectedVersion: number;
    readonly write: ReconciliationWrite;
    readonly context: TransitionContext;
    /** Service-owned, never caller-chosen. */
    readonly reservationEventType: string;
  }): Promise<ApplyReconciliationResult>;
}

export type ApplyReconciliationResult =
  | { readonly kind: "APPLIED"; readonly stateVersion: number }
  | { readonly kind: "LOST" };

export interface ReconciliationDeps {
  readonly reconciliation: ReconciliationRepository;
  readonly clock: SubmissionClock;
}

/** The whole caller-supplied input for resolving uncertainty. */
export interface ResolveReconciliationInput {
  readonly organizationId: string;
  readonly attemptId: string;
  readonly observation: ReconciliationResolutionObservation;
  readonly context: TransitionContext;
}

/** The whole caller-supplied input for closing an expired window. */
export interface ExhaustReconciliationInput {
  readonly organizationId: string;
  readonly attemptId: string;
  readonly context: TransitionContext;
}

/**
 * The closed result of resolving one uncertain attempt.
 *
 * `REPLAYED` is a success: the caller's evidence is durably recorded, it simply
 * was already. `DEADLINE_EXPIRED` is not a failure of the evidence either — the
 * evidence may be perfectly good — it says the platform stopped waiting, and the
 * exhaustion path owns the row from that instant.
 */
export type ReconciliationResolutionResult =
  | {
      readonly kind: "APPLIED";
      readonly attemptId: string;
      readonly stateVersion: number;
      readonly entitlementAnomaly: EntitlementAnomaly;
    }
  | { readonly kind: "REPLAYED"; readonly attemptId: string }
  | { readonly kind: "ATTEMPT_NOT_FOUND" }
  | { readonly kind: "NOT_RECONCILING"; readonly reason: NotReconcilingReason }
  | { readonly kind: "DEADLINE_EXPIRED" }
  /** The window already closed and the attempt is terminal. No resurrection. */
  | { readonly kind: "RECONCILIATION_CLOSED" }
  | {
      readonly kind: "CONFLICTING_RESOLUTION";
      readonly reason: ReconciliationConflictReason;
    }
  | { readonly kind: "OBSERVATION_MALFORMED" }
  | { readonly kind: "LOST_CONCURRENCY" };

/** The closed result of closing one expired window. */
export type ReconciliationExhaustionResult =
  | {
      readonly kind: "EXHAUSTED";
      readonly attemptId: string;
      readonly stateVersion: number;
      readonly entitlementAnomaly: EntitlementAnomaly;
    }
  | { readonly kind: "ALREADY_EXHAUSTED"; readonly attemptId: string }
  | { readonly kind: "ATTEMPT_NOT_FOUND" }
  | { readonly kind: "NOT_RECONCILING"; readonly reason: NotReconcilingReason }
  | { readonly kind: "NOT_DUE"; readonly dueAt: EpochMillis }
  | { readonly kind: "LOST_CONCURRENCY" };
