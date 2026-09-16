/**
 * The durable media-validation lifecycle ports.
 *
 * ## No transaction may span external I/O
 *
 * This is enforced by the *shape* of the port, not by a comment asking callers
 * to behave. No method here accepts a callback, so there is no way for a
 * repository transaction to wrap an S3 GET, a stream materialization, a
 * temp-file write or an `ffprobe` invocation. The runner must call three
 * separate operations — `claim`, then the validator, then a `finalize` — and
 * each database operation opens and closes its own short transaction.
 *
 * A callback-shaped `withClaim(id, async (claim) => …)` would be more
 * convenient and would silently hold a row lock and a connection for the entire
 * duration of a multi-megabyte download. Under load that is how a connection
 * pool is exhausted by work that is not touching the database at all.
 */

import type {
  ManagedGenerationOutputKey,
  ManagedOutputVerificationReceipt,
} from "../completion/output";
import type {
  ManagedOutputMediaFacts,
  ManagedOutputMediaInvalidReason,
} from "../provider-output/media-validation";
import type { DurableMediaValidationRecord } from "./durable";

/**
 * A candidate is an identifier and nothing else.
 *
 * Deliberately not enough to act on. Everything needed to *decide* is absent,
 * so a caller cannot mistake the listing for authority: the claim re-checks
 * eligibility under the row's own lock, because between the listing and the
 * claim another worker may have taken the row, the attempt may have changed, or
 * the lease may have been renewed.
 */
export interface MediaValidationCandidate {
  readonly sceneGenerationId: string;
}

/**
 * Ownership of one validation, proved by three things at once.
 *
 * The `version` and `leaseToken` together are what make a stale worker's late
 * finalize a no-op, and the receipt is carried so every later write can assert
 * it is still describing the bytes the claim was established against.
 */
export interface MediaValidationClaim {
  readonly validationId: string;
  readonly sceneGenerationId: string;
  readonly version: number;
  readonly leaseToken: string;
  readonly destinationKey: ManagedGenerationOutputKey;
  readonly expectedReceipt: ManagedOutputVerificationReceipt;
}

/**
 * What one claim attempt concluded.
 *
 * `NOT_CLAIMED` and `ALREADY_TERMINAL` are distinct because they call for
 * different runner behaviour: the first is an ordinary race another worker won
 * and will finish, the second is a settled answer nobody should revisit.
 */
export type MediaValidationClaimOutcome =
  | { readonly kind: "CLAIMED"; readonly claim: MediaValidationClaim }
  /** Another worker holds an unexpired lease, or the row is not yet due. */
  | { readonly kind: "NOT_CLAIMED" }
  /** A terminal verdict already exists. Never reopened. */
  | { readonly kind: "ALREADY_TERMINAL" }
  /** The attempt is no longer an eligible OUTPUT_VERIFIED row. */
  | { readonly kind: "NOT_ELIGIBLE" };

/**
 * What one finalize concluded.
 *
 * `LOST` is the safe outcome, not an error: the write matched zero rows because
 * the lease token, the version or the receipt binding no longer agrees. A
 * worker whose lease expired and whose row was reclaimed must lose here, and
 * must not treat losing as a failure worth retrying or reporting.
 */
export type MediaValidationWriteOutcome =
  | { readonly kind: "WRITTEN" }
  | { readonly kind: "LOST" };

export interface MediaValidationCandidateQuery {
  /** Epoch ms. Due-ness and lease expiry are judged against this instant. */
  readonly now: number;
  readonly limit: number;
}

export interface MediaValidationClaimInput {
  readonly sceneGenerationId: string;
  readonly now: number;
  /** Opaque, carrying no tenant, attempt, key or provider identity. */
  readonly leaseToken: string;
  /** Epoch ms. */
  readonly leaseExpiresAt: number;
}

export interface MediaValidationFinalizeValidInput {
  readonly claim: MediaValidationClaim;
  readonly facts: ManagedOutputMediaFacts;
  /** Epoch ms. */
  readonly validatedAt: number;
}

export interface MediaValidationFinalizeInvalidInput {
  readonly claim: MediaValidationClaim;
  readonly reason: ManagedOutputMediaInvalidReason;
  readonly validatedAt: number;
}

export interface MediaValidationFinalizeMismatchInput {
  readonly claim: MediaValidationClaim;
  readonly validatedAt: number;
}

export interface MediaValidationReleaseInput {
  readonly claim: MediaValidationClaim;
  /** Epoch ms at which the row becomes eligible again. */
  readonly nextAttemptAt: number;
}

export interface MediaValidationLifecycleRepository {
  /** Bounded, deterministic, one row per SceneGeneration. A hint only. */
  findCandidates(query: MediaValidationCandidateQuery): Promise<readonly MediaValidationCandidate[]>;

  /**
   * Re-check eligibility and take ownership, in one short transaction.
   *
   * Creates the row when absent — historical `OUTPUT_VERIFIED` attempts have no
   * validation record and are discovered here rather than backfilled.
   */
  claim(input: MediaValidationClaimInput): Promise<MediaValidationClaimOutcome>;

  finalizeValid(input: MediaValidationFinalizeValidInput): Promise<MediaValidationWriteOutcome>;
  finalizeInvalidMedia(
    input: MediaValidationFinalizeInvalidInput,
  ): Promise<MediaValidationWriteOutcome>;
  finalizeIntegrityMismatch(
    input: MediaValidationFinalizeMismatchInput,
  ): Promise<MediaValidationWriteOutcome>;

  /** `RUNNING` → `PENDING` with a future attempt time. Never a verdict. */
  releaseToPending(input: MediaValidationReleaseInput): Promise<MediaValidationWriteOutcome>;

  /** The application-owned read model. `null` when no record exists yet. */
  findBySceneGeneration(sceneGenerationId: string): Promise<DurableMediaValidationRecord | null>;
}

/** Produces opaque lease tokens. Injected so tests can be deterministic. */
export interface MediaValidationLeaseTokenFactory {
  next(): string;
}
