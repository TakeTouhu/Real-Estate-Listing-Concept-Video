import type { EpochMillis } from "../pricing/units";
import type { TransitionContext } from "../orchestration/ports";
import type { GenerationReservationState } from "../orchestration/types";
import type { AttemptSubmissionFacts, SubmissionOutcomeWrite } from "./outcome";
import type {
  NotAtBoundaryReason,
  SubmissionConflictReason,
} from "./outcome";
import type { ProviderSubmissionObservation } from "./observation";

/**
 * What recording a submission outcome needs from persistence, and nothing else.
 *
 * No provider client, no HTTP, and no way to add one without editing this file.
 * This phase records what a caller *already learned*; it never goes and asks.
 * A reconciliation worker that polls a provider is a later phase and a
 * different dependency set.
 */

/** The clock the stale-submitting judgement is made against. */
export interface SubmissionClock {
  now(): EpochMillis;
}

export function createSystemSubmissionClock(): SubmissionClock {
  return {
    now(): EpochMillis {
      return Date.now() as EpochMillis;
    },
  };
}

export function createFixedSubmissionClock(instant: EpochMillis): SubmissionClock {
  return {
    now(): EpochMillis {
      return instant;
    },
  };
}

/** What the reservation looked like when the outcome landed. */
export interface ReservationOutcomeFacts {
  readonly id: string;
  readonly state: GenerationReservationState;
  readonly stateVersion: number;
}

/** Everything one decision reads, loaded under one lock. */
export interface SubmissionOutcomeFacts {
  readonly attempt: AttemptSubmissionFacts;
  /** `null` when the job has no reservation at all — an anomaly, not a block. */
  readonly reservation: ReservationOutcomeFacts | null;
}

/**
 * The serialized write boundary.
 *
 * `withAttemptOutcome` runs its callback inside one transaction that already
 * holds the locks this phase needs, in the order Phase 4C-3B-2F-1 fixed:
 * organization+cycle advisory lock, then the reservation row, then the attempt
 * compare-and-set. Taking them in that order is what keeps outcome recording
 * from deadlocking against paid authorization.
 */
export interface SubmissionOutcomeRepository {
  withAttemptOutcome<T>(
    input: { readonly organizationId: string; readonly attemptId: string },
    run: (session: SubmissionOutcomeSession) => Promise<T>,
  ): Promise<T>;
}

export interface SubmissionOutcomeSession {
  /** `null` when the attempt is missing, cross-tenant, or not orchestrated. */
  loadFacts(): Promise<SubmissionOutcomeFacts | null>;
  /**
   * Apply the decided write as one compare-and-set, with its transition event
   * and — when the write says so — the reservation hold, in the same commit.
   */
  apply(input: {
    readonly expectedVersion: number;
    readonly write: SubmissionOutcomeWrite;
    readonly context: TransitionContext;
  }): Promise<ApplyOutcomeResult>;
}

export type ApplyOutcomeResult =
  | { readonly kind: "APPLIED"; readonly stateVersion: number }
  | { readonly kind: "LOST" };

export interface SubmissionOutcomeDeps {
  readonly outcomes: SubmissionOutcomeRepository;
  readonly clock: SubmissionClock;
  readonly policy: import("./reconciliation-window").ReconciliationPolicy;
}

/** The whole caller-supplied input for a directly observed outcome. */
export interface RecordSubmissionObservationInput {
  readonly organizationId: string;
  readonly attemptId: string;
  readonly observation: ProviderSubmissionObservation;
  readonly context: TransitionContext;
}

/** The whole caller-supplied input for stale-submitting recovery. */
export interface EnterUncertaintyForStaleInput {
  readonly organizationId: string;
  readonly attemptId: string;
  readonly normalizedErrorCode: string | null;
  readonly context: TransitionContext;
}

/**
 * The closed result of recording one submission outcome.
 *
 * `REPLAYED` is a success, not a soft failure: the caller's news is durably
 * recorded, it simply was already. Callers that retry on any non-`APPLIED`
 * answer would otherwise loop forever on their own earlier success.
 *
 * `CONFLICTING_OBSERVATION` is the fail-closed arm. Nothing is written, the row
 * keeps the outcome it already had, and a human decides — because two different
 * claims about what one provider did cannot both be recorded, and picking the
 * newer one would silently discard a provider reference the platform may still
 * owe money against.
 */
export type SubmissionOutcomeResult =
  | { readonly kind: "APPLIED"; readonly attemptId: string; readonly stateVersion: number }
  | { readonly kind: "REPLAYED"; readonly attemptId: string }
  | {
      readonly kind: "CONFLICTING_OBSERVATION";
      readonly reason: SubmissionConflictReason;
    }
  | { readonly kind: "ATTEMPT_NOT_FOUND" }
  | {
      readonly kind: "ATTEMPT_NOT_AT_BOUNDARY";
      readonly reason: NotAtBoundaryReason;
    }
  | { readonly kind: "OBSERVATION_MALFORMED" }
  /** Stale recovery only: the attempt has not yet sat there long enough. */
  | { readonly kind: "NOT_STALE_YET"; readonly staleAt: EpochMillis | null }
  | { readonly kind: "LOST_CONCURRENCY" };
