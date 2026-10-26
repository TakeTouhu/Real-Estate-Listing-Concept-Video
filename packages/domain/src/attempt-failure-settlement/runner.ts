/**
 * The dormant attempt failure settlement runner (ADR-0083).
 *
 * Finds requests whose attempts all ended and whose newest produced no video,
 * and settles each once. Nothing else: no provider, no storage, no retry.
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
import { validateAttemptFailureSettlementBatchLimit } from "./settlement";

export interface AttemptFailureSettlementReport {
  readonly settled: number;
  readonly unitsReleased: number;
  readonly outcomes: readonly {
    readonly generationSceneRequestId: string;
    readonly outcome: AttemptFailureSettlementOutcome;
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
   * not to be settleable is reported, not retried.
   */
  async runOnce(limit: number): Promise<AttemptFailureSettlementReport> {
    const bounded = validateAttemptFailureSettlementBatchLimit(limit);
    const candidates = await this.#repository.findAttemptFailureCandidates({ limit: bounded });

    const outcomes: {
      generationSceneRequestId: string;
      outcome: AttemptFailureSettlementOutcome;
    }[] = [];
    let settled = 0;
    let unitsReleased = 0;
    const seen = new Set<string>();

    for (const candidate of candidates) {
      if (seen.has(candidate.generationSceneRequestId)) continue;
      seen.add(candidate.generationSceneRequestId);

      const outcome = await this.#repository.settleAttemptFailure({
        organizationId: candidate.organizationId,
        generationSceneRequestId: candidate.generationSceneRequestId,
        settledAt: this.#clock(),
        context: this.#context(),
      });
      if (outcome.kind === "SETTLED") {
        settled += 1;
        if (outcome.unitReleased) unitsReleased += 1;
      }
      outcomes.push({ generationSceneRequestId: candidate.generationSceneRequestId, outcome });
    }

    return { settled, unitsReleased, outcomes };
  }
}
