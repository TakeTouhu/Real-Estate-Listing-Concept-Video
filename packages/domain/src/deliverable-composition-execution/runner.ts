/**
 * The bounded composition-execution coordinator.
 *
 * One pass: discover a bounded batch, and for each candidate claim → materialize
 * → compose → publish → finalize, or defer with a closed code. It does not loop,
 * sleep, schedule itself, own a timer or construct anything. Nothing in this
 * repository calls it.
 *
 * ## Why the ordering is what it is
 *
 * The claim is a short transaction that ends *before* any external work starts,
 * and the finalize is another short transaction that starts *after* all of it
 * finishes. Between them the worker holds a lease and no database resources.
 * Holding a transaction across a multi-gigabyte download and a twenty-minute
 * encode would pin a pooled connection for the whole encode and make one slow
 * deliverable a database-wide outage.
 *
 * ## Duplicate execution is designed for, not prevented
 *
 * A lease can expire under a healthy worker, so two workers may compose the same
 * deliverable. That is safe by construction rather than by luck: the plan and
 * the profile are immutable, so both produce the same intended video; canonical
 * publication is first-wins, so the second never overwrites the first; and
 * finalize is guarded by lease token and row version, so only one writes the
 * receipt. The loser's work is wasted, never wrong.
 *
 * ## One bad candidate never poisons the batch
 *
 * Each candidate is isolated. A defect thrown while executing one is recorded in
 * the report and the sweep continues, because a single inconsistent plan must
 * not stop every other deliverable in the batch from being composed.
 */

import { randomId } from "@app/shared";
import {
  DEFAULT_COMPOSITION_LEASE_MS,
  DEFAULT_COMPOSITION_RETRY_DELAY_MS,
  MAX_COMPOSITION_BATCH_SIZE,
  validateCompositionBatchLimit,
  validateCompositionLeaseMs,
  validateCompositionRetryDelayMs,
  type DeliverableCompositionRetryCode,
} from "./durable";
import type {
  DeliverableCompositionClaim,
  DeliverableCompositionRepository,
  DeliverableCompositionSourceMaterializer,
  DeliverableMediaComposer,
  DeliverableOutputPublisher,
} from "./ports";
import type { TransitionContext } from "../orchestration/ports";

export interface DeliverableCompositionDeps {
  readonly repository: DeliverableCompositionRepository;
  readonly materializer: DeliverableCompositionSourceMaterializer;
  readonly composer: DeliverableMediaComposer;
  readonly publisher: DeliverableOutputPublisher;
  /** Injected, never `Date.now()` inside the logic. */
  readonly clock: () => number;
  readonly context: (organizationId: string) => TransitionContext;
  readonly leaseMs?: number;
  readonly retryDelayMs?: number;
  /** Where the composed file is written. Provided by the materializer's dir. */
  readonly outputPathFor: (claim: DeliverableCompositionClaim) => string;
}

/** What one bounded pass did. Counts only — no ids, no keys, no receipts. */
export interface DeliverableCompositionReport {
  readonly considered: number;
  readonly claimed: number;
  readonly finalized: number;
  readonly alreadyFinalized: number;
  readonly deferred: number;
  readonly leaseLost: number;
  readonly notClaimable: number;
  readonly failed: number;
}

export class DeliverableCompositionRunner {
  readonly #deps: DeliverableCompositionDeps;
  readonly #leaseMs: number;
  readonly #retryDelayMs: number;

  constructor(deps: DeliverableCompositionDeps) {
    this.#deps = deps;
    this.#leaseMs = validateCompositionLeaseMs(deps.leaseMs ?? DEFAULT_COMPOSITION_LEASE_MS);
    this.#retryDelayMs = validateCompositionRetryDelayMs(
      deps.retryDelayMs ?? DEFAULT_COMPOSITION_RETRY_DELAY_MS,
    );
  }

  async runOnce(limit: number = MAX_COMPOSITION_BATCH_SIZE): Promise<DeliverableCompositionReport> {
    const bounded = validateCompositionBatchLimit(limit);
    const now = this.#deps.clock();
    const candidates = await this.#deps.repository.findCompositionCandidates({
      limit: bounded,
      now,
    });

    let claimed = 0;
    let finalized = 0;
    let alreadyFinalized = 0;
    let deferred = 0;
    let leaseLost = 0;
    let notClaimable = 0;
    let failed = 0;

    for (const candidate of candidates) {
      let outcome: "FINALIZED" | "ALREADY" | "DEFERRED" | "LEASE_LOST" | "NOT_CLAIMABLE" | "FAILED";
      try {
        outcome = await this.#execute(candidate.organizationId, candidate.deliverableVersionId);
      } catch {
        // Isolated on purpose. A defect on one deliverable is recorded and the
        // sweep continues; the alternative is that one inconsistent plan stops
        // every other deliverable in the batch from ever being composed.
        outcome = "FAILED";
      }
      switch (outcome) {
        case "FINALIZED":
          claimed += 1;
          finalized += 1;
          break;
        case "ALREADY":
          claimed += 1;
          alreadyFinalized += 1;
          break;
        case "DEFERRED":
          claimed += 1;
          deferred += 1;
          break;
        case "LEASE_LOST":
          claimed += 1;
          leaseLost += 1;
          break;
        case "NOT_CLAIMABLE":
          notClaimable += 1;
          break;
        default:
          failed += 1;
      }
    }

    return {
      considered: candidates.length,
      claimed,
      finalized,
      alreadyFinalized,
      deferred,
      leaseLost,
      notClaimable,
      failed,
    };
  }

  async #execute(
    organizationId: string,
    deliverableVersionId: string,
  ): Promise<"FINALIZED" | "ALREADY" | "DEFERRED" | "LEASE_LOST" | "NOT_CLAIMABLE"> {
    const claimedAt = this.#deps.clock();
    const claim = await this.#deps.repository.claimCompositionWork({
      organizationId,
      deliverableVersionId,
      now: claimedAt,
      // Opaque and random. It carries no organization, job, deliverable or
      // storage identity, so it discloses nothing if it is ever logged.
      leaseToken: randomId("clease"),
      leaseExpiresAt: claimedAt + this.#leaseMs,
      context: this.#deps.context(organizationId),
    });
    if (claim.kind !== "CLAIMED") return "NOT_CLAIMABLE";

    return this.#compose(claim.claim);
  }

  async #compose(
    claim: DeliverableCompositionClaim,
  ): Promise<"FINALIZED" | "ALREADY" | "DEFERRED" | "LEASE_LOST"> {
    const materialized = await this.#deps.materializer.materialize({
      organizationId: claim.organizationId,
      scenes: claim.scenes,
    });
    if (materialized.kind !== "MATERIALIZED") {
      return this.#defer(claim, sourceRetryCode(materialized.kind));
    }

    try {
      const outputPath = this.#deps.outputPathFor(claim);
      const composed = await this.#deps.composer.compose({
        clips: materialized.sources.map((source, index) => ({
          localPath: source.localPath,
          // Index rather than a lookup by position: the materializer returns
          // sources in the claim's own plan order, and the claim's scenes are
          // ordered by position. Re-deriving the pairing here would be a second
          // ordering rule that could disagree with the first.
          durationSeconds: claim.scenes[index]!.durationSeconds,
        })),
        profile: claim.profile,
        outputPath,
      });
      if (composed.kind !== "SUCCESS") return this.#defer(claim, "COMPOSER_RETRYABLE");

      const published = await this.#deps.publisher.publish({
        key: claim.outputStorageKey,
        localPath: outputPath,
      });
      if (published.kind !== "PUBLISHED") return this.#defer(claim, "OUTPUT_PUBLISH_RETRYABLE");

      const finalized = await this.#deps.repository.finalizeComposition({
        claim,
        outputSha256: published.sha256,
        outputSizeBytes: published.sizeBytes,
        verifiedAt: this.#deps.clock(),
        context: this.#deps.context(claim.organizationId),
      });
      if (finalized.kind === "FINALIZED") return "FINALIZED";
      if (finalized.kind === "ALREADY_FINALIZED") return "ALREADY";
      return "LEASE_LOST";
    } finally {
      // Unconditional, on every path including a thrown defect. A cleanup
      // failure is swallowed rather than allowed to replace the real answer:
      // leaving a temporary directory behind is an operational annoyance, and
      // losing the outcome of a successful composition is a defect.
      await materialized.release().catch(() => undefined);
    }
  }

  async #defer(
    claim: DeliverableCompositionClaim,
    retryCode: DeliverableCompositionRetryCode,
  ): Promise<"DEFERRED" | "LEASE_LOST"> {
    const outcome = await this.#deps.repository.deferComposition({
      claim,
      retryCode,
      nextAttemptAt: this.#deps.clock() + this.#retryDelayMs,
    });
    return outcome.kind === "DEFERRED" ? "DEFERRED" : "LEASE_LOST";
  }
}

function sourceRetryCode(
  kind: "RETRYABLE_FAILURE" | "INTEGRITY_MISMATCH" | "SOURCE_BUDGET_EXCEEDED",
): DeliverableCompositionRetryCode {
  if (kind === "INTEGRITY_MISMATCH") return "SOURCE_INTEGRITY_MISMATCH";
  // A source budget overrun is recorded as a read failure rather than given its
  // own code: from the operator's side both mean "this deliverable's sources
  // could not be brought down on this worker", and the budget is a machine
  // limit that a differently-sized worker may not hit.
  return "SOURCE_READ_RETRYABLE";
}
