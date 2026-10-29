/**
 * The dormant composition plan runner (ADR-0104).
 *
 * Finds the `SCENES_READY` jobs Transaction I would plan, and calls it once per
 * job. Nothing else: no provider, no storage, no `ffmpeg`, no money. A job it
 * plans leaves `SCENES_READY`, so it is not offered again, and a second call for
 * one answers `ALREADY_PLANNED` without writing.
 *
 * An admission that throws is that job's `FAILED` outcome and the pass goes on,
 * as in the other sweeps (ADR-0083 Decision 1): one bad row never stops the
 * others.
 *
 * ## Dormant
 *
 * Nothing in production constructs this runner, schedules it or calls it. The
 * development pipeline command of the approved plan (GS-9) is what will run it,
 * on the test provider only.
 */

import type { TransitionContext } from "../orchestration/ports";
import {
  DeliverableCompositionDefect,
  validateCompositionPlanBatchLimit,
  type AdmitCompositionPlanOutcome,
  type DeliverableCompositionDefectCode,
} from "./plan";
import type { DeliverableCompositionPlanRepository } from "./ports";

export type CompositionPlanRunOutcome =
  | AdmitCompositionPlanOutcome
  /**
   * The admission threw and wrote nothing. The code is kept when it was this
   * module's defect, and nothing else about the error is.
   */
  | { readonly kind: "FAILED"; readonly code: DeliverableCompositionDefectCode | null };

export interface CompositionPlanReport {
  readonly planned: number;
  readonly failed: number;
  readonly outcomes: readonly {
    readonly generationJobId: string;
    readonly outcome: CompositionPlanRunOutcome;
  }[];
}

export interface CompositionPlanIds {
  /** A fresh id for the version an admission would create. Never reused. */
  nextDeliverableVersionId(): string;
}

export interface CompositionPlanRunnerDeps {
  readonly repository: DeliverableCompositionPlanRepository;
  readonly ids: CompositionPlanIds;
  /** Built per admission so each carries its own correlation. */
  readonly context: () => TransitionContext;
}

export class CompositionPlanRunner {
  readonly #repository: DeliverableCompositionPlanRepository;
  readonly #ids: CompositionPlanIds;
  readonly #context: () => TransitionContext;

  constructor(deps: CompositionPlanRunnerDeps) {
    this.#repository = deps.repository;
    this.#ids = deps.ids;
    this.#context = deps.context;
  }

  /** One bounded pass. Each job is offered to Transaction I at most once. */
  async runOnce(limit: number): Promise<CompositionPlanReport> {
    const bounded = validateCompositionPlanBatchLimit(limit);
    const candidates = await this.#repository.findCompositionPlanCandidates({ limit: bounded });

    const outcomes: {
      generationJobId: string;
      outcome: CompositionPlanRunOutcome;
    }[] = [];
    let planned = 0;
    let failed = 0;
    const seen = new Set<string>();

    for (const candidate of candidates) {
      if (seen.has(candidate.generationJobId)) continue;
      seen.add(candidate.generationJobId);

      let outcome: CompositionPlanRunOutcome;
      try {
        outcome = await this.#repository.admitCompositionPlan({
          organizationId: candidate.organizationId,
          generationJobId: candidate.generationJobId,
          deliverableVersionId: this.#ids.nextDeliverableVersionId(),
          context: this.#context(),
        });
      } catch (error: unknown) {
        outcome = {
          kind: "FAILED",
          code: error instanceof DeliverableCompositionDefect ? error.code : null,
        };
      }
      if (outcome.kind === "PLANNED") planned += 1;
      if (outcome.kind === "FAILED") failed += 1;
      outcomes.push({ generationJobId: candidate.generationJobId, outcome });
    }

    return { planned, failed, outcomes };
  }
}
