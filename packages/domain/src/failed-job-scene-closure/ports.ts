/**
 * The failed job scene closure ports (ADR-0084).
 *
 * Discovery is a hint and the closure is the authority, as for Transaction K:
 * `findFailedJobSceneCandidates` returns identifiers only, and
 * `closeFailedJobScene` re-reads and re-decides everything under its own
 * locks. There is no work row and no lease.
 */

import type { TransitionContext } from "../orchestration/ports";
import type { FailedJobSceneRefusal } from "./closure";

/** Identifiers only. Nothing here is a decision. */
export interface FailedJobSceneCandidate {
  readonly organizationId: string;
  readonly generationSceneId: string;
}

export interface FailedJobSceneCandidateQuery {
  readonly limit: number;
}

export interface CloseFailedJobSceneInput {
  /**
   * The tenant the caller believes owns the scene. Never trusted on its own:
   * ownership is proved through Job → VideoProject in the statement that locks
   * the scene, so a mismatched id locks nothing and finds nothing.
   */
  readonly organizationId: string;
  readonly generationSceneId: string;
  /** The instant a failed request records as its `failedAt`. */
  readonly closedAt: number;
  readonly context: TransitionContext;
}

export type FailedJobSceneClosureOutcome =
  | {
      readonly kind: "CLOSED";
      readonly scene: "CANCELLED" | "FAILED_TERMINAL";
      /** Attempts this commit cancelled before they were sent. */
      readonly attemptsCancelled: number;
    }
  | { readonly kind: "NOT_CLOSABLE"; readonly reason: FailedJobSceneRefusal }
  /** No such scene visible to this organization. */
  | { readonly kind: "NOT_FOUND" };

export interface FailedJobSceneClosureRepository {
  /** Bounded, deterministic, one row per scene. A hint only. */
  findFailedJobSceneCandidates(
    query: FailedJobSceneCandidateQuery,
  ): Promise<readonly FailedJobSceneCandidate[]>;

  /** The closure, in one short database transaction with no external I/O. */
  closeFailedJobScene(input: CloseFailedJobSceneInput): Promise<FailedJobSceneClosureOutcome>;
}
