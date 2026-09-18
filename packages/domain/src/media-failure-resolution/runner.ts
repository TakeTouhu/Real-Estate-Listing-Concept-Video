/**
 * The dormant media-failure resolution coordinator.
 *
 * ## One authority, replacing Phase 6B's loop
 *
 * Phase 6B had its own runner: list recovery candidates oldest-first, plan each,
 * admit or report. That loop is **gone**, not wrapped — leaving it beside this
 * one would leave two things a future composition root could wire, and the one
 * it would most plausibly wire is the one without the durable deferral that
 * stops an unplannable prefix from starving every later failure.
 *
 * What survives from 6B is the *step*, not the loop: the same planner, the same
 * `admitAutomaticMediaRecovery` transaction, the same cap. This coordinator
 * decides when to invoke them.
 *
 * ## One pass
 *
 * ```text
 * claim -> classify -> (plan) -> admit / settle / defer / resolve
 * ```
 *
 * Planning runs strictly between the claim transaction and the admission
 * transaction, never inside either. That is the structural rule Phase 6B
 * established and this phase keeps: a pricing catalog and an FX source are
 * things that become network calls, and a transaction that spanned them would
 * hold row locks across one.
 *
 * ## Dormant
 *
 * Nothing in production constructs this, schedules it, or calls it. A terminal
 * media failure does not automatically retry or settle in production: this phase
 * builds and proves the capability, and turning it on is a separate reviewed
 * decision.
 */

import { AppError } from "@app/shared";
import type { TransitionContext } from "../orchestration/ports";
import {
  isRecoveryPlanRefusalCode,
  MEDIA_RECOVERY_PLANNING_FAILED_MESSAGE,
  type AutomaticMediaRecoveryOutcome,
  type RecoveryPlanRefusalCode,
} from "../media-recovery/policy";
import type {
  AutomaticMediaRecoveryPlan,
  AutomaticMediaRecoveryPlannerPort,
  AutomaticMediaRecoveryRepository,
} from "../media-recovery/ports";
import type { FxSnapshot, PricingSnapshot } from "../pricing/index";
import {
  MEDIA_FAILURE_RESOLUTION_RETRY_DELAY_MS,
  validateMediaFailureResolutionBatchLimit,
  validateMediaFailureResolutionLeaseMs,
  validateMediaFailureResolutionRetryDelayMs,
  type MediaFailureResolutionKind,
  type SettleExhaustedMediaFailureOutcome,
} from "./policy";
import type {
  MediaFailureResolutionClaim,
  MediaFailureResolutionRepository,
} from "./ports";

/** What one claimed item did, as a closed union a report can be read from. */
export type MediaFailureResolutionPassOutcome =
  | { readonly kind: "RECOVERY"; readonly outcome: AutomaticMediaRecoveryOutcome }
  | { readonly kind: "RECONCILED"; readonly recoveryAttemptId: string }
  | { readonly kind: "SETTLEMENT"; readonly outcome: SettleExhaustedMediaFailureOutcome }
  | { readonly kind: "DEFERRED"; readonly code: RecoveryPlanRefusalCode }
  | { readonly kind: "RESOLVED"; readonly resolutionKind: MediaFailureResolutionKind }
  /** Somebody else holds it, it is not due, or it stopped being eligible. */
  | { readonly kind: "SKIPPED" };

export interface MediaFailureResolutionReport {
  readonly claimed: number;
  readonly recovered: number;
  readonly settled: number;
  readonly deferred: number;
  readonly outcomes: readonly {
    readonly sourceValidationId: string;
    readonly result: MediaFailureResolutionPassOutcome;
  }[];
}

export interface MediaFailureResolutionIdFactory {
  /** A fresh opaque attempt id. Never derived from any existing identifier. */
  nextAttemptId(): string;
  nextPricingSnapshotId(): string;
  /** Opaque and random. Carries no tenant, attempt or key identity. */
  nextLeaseToken(): string;
}

export interface MediaFailureResolutionRunnerDeps {
  readonly work: MediaFailureResolutionRepository;
  readonly recovery: AutomaticMediaRecoveryRepository;
  readonly planner: AutomaticMediaRecoveryPlannerPort;
  readonly ids: MediaFailureResolutionIdFactory;
  /** Injected, so the pass instant is a decision rather than ambient time. */
  readonly clock: () => number;
  /** Built per item, so each transaction carries its own correlation. */
  readonly context: () => TransitionContext;
  readonly leaseMs?: number;
  readonly retryDelayMs?: number;
}

export class MediaFailureResolutionRunner {
  readonly #work: MediaFailureResolutionRepository;
  readonly #recovery: AutomaticMediaRecoveryRepository;
  readonly #planner: AutomaticMediaRecoveryPlannerPort;
  readonly #ids: MediaFailureResolutionIdFactory;
  readonly #clock: () => number;
  readonly #context: () => TransitionContext;
  readonly #leaseMs: number;
  readonly #retryDelayMs: number;

  constructor(deps: MediaFailureResolutionRunnerDeps) {
    this.#work = deps.work;
    this.#recovery = deps.recovery;
    this.#planner = deps.planner;
    this.#ids = deps.ids;
    this.#clock = deps.clock;
    this.#context = deps.context;
    this.#leaseMs = validateMediaFailureResolutionLeaseMs(
      deps.leaseMs ?? DEFAULT_LEASE_MS,
    );
    this.#retryDelayMs = validateMediaFailureResolutionRetryDelayMs(
      deps.retryDelayMs ?? MEDIA_FAILURE_RESOLUTION_RETRY_DELAY_MS,
    );
  }

  async runOnce(limit: number): Promise<MediaFailureResolutionReport> {
    const bounded = validateMediaFailureResolutionBatchLimit(limit);
    const now = this.#clock();
    const candidates = await this.#work.findResolutionCandidates({ now, limit: bounded });

    const outcomes: {
      sourceValidationId: string;
      result: MediaFailureResolutionPassOutcome;
    }[] = [];
    let claimed = 0;
    let recovered = 0;
    let settled = 0;
    let deferred = 0;
    const seen = new Set<string>();

    for (const candidate of candidates) {
      // Defensive: the query is unique by validation, and this makes a duplicated
      // row impossible to act on twice even if that ever changed.
      if (seen.has(candidate.sourceValidationId)) continue;
      seen.add(candidate.sourceValidationId);

      const at = this.#clock();
      const outcome = await this.#work.claim({
        sourceValidationId: candidate.sourceValidationId,
        now: at,
        leaseToken: this.#ids.nextLeaseToken(),
        leaseExpiresAt: at + this.#leaseMs,
      });

      if (outcome.kind !== "CLAIMED") {
        outcomes.push({
          sourceValidationId: candidate.sourceValidationId,
          result:
            outcome.kind === "ALREADY_RESOLVED"
              ? { kind: "RESOLVED", resolutionKind: outcome.resolutionKind }
              : { kind: "SKIPPED" },
        });
        continue;
      }

      claimed += 1;
      const result = await this.#act(outcome.claim);
      if (result.kind === "RECOVERY" && result.outcome.kind === "ADMITTED") recovered += 1;
      if (result.kind === "SETTLEMENT" && result.outcome.kind === "SETTLED") settled += 1;
      if (result.kind === "DEFERRED") deferred += 1;
      outcomes.push({ sourceValidationId: candidate.sourceValidationId, result });
    }

    return { claimed, recovered, settled, deferred, outcomes };
  }

  async #act(
    claim: MediaFailureResolutionClaim,
  ): Promise<MediaFailureResolutionPassOutcome> {
    const disposition = claim.disposition;

    if (disposition.kind === "OBSOLETE") {
      await this.#work.resolveObsolete({ claim, resolvedAt: this.#clock() });
      return { kind: "RESOLVED", resolutionKind: "OBSOLETE" };
    }

    if (disposition.kind === "RECONCILE_RECOVERY") {
      // The recovery exists. Whether this work's own previous claim created it
      // and died, or another worker did, makes no difference: bind to it, and
      // never create a second attempt or a second pricing snapshot.
      await this.#work.resolveRecoveryAdmitted({
        claim,
        recoveryAttemptId: disposition.recoveryAttemptId,
        resolvedAt: this.#clock(),
      });
      return { kind: "RECONCILED", recoveryAttemptId: disposition.recoveryAttemptId };
    }

    if (disposition.kind === "SETTLE_EXHAUSTED") {
      const outcome = await this.#work.settleExhaustedMediaFailure({
        claim,
        settledAt: this.#clock(),
        context: this.#context(),
      });
      // Transaction H resolves the work row in its own commit when it settles.
      // Anything else leaves the claim held, so hand it back rather than burning
      // a lease period doing nothing.
      if (outcome.kind === "NOT_EXHAUSTED" || outcome.kind === "NOT_FOUND") {
        await this.#work.release({ claim, nextAttemptAt: this.#clock() + this.#retryDelayMs });
      }
      return { kind: "SETTLEMENT", outcome };
    }

    // ---- Plan, outside every transaction. --------------------------------
    //
    // A planner that throws, or returns something that is not a plan, is a
    // defect in this application's own catalogs. Both normalize to the *same*
    // fixed error carrying no external text: a planner touches a pricing
    // catalog, a model catalog and an FX source, and an exception from any of
    // them can carry a credential, a vendor URL or a raw response body.
    //
    // The claim is released first so a planning defect costs a retry delay
    // rather than a whole lease period.
    let raw: unknown;
    try {
      raw = await this.#planner.plan(disposition.candidate);
    } catch {
      await this.#releaseQuietly(claim);
      throw planningFailed();
    }
    let plan: AutomaticMediaRecoveryPlan;
    try {
      plan = parsePlan(raw);
    } catch {
      await this.#releaseQuietly(claim);
      throw planningFailed();
    }

    if (plan.kind === "NO_PLAN") {
      // Not a verdict about the customer. An FX source can be unreachable and a
      // rate card can be mid-replacement; terminalizing a job for either would
      // charge the platform's outage to the customer.
      await this.#work.defer({
        claim,
        refusalCode: plan.code,
        nextAttemptAt: this.#clock() + this.#retryDelayMs,
      });
      return { kind: "DEFERRED", code: plan.code };
    }

    const outcome = await this.#recovery.admitAutomaticMediaRecovery({
      organizationId: claim.organizationId,
      sourceAttemptId: claim.sourceAttemptId,
      sourceValidationId: claim.sourceValidationId,
      attemptId: this.#ids.nextAttemptId(),
      pricingSnapshotId: this.#ids.nextPricingSnapshotId(),
      pricingSnapshot: plan.pricingSnapshot,
      fxSnapshot: plan.fxSnapshot,
      context: this.#context(),
    });

    if (outcome.kind === "ADMITTED") {
      await this.#work.resolveRecoveryAdmitted({
        claim,
        recoveryAttemptId: outcome.attemptId,
        resolvedAt: this.#clock(),
      });
    } else {
      // The admission transaction declined under its own locks — the authority
      // this work's claim could not hold. Hand the claim back and let the next
      // pass re-classify against whatever is true then.
      await this.#work.release({ claim, nextAttemptAt: this.#clock() + this.#retryDelayMs });
    }
    return { kind: "RECOVERY", outcome };
  }

  /**
   * Best-effort release on the failure path.
   *
   * A release that itself fails must not replace the fixed planning error with
   * whatever the database said — that would reopen exactly the leak the fixed
   * error exists to close. The lease expiry is the backstop.
   */
  async #releaseQuietly(claim: MediaFailureResolutionClaim): Promise<void> {
    try {
      await this.#work.release({ claim, nextAttemptAt: this.#clock() + this.#retryDelayMs });
    } catch {
      // Intentionally swallowed. See above.
    }
  }
}

const DEFAULT_LEASE_MS = 5 * 60 * 1000;

/** The one error a planning failure ever produces. No cause, no details. */
function planningFailed(): AppError {
  return new AppError("INTERNAL_ERROR", MEDIA_RECOVERY_PLANNING_FAILED_MESSAGE);
}

/**
 * Read a planner result as a plan, or refuse.
 *
 * A structural type is a promise about a compiled call site, not about the value
 * that actually arrives. Without this, a planner returning `undefined`,
 * `{ kind: "PLANNED" }` with no snapshot, or `{ kind: "NO_PLAN", code: <raw
 * vendor string> }` would surface later as a `TypeError` whose message quotes
 * whatever the planner was holding.
 */
function parsePlan(value: unknown): AutomaticMediaRecoveryPlan {
  if (typeof value !== "object" || value === null) throw planningFailed();
  const record = value as Record<string, unknown>;

  if (record.kind === "NO_PLAN") {
    if (!isRecoveryPlanRefusalCode(record.code)) throw planningFailed();
    return { kind: "NO_PLAN", code: record.code };
  }

  if (record.kind === "PLANNED") {
    const pricingSnapshot = record.pricingSnapshot;
    const fxSnapshot = record.fxSnapshot;
    if (typeof pricingSnapshot !== "object" || pricingSnapshot === null) throw planningFailed();
    if (typeof fxSnapshot !== "object" || fxSnapshot === null) throw planningFailed();
    return {
      kind: "PLANNED",
      pricingSnapshot: pricingSnapshot as PricingSnapshot,
      fxSnapshot: fxSnapshot as FxSnapshot,
    };
  }

  throw planningFailed();
}
