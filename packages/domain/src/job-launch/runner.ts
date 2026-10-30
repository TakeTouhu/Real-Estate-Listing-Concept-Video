/**
 * The dormant job launch runner (GS-7b, ADR-0095).
 *
 * One pass finds, for each organization with a place that looks free, its
 * oldest waiting job; plans it (ADR-0094) outside every transaction; and hands
 * the plan to the launch commit, which re-decides everything under its own
 * locks and launches the job whole or not at all. One job per organization per
 * pass: the next pass sees the place the last one took.
 *
 * A job that can never launch is ended and its Units released (GS-7d-1,
 * ADR-0099): first, each waiting job of a deleted Property, which is never a
 * candidate; then a candidate whose own rows stop it, as its planner's code
 * for a frozen fact or the commit's refusal says. A deleted Property's launched
 * job not yet being assembled is ended too (GS-7d-3a, ADR-0102), before the
 * launches, so the place it frees can be taken in the same pass. A job the
 * planner refuses for a catalog, a price or a rate is left waiting, its Units
 * reserved, and the code is reported. A launch or an ending that throws is that
 * job's `FAILED` outcome and the pass goes on, as in the other sweeps: one bad
 * row never stops the others.
 *
 * The launches read one window of organizations after the caller's cursor and
 * return where the next should start (ADR-0105), so organizations whose oldest
 * job waits for a configuration do not hold the window for every pass after
 * them.
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
import { epochMillis } from "../pricing/units";
import type { UnlaunchableJobCause, UnlaunchableJobEndingRefusal } from "./ending";
import type { LaunchedJobEndingRefusal } from "./launched-ending";
import {
  JobLaunchDefect,
  type JobLaunchDefectCode,
  validateJobLaunchBatchLimit,
  validateJobLaunchCursor,
} from "./launch";
import { isFrozenFactsCode, type JobLaunchPlanner } from "./planner";
import type {
  EndUnlaunchableJobInput,
  JobLaunchAttemptIds,
  JobLaunchCursor,
  JobLaunchFacts,
  JobLaunchNoPlanCode,
  JobLaunchRepository,
  LaunchJobOutcome,
  LaunchedJobEndingRepository,
  UnlaunchableJobEndingRepository,
} from "./ports";

export type JobLaunchRunOutcome =
  | LaunchJobOutcome
  /** The planner found no plan for a reason that can pass; nothing was committed and the job waits. */
  | { readonly kind: "NOT_PLANNED"; readonly code: JobLaunchNoPlanCode }
  /** The job could never launch, or its Property was deleted: it failed and its Units were released. */
  | { readonly kind: "ENDED"; readonly cause: UnlaunchableJobCause }
  /** It looked as if it should end, but the ending refused under its locks and wrote nothing. */
  | { readonly kind: "NOT_ENDED"; readonly reason: UnlaunchableJobEndingRefusal | LaunchedJobEndingRefusal }
  /**
   * The plan or the commit threw and wrote nothing. The code is kept when it
   * was this module's defect, and nothing else about the error is.
   */
  | { readonly kind: "FAILED"; readonly code: JobLaunchDefectCode | null };

export interface JobLaunchReport {
  readonly launched: number;
  readonly ended: number;
  readonly failed: number;
  readonly outcomes: readonly {
    readonly organizationId: string;
    readonly generationJobId: string;
    readonly outcome: JobLaunchRunOutcome;
  }[];
  /**
   * Where the next pass's launches start: after the last organization read,
   * when the window was full; `null`, from the oldest, when it reached the end.
   */
  readonly next: JobLaunchCursor | null;
}

export interface JobLaunchIds {
  nextAttemptId(): string;
  nextPricingSnapshotId(): string;
}

export interface JobLaunchRunnerDeps {
  readonly repository: JobLaunchRepository;
  /** The ending of a job that can never launch (ADR-0099). */
  readonly ending: UnlaunchableJobEndingRepository;
  /** The ending of a deleted Property's launched job not yet being assembled (ADR-0102). */
  readonly launchedEnding: LaunchedJobEndingRepository;
  /** The launch planner (ADR-0094), with the route policy the paid-submission gate uses. */
  readonly planner: Pick<JobLaunchPlanner, "plan">;
  readonly ids: JobLaunchIds;
  /** Built per launch so each carries its own correlation. */
  readonly context: () => TransitionContext;
  /** The instant an ending releases a reservation at. */
  readonly clock: () => number;
}

export class JobLaunchRunner {
  readonly #repository: JobLaunchRepository;
  readonly #ending: UnlaunchableJobEndingRepository;
  readonly #launchedEnding: LaunchedJobEndingRepository;
  readonly #planner: Pick<JobLaunchPlanner, "plan">;
  readonly #ids: JobLaunchIds;
  readonly #context: () => TransitionContext;
  readonly #clock: () => number;

  constructor(deps: JobLaunchRunnerDeps) {
    this.#repository = deps.repository;
    this.#ending = deps.ending;
    this.#launchedEnding = deps.launchedEnding;
    this.#planner = deps.planner;
    this.#ids = deps.ids;
    this.#context = deps.context;
    this.#clock = deps.clock;
  }

  /**
   * One bounded pass: up to `limit` waiting jobs of deleted Properties are
   * ended, then up to `limit` of their launched jobs not yet being assembled,
   * then each organization in the window after `after` is offered at most one
   * launch.
   */
  async runOnce(limit: number, after: JobLaunchCursor | null = null): Promise<JobLaunchReport> {
    const bounded = validateJobLaunchBatchLimit(limit);
    const start = validateJobLaunchCursor(after);
    const outcomes: { organizationId: string; generationJobId: string; outcome: JobLaunchRunOutcome }[] = [];
    const settle = async (
      organizationId: string,
      generationJobId: string,
      run: () => Promise<JobLaunchRunOutcome>,
    ): Promise<void> => {
      let outcome: JobLaunchRunOutcome;
      try {
        outcome = await run();
      } catch (error: unknown) {
        outcome = { kind: "FAILED", code: error instanceof JobLaunchDefect ? error.code : null };
      }
      outcomes.push({ organizationId, generationJobId, outcome });
    };

    const deleted = await this.#ending.findPropertyDeletedWaitingJobs({ limit: bounded });
    for (const job of deleted) {
      await settle(job.organizationId, job.generationJobId, () => this.#end(job.organizationId, job.generationJobId));
    }

    const launched = await this.#launchedEnding.findPropertyDeletedLaunchedJobs({ limit: bounded });
    for (const job of launched) {
      await settle(job.organizationId, job.generationJobId, () =>
        this.#launchedEnding.endPropertyDeletedLaunchedJob(this.#endInput(job.organizationId, job.generationJobId)),
      );
    }

    const candidates = await this.#repository.findJobLaunchCandidates({ limit: bounded, after: start });
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (seen.has(candidate.organizationId)) continue;
      seen.add(candidate.organizationId);
      await settle(candidate.organizationId, candidate.generationJobId, () =>
        this.#launch(candidate.organizationId, candidate.generationJobId, candidate.facts),
      );
    }

    const count = (kind: JobLaunchRunOutcome["kind"]): number =>
      outcomes.filter((entry) => entry.outcome.kind === kind).length;
    const last = candidates.length === bounded ? candidates.at(-1) : undefined;
    const next = last === undefined ? null : { createdAt: last.createdAt, generationJobId: last.generationJobId };
    return { launched: count("LAUNCHED"), ended: count("ENDED"), failed: count("FAILED"), outcomes, next };
  }

  async #launch(
    organizationId: string,
    generationJobId: string,
    facts: JobLaunchFacts | null,
  ): Promise<JobLaunchRunOutcome> {
    // Facts are not read for a job not of the start's shape, which the commit
    // would refuse as `SHAPE_CONFLICT`: the ending decides it from its own rows.
    if (facts === null) return this.#end(organizationId, generationJobId);
    const plan = await this.#planner.plan(facts);
    if (plan.kind === "NO_PLAN") {
      return isFrozenFactsCode(plan.code)
        ? this.#end(organizationId, generationJobId)
        : { kind: "NOT_PLANNED", code: plan.code };
    }
    const attemptIds: JobLaunchAttemptIds[] = plan.scenes.map(() => ({
      attemptId: this.#ids.nextAttemptId(),
      pricingSnapshotId: this.#ids.nextPricingSnapshotId(),
    }));
    const outcome = await this.#repository.launchJob({
      organizationId,
      generationJobId,
      facts,
      plan,
      attemptIds,
      context: this.#context(),
    });
    // A Property deleted since the candidates were read, or rows another
    // writer touched: neither is ever launched.
    if (
      outcome.kind === "NOT_LAUNCHABLE" &&
      (outcome.reason === "PROPERTY_DELETED" || outcome.reason === "SHAPE_CONFLICT")
    ) {
      return this.#end(organizationId, generationJobId);
    }
    return outcome;
  }

  async #end(organizationId: string, generationJobId: string): Promise<JobLaunchRunOutcome> {
    return this.#ending.endUnlaunchableJob(this.#endInput(organizationId, generationJobId));
  }

  #endInput(organizationId: string, generationJobId: string): EndUnlaunchableJobInput {
    return { organizationId, generationJobId, endedAt: epochMillis(this.#clock()), context: this.#context() };
  }
}
