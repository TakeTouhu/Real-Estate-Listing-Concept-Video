/**
 * The validated-Scene-delivery ports.
 *
 * ## Candidate discovery is a hint; delivery is the authority
 *
 * `findValidatedDeliveryCandidates` returns identifiers and nothing else.
 * Everything needed to *decide* is deliberately absent, so a caller cannot
 * mistake the listing for permission: between the listing and the call the
 * verdict may be superseded by a newer attempt, the Scene may have moved, or
 * another worker may have delivered it. `deliverValidatedScene` re-reads and
 * re-checks every condition under its own locks.
 *
 * ## One operation, not three
 *
 * There is deliberately no `markRequestDelivered`, `markSceneReady` or
 * `maybeMarkJobReady`. Three calls are three crash boundaries, and the states
 * they would leave behind — a delivered request whose Scene never became ready,
 * a ready Scene pointing at an undelivered request — are exactly what
 * Transaction F exists to make impossible. The single method owns the locks,
 * the authority re-reads, every write and every event.
 */

import type { TransitionContext } from "../orchestration/ports";
import type { ValidatedSceneDeliveryOutcome } from "./delivery";

/**
 * A candidate is identifiers only.
 *
 * The validation id is what the batch de-duplicates on, and the request id is
 * what the delivery call addresses. Neither is authority.
 */
export interface ValidatedSceneDeliveryCandidate {
  readonly validationId: string;
  readonly sceneGenerationId: string;
  readonly generationSceneRequestId: string;
  readonly organizationId: string;
}

export interface ValidatedSceneDeliveryQuery {
  readonly limit: number;
}

export interface DeliverValidatedSceneInput {
  /**
   * The tenant the caller believes owns this work. Never trusted on its own:
   * the transaction proves ownership through the
   * Scene → Job → VideoProject → organization chain in the same locked
   * statement, so a mismatched id locks nothing and finds nothing.
   */
  readonly organizationId: string;
  /** The attempt whose durable media verdict is being consumed. */
  readonly sceneGenerationId: string;
  readonly context: TransitionContext;
}

export interface ValidatedSceneDeliveryRepository {
  /** Bounded, deterministic, one row per validation. A hint only. */
  findValidatedDeliveryCandidates(
    query: ValidatedSceneDeliveryQuery,
  ): Promise<readonly ValidatedSceneDeliveryCandidate[]>;

  /**
   * Transaction F, in one short database transaction.
   *
   * No external I/O is reachable from inside it: this performs database work
   * only, and the durable `VALID` verdict is the media authority.
   */
  deliverValidatedScene(
    input: DeliverValidatedSceneInput,
  ): Promise<ValidatedSceneDeliveryOutcome>;
}
