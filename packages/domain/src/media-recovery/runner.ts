/**
 * The dormant automatic media-failure recovery runner.
 *
 * One bounded pass: list candidates, plan each one *outside* any transaction,
 * and hand the finished plan to recovery admission. That order is the whole
 * design — see `planner.ts` for why pricing and FX must not run inside an open
 * database transaction.
 *
 * ## Dormant
 *
 * Nothing in production constructs this runner, schedules it, or calls it. A
 * terminal media failure does **not** automatically retry in production yet:
 * this phase builds and proves the bounded capability, and turning it on is a
 * separate reviewed decision that also requires Phase 6C's exhaustion and
 * failure-settlement semantics.
 */

import { AppError } from "@app/shared";
import type { TransitionContext } from "../orchestration/ports";
import { validateMediaRecoveryBatchLimit, type AutomaticMediaRecoveryOutcome } from "./policy";
import type {
  AutomaticMediaRecoveryPlannerPort,
  AutomaticMediaRecoveryRepository,
  RecoveryPlanRefusalCode,
} from "./ports";

/** What one candidate did, as a closed union the report can be read from. */
export type MediaRecoveryPassOutcome =
  | { readonly kind: "OUTCOME"; readonly outcome: AutomaticMediaRecoveryOutcome }
  | { readonly kind: "NO_PLAN"; readonly code: RecoveryPlanRefusalCode };

export interface MediaRecoveryReport {
  readonly admitted: number;
  readonly noPlan: number;
  readonly outcomes: readonly {
    readonly sourceAttemptId: string;
    readonly result: MediaRecoveryPassOutcome;
  }[];
}

export interface MediaRecoveryIdFactory {
  /** A fresh opaque attempt id. Never derived from any existing identifier. */
  nextAttemptId(): string;
  nextPricingSnapshotId(): string;
}

export interface AutomaticMediaFailureRecoveryDeps {
  readonly repository: AutomaticMediaRecoveryRepository;
  readonly planner: AutomaticMediaRecoveryPlannerPort;
  readonly ids: MediaRecoveryIdFactory;
  /** Built per candidate, so each admission carries its own correlation. */
  readonly context: () => TransitionContext;
}

export class AutomaticMediaFailureRecoveryRunner {
  readonly #repository: AutomaticMediaRecoveryRepository;
  readonly #planner: AutomaticMediaRecoveryPlannerPort;
  readonly #ids: MediaRecoveryIdFactory;
  readonly #context: () => TransitionContext;

  constructor(deps: AutomaticMediaFailureRecoveryDeps) {
    this.#repository = deps.repository;
    this.#planner = deps.planner;
    this.#ids = deps.ids;
    this.#context = deps.context;
  }

  /**
   * One bounded pass.
   *
   * Each candidate is acted on at most once: the listing is unique by source
   * validation, and nothing re-queues within a pass. A candidate that cannot be
   * planned is reported, not retried here — retrying a planning refusal in a
   * tight loop is how an unsafe route becomes a busy loop.
   */
  async runOnce(limit: number): Promise<MediaRecoveryReport> {
    const bounded = validateMediaRecoveryBatchLimit(limit);
    const candidates = await this.#repository.findAutomaticMediaRecoveryCandidates({
      limit: bounded,
    });

    const outcomes: { sourceAttemptId: string; result: MediaRecoveryPassOutcome }[] = [];
    let admitted = 0;
    let noPlan = 0;
    const seen = new Set<string>();

    for (const candidate of candidates) {
      // Defensive: the query is unique by source validation, and this makes a
      // duplicated row impossible to act on twice even if that ever changed.
      if (seen.has(candidate.sourceValidationId)) continue;
      seen.add(candidate.sourceValidationId);

      // Planning finishes completely before admission opens a transaction.
      // A planner that throws is a defect in this application's own catalogs,
      // not an expected outcome, so it is converted to a fixed internal error
      // carrying no external text rather than being reported as "no plan".
      let plan;
      try {
        plan = await this.#planner.plan(candidate);
      } catch (cause) {
        throw new AppError("INTERNAL_ERROR", "Automatic media recovery planning failed", {
          cause,
        });
      }

      if (plan.kind === "NO_PLAN") {
        noPlan += 1;
        outcomes.push({
          sourceAttemptId: candidate.sourceAttemptId,
          result: { kind: "NO_PLAN", code: plan.code },
        });
        continue;
      }

      const outcome = await this.#repository.admitAutomaticMediaRecovery({
        organizationId: candidate.organizationId,
        sourceAttemptId: candidate.sourceAttemptId,
        sourceValidationId: candidate.sourceValidationId,
        attemptId: this.#ids.nextAttemptId(),
        pricingSnapshotId: this.#ids.nextPricingSnapshotId(),
        pricingSnapshot: plan.pricingSnapshot,
        fxSnapshot: plan.fxSnapshot,
        context: this.#context(),
      });
      if (outcome.kind === "ADMITTED") admitted += 1;
      outcomes.push({
        sourceAttemptId: candidate.sourceAttemptId,
        result: { kind: "OUTCOME", outcome },
      });
    }

    return { admitted, noPlan, outcomes };
  }
}
