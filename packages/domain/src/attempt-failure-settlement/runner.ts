/**
 * The dormant attempt failure settlement runner (ADR-0083).
 *
 * Finds requests whose attempts all ended and whose newest produced no video,
 * and settles each once. Nothing else: no provider, no storage, no retry.
 *
 * ## One bad candidate never stops the pass
 *
 * Candidates come oldest first, so a request whose settlement throws every
 * time would otherwise stop every later one, and with it every later release of
 * a customer's Unit. Each settlement is isolated: a throw is that candidate's
 * `FAILED` outcome and the pass goes on, as the composition and validation
 * sweeps do (ADR-0050, ADR-0080).
 *
 * ## Dormant
 *
 * Nothing in production constructs this runner, schedules it or calls it. The
 * development pipeline command of the approved plan (GS-9) is what will run it,
 * on the test provider only.
 */

import type { EpochMillis } from "../pricing/units";
import type { TransitionContext } from "../orchestration/ports";
import type {
  AttemptFailureSettlementOutcome,
  AttemptFailureSettlementRepository,
} from "./ports";
import {
  AttemptFailureSettlementDefect,
  type AttemptFailureSettlementDefectCode,
  validateAttemptFailureSettlementBatchLimit,
} from "./settlement";

export type AttemptFailureSettlementRunOutcome =
  | AttemptFailureSettlementOutcome
  /**
   * The settlement threw and wrote nothing. The code is kept when it was this
   * module's defect, and nothing else about the error is: a database error's
   * text is not this report's to carry.
   */
  | { readonly kind: "FAILED"; readonly code: AttemptFailureSettlementDefectCode | null };

export interface AttemptFailureSettlementReport {
  readonly settled: number;
  readonly unitsReleased: number;
  readonly failed: number;
  readonly outcomes: readonly {
    readonly generationSceneRequestId: string;
    readonly outcome: AttemptFailureSettlementRunOutcome;
  }[];
}

export interface AttemptFailureSettlementDeps {
  readonly repository: AttemptFailureSettlementRepository;
  readonly clock: () => EpochMillis;
  /** Built per settlement so each carries its own correlation. */
  readonly context: () => TransitionContext;
}

export class AttemptFailureSettlementRunner {
  readonly #repository: AttemptFailureSettlementRepository;
  readonly #clock: () => EpochMillis;
  readonly #context: () => TransitionContext;

  constructor(deps: AttemptFailureSettlementDeps) {
    this.#repository = deps.repository;
    this.#clock = deps.clock;
    this.#context = deps.context;
  }

  /**
   * One bounded pass. Each candidate is settled at most once; one that turns out
   * not to be settleable, or whose settlement throws, is reported, not retried.
   */
  async runOnce(limit: number): Promise<AttemptFailureSettlementReport> {
    const bounded = validateAttemptFailureSettlementBatchLimit(limit);
    const candidates = await this.#repository.findAttemptFailureCandidates({ limit: bounded });

    const outcomes: {
      generationSceneRequestId: string;
      outcome: AttemptFailureSettlementRunOutcome;
    }[] = [];
    let settled = 0;
    let unitsReleased = 0;
    let failed = 0;
    const seen = new Set<string>();

    for (const candidate of candidates) {
      if (seen.has(candidate.generationSceneRequestId)) continue;
      seen.add(candidate.generationSceneRequestId);

      let outcome: AttemptFailureSettlementRunOutcome;
      try {
        outcome = await this.#repository.settleAttemptFailure({
          organizationId: candidate.organizationId,
          generationSceneRequestId: candidate.generationSceneRequestId,
          settledAt: this.#clock(),
          context: this.#context(),
        });
      } catch (error: unknown) {
        outcome = {
          kind: "FAILED",
          code: error instanceof AttemptFailureSettlementDefect ? error.code : null,
        };
      }
      if (outcome.kind === "SETTLED") {
        settled += 1;
        if (outcome.unitReleased) unitsReleased += 1;
      }
      if (outcome.kind === "FAILED") failed += 1;
      outcomes.push({ generationSceneRequestId: candidate.generationSceneRequestId, outcome });
    }

    return { settled, unitsReleased, failed, outcomes };
  }
}
