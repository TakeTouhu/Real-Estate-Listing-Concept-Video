/**
 * The dormant failed job scene closure runner (ADR-0084).
 *
 * Finds the open scenes of failed jobs that nothing of is at the provider, and
 * closes each once. Nothing else: no provider, no storage, no money.
 *
 * A closure that throws is that candidate's `FAILED` outcome and the pass goes
 * on, as in the attempt failure settlement (ADR-0083 Decision 1): one bad row
 * never stops the others.
 *
 * ## Dormant
 *
 * Nothing in production constructs this runner, schedules it or calls it. The
 * development pipeline command of the approved plan (GS-9) is what will run it,
 * on the test provider only.
 */

import type { EpochMillis } from "../pricing/units";
import type { TransitionContext } from "../orchestration/ports";
import type { FailedJobSceneClosureOutcome, FailedJobSceneClosureRepository } from "./ports";
import {
  FailedJobSceneClosureDefect,
  type FailedJobSceneClosureDefectCode,
  validateFailedJobSceneClosureBatchLimit,
} from "./closure";

export type FailedJobSceneClosureRunOutcome =
  | FailedJobSceneClosureOutcome
  /**
   * The closure threw and wrote nothing. The code is kept when it was this
   * module's defect, and nothing else about the error is.
   */
  | { readonly kind: "FAILED"; readonly code: FailedJobSceneClosureDefectCode | null };

export interface FailedJobSceneClosureReport {
  readonly closed: number;
  readonly attemptsCancelled: number;
  readonly failed: number;
  readonly outcomes: readonly {
    readonly generationSceneId: string;
    readonly outcome: FailedJobSceneClosureRunOutcome;
  }[];
}

export interface FailedJobSceneClosureDeps {
  readonly repository: FailedJobSceneClosureRepository;
  readonly clock: () => EpochMillis;
  /** Built per closure so each carries its own correlation. */
  readonly context: () => TransitionContext;
}

export class FailedJobSceneClosureRunner {
  readonly #repository: FailedJobSceneClosureRepository;
  readonly #clock: () => EpochMillis;
  readonly #context: () => TransitionContext;

  constructor(deps: FailedJobSceneClosureDeps) {
    this.#repository = deps.repository;
    this.#clock = deps.clock;
    this.#context = deps.context;
  }

  /** One bounded pass. Each candidate is closed at most once and never retried. */
  async runOnce(limit: number): Promise<FailedJobSceneClosureReport> {
    const bounded = validateFailedJobSceneClosureBatchLimit(limit);
    const candidates = await this.#repository.findFailedJobSceneCandidates({ limit: bounded });

    const outcomes: {
      generationSceneId: string;
      outcome: FailedJobSceneClosureRunOutcome;
    }[] = [];
    let closed = 0;
    let attemptsCancelled = 0;
    let failed = 0;
    const seen = new Set<string>();

    for (const candidate of candidates) {
      if (seen.has(candidate.generationSceneId)) continue;
      seen.add(candidate.generationSceneId);

      let outcome: FailedJobSceneClosureRunOutcome;
      try {
        outcome = await this.#repository.closeFailedJobScene({
          organizationId: candidate.organizationId,
          generationSceneId: candidate.generationSceneId,
          closedAt: this.#clock(),
          context: this.#context(),
        });
      } catch (error: unknown) {
        outcome = {
          kind: "FAILED",
          code: error instanceof FailedJobSceneClosureDefect ? error.code : null,
        };
      }
      if (outcome.kind === "CLOSED") {
        closed += 1;
        attemptsCancelled += outcome.attemptsCancelled;
      }
      if (outcome.kind === "FAILED") failed += 1;
      outcomes.push({ generationSceneId: candidate.generationSceneId, outcome });
    }

    return { closed, attemptsCancelled, failed, outcomes };
  }
}
