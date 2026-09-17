/**
 * The dormant validated-Scene-delivery runner.
 *
 * Finds candidates and calls Transaction F once per candidate. That is all it
 * does: there is no validator call, no S3 read, no `ffprobe`, no provider call
 * and no scheduler. The media question was already answered durably by Phase
 * 2H-3B-5, and this pass only turns a `VALID` verdict into the customer-visible
 * Scene state.
 *
 * ## Dormant
 *
 * Nothing in production constructs this runner, schedules it, or calls it. A
 * `VALID` verdict does **not** automatically deliver in production yet; this
 * phase builds and proves the atomic capability, and turning it on is a
 * separate reviewed decision with its own operational questions.
 */

import {
  validateSceneDeliveryBatchLimit,
  type ValidatedSceneDeliveryOutcome,
} from "./delivery";
import type { ValidatedSceneDeliveryRepository } from "./ports";
import type { TransitionContext } from "../orchestration/ports";

export interface ValidatedSceneDeliveryReport {
  readonly delivered: number;
  readonly jobsAdvanced: number;
  readonly outcomes: readonly {
    readonly sceneGenerationId: string;
    readonly outcome: ValidatedSceneDeliveryOutcome;
  }[];
}

export interface ValidatedSceneDeliveryDeps {
  readonly repository: ValidatedSceneDeliveryRepository;
  /** Built per attempt so each delivery carries its own correlation. */
  readonly context: () => TransitionContext;
}

export class ValidatedSceneDeliveryRunner {
  readonly #repository: ValidatedSceneDeliveryRepository;
  readonly #context: () => TransitionContext;

  constructor(deps: ValidatedSceneDeliveryDeps) {
    this.#repository = deps.repository;
    this.#context = deps.context;
  }

  /**
   * One bounded pass.
   *
   * Each candidate is attempted at most once: the listing is unique by
   * validation, and nothing re-queues within a pass. A candidate that turns out
   * to be ineligible — superseded by a newer attempt, already delivered, moved
   * on — is reported, not retried here.
   */
  async runOnce(limit: number): Promise<ValidatedSceneDeliveryReport> {
    const bounded = validateSceneDeliveryBatchLimit(limit);
    const candidates = await this.#repository.findValidatedDeliveryCandidates({
      limit: bounded,
    });

    const outcomes: {
      sceneGenerationId: string;
      outcome: ValidatedSceneDeliveryOutcome;
    }[] = [];
    let delivered = 0;
    let jobsAdvanced = 0;
    const seen = new Set<string>();

    for (const candidate of candidates) {
      // Defensive: the query is unique by validation, and this makes a
      // duplicated row impossible to act on twice even if that ever changed.
      if (seen.has(candidate.validationId)) continue;
      seen.add(candidate.validationId);

      const outcome = await this.#repository.deliverValidatedScene({
        organizationId: candidate.organizationId,
        sceneGenerationId: candidate.sceneGenerationId,
        context: this.#context(),
      });
      if (outcome.kind === "DELIVERED") {
        delivered += 1;
        if (outcome.jobAdvanced) jobsAdvanced += 1;
      }
      outcomes.push({ sceneGenerationId: candidate.sceneGenerationId, outcome });
    }

    return { delivered, jobsAdvanced, outcomes };
  }
}
