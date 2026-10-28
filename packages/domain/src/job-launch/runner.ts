/**
 * The dormant job launch runner (GS-7b, ADR-0095).
 *
 * One pass finds, for each organization with a place that looks free, its
 * oldest waiting job; plans it (ADR-0094) outside every transaction; and hands
 * the plan to the launch commit, which re-decides everything under its own
 * locks and launches the job whole or not at all. One job per organization per
 * pass: the next pass sees the place the last one took.
 *
 * A job that cannot be planned is left waiting, its Units reserved, and the
 * code is reported; which codes release a job is GS-7d's to decide. A launch
 * that throws is that candidate's `FAILED` outcome and the pass goes on, as in
 * the other sweeps: one bad row never stops the others.
 *
 * Nothing is sent to a provider here. The attempts it admits wait `QUEUED` for
 * the paid-submission gate (GS-7c).
 *
 * ## Dormant
 *
 * Nothing in production constructs this runner, schedules it or calls it. The
 * development pipeline command of the approved plan (GS-9) is what will run it,
 * on the test provider only.
 */

import type { TransitionContext } from "../orchestration/ports";
import { JobLaunchDefect, type JobLaunchDefectCode, validateJobLaunchBatchLimit } from "./launch";
import type { JobLaunchPlanner } from "./planner";
import type {
  JobLaunchAttemptIds,
  JobLaunchFacts,
  JobLaunchNoPlanCode,
  JobLaunchRepository,
  LaunchJobOutcome,
} from "./ports";

export type JobLaunchRunOutcome =
  | LaunchJobOutcome
  /** The planner found no plan; nothing was committed and the job waits. */
  | { readonly kind: "NOT_PLANNED"; readonly code: JobLaunchNoPlanCode }
  /**
   * The plan or the commit threw and wrote nothing. The code is kept when it
   * was this module's defect, and nothing else about the error is.
   */
  | { readonly kind: "FAILED"; readonly code: JobLaunchDefectCode | null };

export interface JobLaunchReport {
  readonly launched: number;
  readonly failed: number;
  readonly outcomes: readonly {
    readonly organizationId: string;
    readonly generationJobId: string;
    readonly outcome: JobLaunchRunOutcome;
  }[];
}

export interface JobLaunchIds {
  nextAttemptId(): string;
  nextPricingSnapshotId(): string;
}

export interface JobLaunchRunnerDeps {
  readonly repository: JobLaunchRepository;
  /** The launch planner (ADR-0094), with the route policy the paid-submission gate uses. */
  readonly planner: Pick<JobLaunchPlanner, "plan">;
  readonly ids: JobLaunchIds;
  /** Built per launch so each carries its own correlation. */
  readonly context: () => TransitionContext;
}

export class JobLaunchRunner {
  readonly #repository: JobLaunchRepository;
  readonly #planner: Pick<JobLaunchPlanner, "plan">;
  readonly #ids: JobLaunchIds;
  readonly #context: () => TransitionContext;

  constructor(deps: JobLaunchRunnerDeps) {
    this.#repository = deps.repository;
    this.#planner = deps.planner;
    this.#ids = deps.ids;
    this.#context = deps.context;
  }

  /** One bounded pass. Each organization is offered at most one launch. */
  async runOnce(limit: number): Promise<JobLaunchReport> {
    const bounded = validateJobLaunchBatchLimit(limit);
    const candidates = await this.#repository.findJobLaunchCandidates({ limit: bounded });

    const outcomes: { organizationId: string; generationJobId: string; outcome: JobLaunchRunOutcome }[] = [];
    let launched = 0;
    let failed = 0;
    const seen = new Set<string>();

    for (const candidate of candidates) {
      if (seen.has(candidate.organizationId)) continue;
      seen.add(candidate.organizationId);

      let outcome: JobLaunchRunOutcome;
      try {
        outcome = await this.#launch(candidate.organizationId, candidate.generationJobId, candidate.facts);
      } catch (error: unknown) {
        outcome = { kind: "FAILED", code: error instanceof JobLaunchDefect ? error.code : null };
      }
      if (outcome.kind === "LAUNCHED") launched += 1;
      if (outcome.kind === "FAILED") failed += 1;
      outcomes.push({
        organizationId: candidate.organizationId,
        generationJobId: candidate.generationJobId,
        outcome,
      });
    }

    return { launched, failed, outcomes };
  }

  async #launch(
    organizationId: string,
    generationJobId: string,
    facts: JobLaunchFacts | null,
  ): Promise<JobLaunchRunOutcome> {
    if (facts === null) return { kind: "NOT_LAUNCHABLE", reason: "SHAPE_CONFLICT" };
    const plan = await this.#planner.plan(facts);
    if (plan.kind === "NO_PLAN") return { kind: "NOT_PLANNED", code: plan.code };
    const attemptIds: JobLaunchAttemptIds[] = plan.scenes.map(() => ({
      attemptId: this.#ids.nextAttemptId(),
      pricingSnapshotId: this.#ids.nextPricingSnapshotId(),
    }));
    return this.#repository.launchJob({
      organizationId,
      generationJobId,
      facts,
      plan,
      attemptIds,
      context: this.#context(),
    });
  }
}
