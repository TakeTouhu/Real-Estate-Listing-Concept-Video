/**
 * The durable media-failure resolution boundary.
 *
 * The shape mirrors the media-validation lifecycle deliberately: discovery is a
 * hint, `claim` is the only authority, and every write after a claim carries the
 * claim's `version` and `leaseToken` so a stale worker's late finalize matches
 * zero rows instead of overwriting whoever reclaimed the work.
 *
 * No method accepts a callback, for the reason Phase 6B gives: a repository that
 * took a planner would let a pricing lookup or an FX acquisition run inside an
 * open database transaction. Planning happens between `claim` and the method
 * that acts on it, in the caller, outside any transaction.
 */

import type { TransitionContext } from "../orchestration/ports";
import type { AutomaticMediaRecoveryCandidate } from "../media-recovery/ports";
import type { RecoveryPlanRefusalCode } from "../media-recovery/policy";
import type {
  MediaFailureResolutionKind,
  SettleExhaustedMediaFailureOutcome,
} from "./policy";

/** A row worth claiming. Identifiers only — nothing here is a decision. */
export interface MediaFailureResolutionCandidate {
  readonly sourceValidationId: string;
}

export interface MediaFailureResolutionQuery {
  readonly now: number;
  readonly limit: number;
}

/**
 * What this piece of work turns out to need, decided under the claim's own lock.
 *
 * Still not the final authority: `settleExhaustedMediaFailure` re-reads and
 * re-checks everything under the full lock chain, because the claim transaction
 * holds no lock on the Job, Scene, request or reservation it would mutate.
 */
export type MediaFailureResolutionDisposition =
  /** No recovery exists yet and the failure is the PRIMARY attempt's. */
  | { readonly kind: "ADMIT_RECOVERY"; readonly candidate: AutomaticMediaRecoveryCandidate }
  /**
   * A recovery for this request already exists. Either another worker admitted
   * it, or this work's own previous claim admitted it and died before resolving
   * the row — indistinguishable, and treated identically: bind to the attempt
   * that exists and never create a second one.
   */
  | { readonly kind: "RECONCILE_RECOVERY"; readonly recoveryAttemptId: string }
  /** The failure is the spent automatic recovery's own. The customer is owed an answer. */
  | { readonly kind: "SETTLE_EXHAUSTED" }
  /** A locked read proved no customer mutation is required. */
  | { readonly kind: "OBSOLETE" };

/**
 * Ownership of one piece of work, for exactly one lease period.
 *
 * `version` and `leaseToken` together are what make a late write from a crashed
 * worker harmless.
 */
export interface MediaFailureResolutionClaim {
  readonly workId: string;
  readonly sourceValidationId: string;
  readonly sourceAttemptId: string;
  readonly organizationId: string;
  readonly version: number;
  readonly leaseToken: string;
  readonly disposition: MediaFailureResolutionDisposition;
}

export type MediaFailureResolutionClaimOutcome =
  | { readonly kind: "CLAIMED"; readonly claim: MediaFailureResolutionClaim }
  /** Somebody else holds it, or it is not due yet. Ordinary. */
  | { readonly kind: "NOT_CLAIMED" }
  /** Already resolved. Terminal work is never reopened. */
  | { readonly kind: "ALREADY_RESOLVED"; readonly resolutionKind: MediaFailureResolutionKind }
  /** The validation does not carry a terminal media failure, or is invisible. */
  | { readonly kind: "NOT_ELIGIBLE" };

export interface ClaimMediaFailureResolutionInput {
  readonly sourceValidationId: string;
  readonly now: number;
  /** Opaque and random. Carries no tenant, attempt or key identity. */
  readonly leaseToken: string;
  readonly leaseExpiresAt: number;
}

export interface DeferMediaFailureResolutionInput {
  readonly claim: MediaFailureResolutionClaim;
  readonly refusalCode: RecoveryPlanRefusalCode;
  /** When this row becomes a candidate again. Always in the future. */
  readonly nextAttemptAt: number;
}

export interface ResolveMediaFailureResolutionInput {
  readonly claim: MediaFailureResolutionClaim;
  readonly resolvedAt: number;
}

export interface ResolveRecoveryAdmittedInput extends ResolveMediaFailureResolutionInput {
  /** The exact attempt this work produced or reconciled to. Never a new one. */
  readonly recoveryAttemptId: string;
}

/**
 * Whether a guarded write landed.
 *
 * `LOST` is ordinary and never an error: it is what a stale worker sees, and
 * seeing it is the mechanism working.
 */
export type MediaFailureResolutionWriteOutcome =
  | { readonly kind: "APPLIED" }
  | { readonly kind: "LOST" };

/**
 * Hand a claim back untouched, so a crash costs nothing but a retry delay.
 *
 * Distinct from `defer`, which records *why* planning refused. A release says
 * only "this worker is no longer holding it", which is the honest record when
 * the planner threw and the reason is deliberately unknown to us.
 */
export interface ReleaseMediaFailureResolutionInput {
  readonly claim: MediaFailureResolutionClaim;
  readonly nextAttemptAt: number;
}

export interface SettleExhaustedMediaFailureInput {
  readonly claim: MediaFailureResolutionClaim;
  /**
   * The one instant every row in the settlement records — `failedAt`,
   * `releasedAt` and `resolvedAt` are the same number, because they are one
   * business fact rather than three events that happened to be close together.
   */
  readonly settledAt: number;
  readonly context: TransitionContext;
}

export interface MediaFailureResolutionRepository {
  /**
   * Bounded, deterministic, one row per source validation. A hint only.
   *
   * Deferred work is absent from the result until `nextAttemptAt` arrives, which
   * is exactly what keeps an unplannable prefix from owning every sweep.
   */
  findResolutionCandidates(
    query: MediaFailureResolutionQuery,
  ): Promise<readonly MediaFailureResolutionCandidate[]>;

  /** Create-or-take, conflict-free. The only place ownership is established. */
  claim(
    input: ClaimMediaFailureResolutionInput,
  ): Promise<MediaFailureResolutionClaimOutcome>;

  /** Hand the work back for later. Records why, and moves nothing else. */
  defer(
    input: DeferMediaFailureResolutionInput,
  ): Promise<MediaFailureResolutionWriteOutcome>;

  /** Release a claim without resolving it, so a crash does not cost a lease period. */
  release(
    input: ReleaseMediaFailureResolutionInput,
  ): Promise<MediaFailureResolutionWriteOutcome>;

  resolveRecoveryAdmitted(
    input: ResolveRecoveryAdmittedInput,
  ): Promise<MediaFailureResolutionWriteOutcome>;

  resolveObsolete(
    input: ResolveMediaFailureResolutionInput,
  ): Promise<MediaFailureResolutionWriteOutcome>;

  /**
   * Transaction H — every customer-visible consequence of an exhausted media
   * failure, in one commit, including resolving this work row.
   *
   * Never three calls. A request marked failed in one commit and a reservation
   * released in another is two crash boundaries whose half-applied states nobody
   * can repair afterwards.
   */
  settleExhaustedMediaFailure(
    input: SettleExhaustedMediaFailureInput,
  ): Promise<SettleExhaustedMediaFailureOutcome>;
}
