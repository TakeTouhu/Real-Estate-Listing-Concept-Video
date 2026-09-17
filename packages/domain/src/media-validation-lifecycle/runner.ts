/**
 * The dormant durable media-validation lifecycle runner.
 *
 * Coordinates three collaborators that must never be merged:
 *
 * ```text
 * repository            database work only, in short transactions
 * media validator       S3 read, temp materialization, ffprobe
 * this runner           the order in which those two are allowed to happen
 * ```
 *
 * ## The ordering this class exists to guarantee
 *
 * ```text
 * claim (tx opens, tx closes)
 *   → validate()            no transaction open, no row lock held
 *     → finalize (tx opens, tx closes)
 * ```
 *
 * The validator streams a potentially multi-megabyte object and then launches a
 * subprocess. Holding a row lock and a pooled connection across that would let
 * one slow object-store read exhaust the connection pool for work that is not
 * touching the database at all. The repository port takes no callback, so this
 * ordering is structural rather than a convention.
 *
 * ## What this phase deliberately does not do
 *
 * A `VALID` record does not make a Scene ready. An `INVALID_MEDIA` or
 * `INTEGRITY_MISMATCH` record does not create a `SYSTEM_RECOVERY` attempt, fail
 * a Scene, or touch a reservation or quota. Those are product decisions about
 * what a media verdict *means*, and they belong to a later reviewed package.
 * This phase's job is to make the verdict durable and safely retryable, so that
 * the later decision has a trustworthy fact to act on.
 *
 * ## Dormant
 *
 * Nothing in production constructs this runner, schedules it, or calls it. It
 * is driven by fakes and by an integration test against a real database.
 */

import {
  parseManagedOutputMediaValidationOutcome,
  type ManagedOutputMediaValidationOutcome,
  type ManagedOutputMediaValidationPort,
} from "../provider-output/media-validation";
import {
  DEFAULT_MEDIA_VALIDATION_LEASE_MS,
  DEFAULT_MEDIA_VALIDATION_RETRY_DELAY_MS,
  MediaValidationLifecycleDefect,
  validateMediaValidationBatchLimit,
  validateMediaValidationLeaseMs,
  validateMediaValidationRetryDelayMs,
} from "./durable";
import type {
  MediaValidationClaim,
  MediaValidationLeaseTokenFactory,
  MediaValidationLifecycleRepository,
} from "./ports";

/** What one attempt at one SceneGeneration did. Closed and application-owned. */
export type MediaValidationRunOutcome =
  | { readonly kind: "VALID" }
  | { readonly kind: "INVALID_MEDIA" }
  | { readonly kind: "INTEGRITY_MISMATCH" }
  /** Released back to PENDING. Not a verdict. */
  | { readonly kind: "RELEASED" }
  /** Another worker owns it, or it is not yet due. */
  | { readonly kind: "NOT_CLAIMED" }
  | { readonly kind: "ALREADY_TERMINAL" }
  | { readonly kind: "NOT_ELIGIBLE" }
  /** Claimed and finalized, but the write matched zero rows — reclaimed. */
  | { readonly kind: "LOST" };

export interface MediaValidationRunReport {
  readonly claimed: number;
  readonly outcomes: readonly {
    readonly sceneGenerationId: string;
    readonly outcome: MediaValidationRunOutcome;
  }[];
}

export interface MediaValidationLifecycleConfig {
  /** Default {@link DEFAULT_MEDIA_VALIDATION_LEASE_MS}. */
  readonly leaseMs?: number;
  /** Default {@link DEFAULT_MEDIA_VALIDATION_RETRY_DELAY_MS}. */
  readonly retryDelayMs?: number;
}

export interface MediaValidationLifecycleDeps {
  readonly repository: MediaValidationLifecycleRepository;
  readonly validator: ManagedOutputMediaValidationPort;
  readonly clock: () => number;
  readonly leaseTokens: MediaValidationLeaseTokenFactory;
}

export class MediaValidationLifecycleRunner {
  readonly #repository: MediaValidationLifecycleRepository;
  readonly #validator: ManagedOutputMediaValidationPort;
  readonly #clock: () => number;
  readonly #leaseTokens: MediaValidationLeaseTokenFactory;
  readonly #leaseMs: number;
  readonly #retryDelayMs: number;

  constructor(config: MediaValidationLifecycleConfig, deps: MediaValidationLifecycleDeps) {
    this.#leaseMs = validateMediaValidationLeaseMs(
      config.leaseMs ?? DEFAULT_MEDIA_VALIDATION_LEASE_MS,
    );
    this.#retryDelayMs = validateMediaValidationRetryDelayMs(
      config.retryDelayMs ?? DEFAULT_MEDIA_VALIDATION_RETRY_DELAY_MS,
    );
    this.#repository = deps.repository;
    this.#validator = deps.validator;
    this.#clock = deps.clock;
    this.#leaseTokens = deps.leaseTokens;
  }

  /**
   * One bounded pass. Each SceneGeneration is attempted at most once, because
   * the candidate listing is unique by SceneGeneration and nothing re-queues
   * within a pass — a row released to `PENDING` here becomes eligible again on
   * a later pass, after its retry delay, not immediately in this loop.
   */
  async runOnce(limit: number): Promise<MediaValidationRunReport> {
    const bounded = validateMediaValidationBatchLimit(limit);
    const candidates = await this.#repository.findCandidates({
      now: this.#clock(),
      limit: bounded,
    });

    const outcomes: { sceneGenerationId: string; outcome: MediaValidationRunOutcome }[] = [];
    let claimed = 0;
    for (const candidate of candidates) {
      const outcome = await this.#runOne(candidate.sceneGenerationId);
      if (
        outcome.kind !== "NOT_CLAIMED" &&
        outcome.kind !== "ALREADY_TERMINAL" &&
        outcome.kind !== "NOT_ELIGIBLE"
      ) {
        claimed += 1;
      }
      outcomes.push({ sceneGenerationId: candidate.sceneGenerationId, outcome });
    }
    return { claimed, outcomes };
  }

  async runOne(sceneGenerationId: string): Promise<MediaValidationRunOutcome> {
    return this.#runOne(sceneGenerationId);
  }

  async #runOne(sceneGenerationId: string): Promise<MediaValidationRunOutcome> {
    // ---- 1. Claim. One short transaction, no external I/O inside it. -------
    const now = this.#clock();
    const claimed = await this.#repository.claim({
      sceneGenerationId,
      now,
      leaseToken: this.#leaseTokens.next(),
      leaseExpiresAt: now + this.#leaseMs,
    });
    if (claimed.kind !== "CLAIMED") return { kind: claimed.kind };
    const claim = claimed.claim;

    // ---- 2. Validate. No transaction is open here, by construction. --------
    let raw: unknown;
    try {
      raw = await this.#validator.validate({
        destinationKey: claim.destinationKey,
        expectedReceipt: claim.expectedReceipt,
      });
    } catch {
      // A thrown validator is not evidence about the media. The lease is handed
      // back so the row is retried rather than stranded in RUNNING until expiry,
      // and only a fixed application-owned defect leaves this method — never the
      // adapter's own error, its message, or its `cause`.
      await this.#releaseQuietly(claim);
      throw new MediaValidationLifecycleDefect("VALIDATOR_FAILED");
    }

    // Read the adapter's value exactly once, through the single existing
    // authority. No second parser is introduced, and the raw value is never
    // consulted again — a stateful getter that answers once and then changes
    // cannot make the dispatch below disagree with the validation above.
    const outcome: ManagedOutputMediaValidationOutcome | null =
      parseManagedOutputMediaValidationOutcome(raw);
    if (outcome === null) {
      await this.#releaseQuietly(claim);
      throw new MediaValidationLifecycleDefect("VALIDATOR_RESULT_MALFORMED");
    }

    // ---- 3. Finalize. Another short transaction. ---------------------------
    const validatedAt = this.#clock();
    switch (outcome.kind) {
      case "VALID": {
        const written = await this.#repository.finalizeValid({
          claim,
          facts: outcome.facts,
          validatedAt,
        });
        return written.kind === "WRITTEN" ? { kind: "VALID" } : { kind: "LOST" };
      }
      case "INVALID_MEDIA": {
        const written = await this.#repository.finalizeInvalidMedia({
          claim,
          reason: outcome.reason,
          validatedAt,
        });
        return written.kind === "WRITTEN" ? { kind: "INVALID_MEDIA" } : { kind: "LOST" };
      }
      case "INTEGRITY_MISMATCH": {
        const written = await this.#repository.finalizeIntegrityMismatch({ claim, validatedAt });
        return written.kind === "WRITTEN" ? { kind: "INTEGRITY_MISMATCH" } : { kind: "LOST" };
      }
      case "RETRYABLE_FAILURE": {
        // Not a verdict — the absence of one. No durable terminal state, no
        // Scene, Job, reservation or quota change: a storage hiccup must never
        // become a permanent record that a customer's output is unusable.
        const released = await this.#repository.releaseToPending({
          claim,
          nextAttemptAt: validatedAt + this.#retryDelayMs,
        });
        return released.kind === "WRITTEN" ? { kind: "RELEASED" } : { kind: "LOST" };
      }
    }
  }

  /**
   * Hand the lease back, best effort.
   *
   * Used on the defect paths, where a release failure must not replace the
   * defect the caller needs to see. Losing the release is harmless: the lease
   * expires and the row is reclaimed.
   */
  async #releaseQuietly(claim: MediaValidationClaim): Promise<void> {
    try {
      await this.#repository.releaseToPending({
        claim,
        nextAttemptAt: this.#clock() + this.#retryDelayMs,
      });
    } catch {
      // Best effort; nothing in scope to leak.
    }
  }
}
