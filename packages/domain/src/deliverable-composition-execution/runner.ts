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
 *
 * ## Deterministic refusals are proved before any adapter runs
 *
 * Two facts about a claim are decidable from frozen numbers alone: whether the
 * plan's source bytes fit the worker's budget, and whether the frozen scene
 * durations sum to the length the job was admitted for. Both are checked
 * immediately after the claim and **before the materializer, composer or
 * publisher is touched**, and both end in `BLOCKED`.
 *
 * Checking them first is not an optimization. Downloading gigabytes to discover
 * arithmetic that was already knowable wastes a worker; deferring the answer
 * instead of blocking on it produces an automatic infinite retry that fails
 * identically every five minutes and tells nobody.
 */

import { randomId } from "@app/shared";
import {
  DEFAULT_COMPOSITION_LEASE_MS,
  DEFAULT_COMPOSITION_RETRY_DELAY_MS,
  MAX_COMPOSITION_BATCH_SIZE,
  MAX_DELIVERABLE_COMPOSITION_SOURCE_BYTES,
  validateCompositionBatchLimit,
  validateCompositionLeaseMs,
  validateCompositionRetryDelayMs,
  type DeliverableCompositionBlockCode,
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
  /** Deterministic refusals. Counted apart from `deferred` on purpose. */
  readonly blocked: number;
  readonly leaseLost: number;
  readonly notClaimable: number;
  /** Claims refused because the job's target is outside profile v1. */
  readonly unsupportedTarget: number;
  readonly failed: number;
}

type ExecutionOutcome =
  | "FINALIZED"
  | "ALREADY"
  | "DEFERRED"
  | "BLOCKED"
  | "LEASE_LOST"
  | "NOT_CLAIMABLE"
  | "UNSUPPORTED_TARGET";

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
    let blocked = 0;
    let leaseLost = 0;
    let notClaimable = 0;
    let unsupportedTarget = 0;
    let failed = 0;

    for (const candidate of candidates) {
      let outcome: ExecutionOutcome | "FAILED";
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
        case "BLOCKED":
          claimed += 1;
          blocked += 1;
          break;
        case "LEASE_LOST":
          claimed += 1;
          leaseLost += 1;
          break;
        case "NOT_CLAIMABLE":
          notClaimable += 1;
          break;
        case "UNSUPPORTED_TARGET":
          unsupportedTarget += 1;
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
      blocked,
      leaseLost,
      notClaimable,
      unsupportedTarget,
      failed,
    };
  }

  async #execute(
    organizationId: string,
    deliverableVersionId: string,
  ): Promise<ExecutionOutcome> {
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
    if (claim.kind === "UNSUPPORTED_TARGET") return "UNSUPPORTED_TARGET";
    if (claim.kind !== "CLAIMED") return "NOT_CLAIMABLE";

    // Everything decidable from the claim alone, decided before a byte moves.
    const deterministic = deterministicRefusal(claim.claim);
    if (deterministic !== null) return this.#block(claim.claim, deterministic);

    return this.#compose(claim.claim);
  }

  async #compose(
    claim: DeliverableCompositionClaim,
  ): Promise<"FINALIZED" | "ALREADY" | "DEFERRED" | "BLOCKED" | "LEASE_LOST"> {
    const materialized = await this.#deps.materializer.materialize({
      organizationId: claim.organizationId,
      scenes: claim.scenes,
    });
    if (materialized.kind === "INTEGRITY_MISMATCH") {
      // The canonical object is first-wins and the plan's receipt is immutable,
      // so the next attempt would compare the same bytes against the same
      // digest. Retrying it is a loop, not recovery.
      return this.#block(claim, "SOURCE_INTEGRITY_MISMATCH");
    }
    if (materialized.kind !== "MATERIALIZED") {
      return this.#defer(claim, "SOURCE_READ_RETRYABLE");
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
      if (published.kind === "OUTPUT_TOO_LARGE") {
        // The plan and the profile are immutable, so the same inputs encode to
        // the same size on every attempt. Only a different limit or a different
        // plan changes the answer, and neither happens by waiting.
        return this.#block(claim, "OUTPUT_SIZE_LIMIT_EXCEEDED");
      }
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

  async #block(
    claim: DeliverableCompositionClaim,
    blockCode: DeliverableCompositionBlockCode,
  ): Promise<"BLOCKED" | "LEASE_LOST"> {
    const outcome = await this.#deps.repository.blockComposition({
      claim,
      blockCode,
      blockedAt: this.#deps.clock(),
      context: this.#deps.context(claim.organizationId),
    });
    // A replayed block is still a block: the row already carries this exact
    // code, and reporting it as a lost lease would misdescribe a settled row.
    return outcome.kind === "LEASE_LOST" ? "LEASE_LOST" : "BLOCKED";
  }
}

/**
 * The refusals decidable from the claim alone, in a fixed order.
 *
 * Fixed rather than incidental: a plan that violates both invariants must block
 * with the same code on every worker and every attempt, or the durable record
 * would depend on which check happened to run first.
 */
function deterministicRefusal(
  claim: DeliverableCompositionClaim,
): DeliverableCompositionBlockCode | null {
  let totalBytes = 0;
  let totalSeconds = 0;
  for (const scene of claim.scenes) {
    totalBytes += scene.sourceSizeBytes;
    totalSeconds += scene.durationSeconds;
  }
  if (totalBytes > MAX_DELIVERABLE_COMPOSITION_SOURCE_BYTES) {
    return "SOURCE_BYTES_LIMIT_EXCEEDED";
  }
  // The composed video must be the length the customer was admitted for. There
  // is deliberately no redistribution rule: stretching or trimming scenes to
  // reach the admitted length would silently change what was agreed, and the
  // honest answer to a mismatch is to stop.
  if (totalSeconds !== claim.requestedDurationSeconds) {
    return "DURATION_INVARIANT_MISMATCH";
  }
  return null;
}
