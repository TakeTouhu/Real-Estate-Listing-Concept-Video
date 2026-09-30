/**
 * The dormant deliverable-validation and publication runner.
 *
 * Coordinates two collaborators that must never be merged:
 *
 * ```text
 * repository   database work only, in short transactions
 * validator    S3 read, temp materialization, ffprobe
 * this runner  the order in which those two are allowed to happen
 * ```
 *
 * ## The ordering this class exists to guarantee
 *
 * ```text
 * claim (tx opens, tx closes)
 *   → validate()                 no transaction open, no row lock held
 *     → finalize (tx opens, tx closes)
 *       → publish  (Transaction G: tx opens, tx closes)
 * ```
 *
 * The validator streams a composed deliverable — hundreds of megabytes — and then
 * launches a subprocess. Holding a row lock and a pooled connection across that
 * would let one slow object-store read exhaust the pool for work that is not
 * touching the database at all. The repository port takes no callback, so this
 * ordering is structural rather than a convention.
 *
 * Transaction G is the *last* step and a separate commit on purpose. It takes the
 * entitlement lock, and an entitlement lock held across a download is contention
 * with every cost workflow in the system.
 *
 * ## What a non-`VALID` verdict does here
 *
 * Nothing further. The verdict is made durable and the pass moves on: the job is
 * not failed, no unit is consumed, no reservation is released and the customer's
 * pointer does not move. During a recomposition the customer may already hold a
 * perfectly good video, and terminalizing the job over a replacement that could
 * not be validated would destroy what they already have. A settlement policy for
 * a permanently unusable deliverable is a separate, reviewed decision.
 *
 * ## Dormant
 *
 * Nothing in production constructs this runner, schedules it, or calls it. There
 * is no timer, no cron and no scheduler in this phase. It is driven by fakes and
 * by integration tests against a real database.
 */

import {
  parseManagedOutputMediaValidationOutcome,
  type ManagedOutputMediaValidationOutcome,
} from "../provider-output/media-validation";
import {
  DEFAULT_DELIVERABLE_VALIDATION_LEASE_MS,
  DEFAULT_DELIVERABLE_VALIDATION_RETRY_DELAY_MS,
  DeliverableValidationDefect,
  validateDeliverableValidationBatchLimit,
  validateDeliverableValidationLeaseMs,
  validateDeliverableValidationRetryDelayMs,
} from "./durable";
import type {
  DeliverableMediaValidationPort,
  DeliverableValidationClaim,
  DeliverableValidationLeaseTokenFactory,
  DeliverableValidationPublicationTarget,
  DeliverableValidationRepository,
} from "./ports";
import type { TransitionContext } from "../orchestration/ports";

/**
 * What one attempt at one deliverable version did. Closed and application-owned.
 *
 * The two published arms are distinct because they are different business facts:
 * one spent a customer's unit, the other replaced a video they had already paid
 * for. A caller that cannot tell them apart cannot report either honestly.
 */
export type DeliverableValidationRunOutcome =
  | { readonly kind: "PUBLISHED_AND_CONSUMED" }
  | { readonly kind: "PUBLISHED_AS_REPLACEMENT" }
  | { readonly kind: "ALREADY_PUBLISHED" }
  /** Validated, but the job moved on before publication. Ordinary. */
  | { readonly kind: "NOT_PUBLISHABLE" }
  /** Terminal verdict written. Nothing published, nothing settled. */
  | { readonly kind: "INVALID_MEDIA" }
  | { readonly kind: "INTEGRITY_MISMATCH" }
  /** Returned to `PENDING`. Not a verdict. */
  | { readonly kind: "RELEASED" }
  /** Another worker owns it, or it is not yet due. */
  | { readonly kind: "NOT_CLAIMABLE" }
  /** A terminal non-`VALID` verdict already exists. */
  | { readonly kind: "ALREADY_TERMINAL" }
  | { readonly kind: "NOT_ELIGIBLE" }
  | { readonly kind: "NOT_FOUND" }
  /** Claimed and finalized, but the write matched zero rows — reclaimed. */
  | { readonly kind: "LOST" };

export interface DeliverableValidationRunReport {
  readonly claimed: number;
  readonly outcomes: readonly {
    readonly deliverableVersionId: string;
    readonly outcome: DeliverableValidationRunOutcome;
  }[];
}

export interface DeliverableValidationConfig {
  /** Default {@link DEFAULT_DELIVERABLE_VALIDATION_LEASE_MS}. */
  readonly leaseMs?: number;
  /** Default {@link DEFAULT_DELIVERABLE_VALIDATION_RETRY_DELAY_MS}. */
  readonly retryDelayMs?: number;
}

export interface DeliverableValidationDeps {
  readonly repository: DeliverableValidationRepository;
  readonly validator: DeliverableMediaValidationPort;
  readonly clock: () => number;
  readonly leaseTokens: DeliverableValidationLeaseTokenFactory;
}

/** Outcome kinds that mean nothing was claimed and nothing was attempted. */
const UNCLAIMED_KINDS: readonly DeliverableValidationRunOutcome["kind"][] = [
  "NOT_CLAIMABLE",
  "ALREADY_TERMINAL",
  "NOT_ELIGIBLE",
  "NOT_FOUND",
];

export class DeliverableValidationRunner {
  readonly #repository: DeliverableValidationRepository;
  readonly #validator: DeliverableMediaValidationPort;
  readonly #clock: () => number;
  readonly #leaseTokens: DeliverableValidationLeaseTokenFactory;
  readonly #leaseMs: number;
  readonly #retryDelayMs: number;

  constructor(config: DeliverableValidationConfig, deps: DeliverableValidationDeps) {
    this.#leaseMs = validateDeliverableValidationLeaseMs(
      config.leaseMs ?? DEFAULT_DELIVERABLE_VALIDATION_LEASE_MS,
    );
    this.#retryDelayMs = validateDeliverableValidationRetryDelayMs(
      config.retryDelayMs ?? DEFAULT_DELIVERABLE_VALIDATION_RETRY_DELAY_MS,
    );
    this.#repository = deps.repository;
    this.#validator = deps.validator;
    this.#clock = deps.clock;
    this.#leaseTokens = deps.leaseTokens;
  }

  /**
   * One bounded pass.
   *
   * Each deliverable version is attempted at most once, because the candidate
   * listing is unique by version and nothing re-queues within a pass: a row
   * released to `PENDING` here becomes eligible on a later pass, after its retry
   * delay, not immediately in this loop.
   */
  async runOnce(limit: number, context: TransitionContext): Promise<DeliverableValidationRunReport> {
    const bounded = validateDeliverableValidationBatchLimit(limit);
    const candidates = await this.#repository.findValidationCandidates({
      now: this.#clock(),
      limit: bounded,
    });

    const outcomes: {
      deliverableVersionId: string;
      outcome: DeliverableValidationRunOutcome;
    }[] = [];
    let claimed = 0;
    for (const candidate of candidates) {
      const outcome = await this.#runOne(
        candidate.organizationId,
        candidate.deliverableVersionId,
        context,
      );
      if (!UNCLAIMED_KINDS.includes(outcome.kind)) claimed += 1;
      outcomes.push({ deliverableVersionId: candidate.deliverableVersionId, outcome });
    }
    return { claimed, outcomes };
  }

  async runOne(
    organizationId: string,
    deliverableVersionId: string,
    context: TransitionContext,
  ): Promise<DeliverableValidationRunOutcome> {
    return this.#runOne(organizationId, deliverableVersionId, context);
  }

  async #runOne(
    organizationId: string,
    deliverableVersionId: string,
    context: TransitionContext,
  ): Promise<DeliverableValidationRunOutcome> {
    // ---- 1. Claim. One short transaction, no external I/O inside it. -------
    const now = this.#clock();
    const claimed = await this.#repository.claimDeliverableValidation({
      organizationId,
      deliverableVersionId,
      now,
      leaseToken: this.#leaseTokens.next(),
      leaseExpiresAt: now + this.#leaseMs,
    });

    switch (claimed.kind) {
      case "NOT_CLAIMABLE":
      case "ALREADY_TERMINAL":
      case "NOT_ELIGIBLE":
      case "NOT_FOUND":
        return { kind: claimed.kind };
      case "ALREADY_VALID":
        // The verdict survived a crash and the publication did not happen. No
        // lease is taken and nothing is re-validated: the bytes were already
        // proved usable, the receipt is frozen, and Transaction G is idempotent.
        return this.#publish(claimed.publication, context);
      case "CLAIMED":
        break;
    }
    const claim = claimed.claim;

    // ---- 2. Validate. No transaction is open here, by construction. --------
    let raw: unknown;
    try {
      raw = await this.#validator.validateDeliverable({
        deliverableKey: claim.outputStorageKey,
        expectedReceipt: claim.expectedReceipt,
      });
    } catch {
      // A thrown validator is not evidence about the media. The lease is handed
      // back so the row is retried rather than stranded in `RUNNING` until
      // expiry, and only a fixed application-owned defect leaves this method —
      // never the adapter's own error, its message, or its `cause`.
      await this.#releaseQuietly(claim);
      throw new DeliverableValidationDefect("VALIDATOR_FAILED");
    }

    // Read the adapter's value exactly once, through the single existing
    // authority. No second parser is introduced, and the raw value is never
    // consulted again — a stateful getter that answers once and then changes
    // cannot make the dispatch below disagree with the validation above.
    const outcome: ManagedOutputMediaValidationOutcome | null =
      parseManagedOutputMediaValidationOutcome(raw);
    if (outcome === null) {
      await this.#releaseQuietly(claim);
      throw new DeliverableValidationDefect("VALIDATOR_RESULT_MALFORMED");
    }

    // ---- 3. Finalize. Another short transaction. ---------------------------
    const validatedAt = this.#clock();
    switch (outcome.kind) {
      case "VALID": {
        const written = await this.#repository.finalizeValid({
          claim,
          facts: outcome.facts,
          validatedAt,
          context,
        });
        if (written.kind === "LEASE_LOST") return { kind: "LOST" };
        // ---- 4. Transaction G. A third short transaction. -----------------
        return this.#publish(written.publication, context);
      }
      case "INVALID_MEDIA": {
        const written = await this.#repository.finalizeInvalidMedia({
          claim,
          reason: outcome.reason,
          validatedAt,
        });
        return written.kind === "LEASE_LOST" ? { kind: "LOST" } : { kind: "INVALID_MEDIA" };
      }
      case "INTEGRITY_MISMATCH": {
        const written = await this.#repository.finalizeIntegrityMismatch({ claim, validatedAt });
        return written.kind === "LEASE_LOST" ? { kind: "LOST" } : { kind: "INTEGRITY_MISMATCH" };
      }
      case "RETRYABLE_FAILURE": {
        // Not a verdict — the absence of one. No durable terminal state, no job,
        // reservation or pointer change: a storage hiccup must never become a
        // permanent record that a customer's deliverable is unusable.
        const released = await this.#repository.deferValidation({
          claim,
          nextAttemptAt: validatedAt + this.#retryDelayMs,
        });
        return released.kind === "LEASE_LOST" ? { kind: "LOST" } : { kind: "RELEASED" };
      }
    }
  }

  /** Transaction G, with its outcome carried through unchanged. */
  async #publish(
    publication: DeliverableValidationPublicationTarget,
    context: TransitionContext,
  ): Promise<DeliverableValidationRunOutcome> {
    const published = await this.#repository.publishDeliverable({
      publication,
      publishedAt: this.#clock(),
      context,
    });
    return { kind: published.kind };
  }

  /**
   * Hand the lease back, best effort.
   *
   * Used on the defect paths, where a release failure must not replace the
   * defect the caller needs to see. Losing the release is harmless: the lease
   * expires and the row is reclaimed.
   */
  async #releaseQuietly(claim: DeliverableValidationClaim): Promise<void> {
    try {
      await this.#repository.deferValidation({
        claim,
        nextAttemptAt: this.#clock() + this.#retryDelayMs,
      });
    } catch {
      // Best effort; nothing in scope to leak.
    }
  }
}
