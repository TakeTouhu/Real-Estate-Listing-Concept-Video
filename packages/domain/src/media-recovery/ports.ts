/**
 * The automatic media-failure recovery boundary.
 *
 * Three ports, and the split between them is the point:
 *
 * - **discovery** returns planning candidates, and is only a hint;
 * - **planning** resolves a *fresh* pricing decision for the same route, and
 *   happens entirely outside any database transaction;
 * - **admission** re-checks every authority under its own locks and creates the
 *   attempt.
 *
 * No method accepts a callback. That is structural, not stylistic: a repository
 * that took a planner would let a pricing lookup, an FX acquisition or a
 * provider call run inside an open transaction, and the whole reason planning
 * is a separate step is that those are the things that become external I/O.
 */

import type { FxSnapshot, PricingSnapshot } from "../pricing/index";
import type { TransitionContext } from "../orchestration/ports";
import type { AutomaticMediaRecoveryOutcome, MediaFailureKind } from "./policy";

/**
 * The immutable execution route a recovery must reproduce exactly.
 *
 * Copied from the source attempt, never re-derived from today's defaults.
 * "Retry the same work once" is a different promise from "choose whatever the
 * catalog sells now", and only the first is safe to do without asking anyone.
 */
export interface RecoveryExecutionRoute {
  readonly providerName: string;
  readonly providerModelId: string;
  readonly requestModelKey: string;
  readonly requestNativeGenerationResolution: string;
  readonly requestResolutionNormalization: string;
  readonly requestNativeMeetsTarget: boolean;
}

/**
 * What planning needs, and deliberately nothing more.
 *
 * Note what is absent: the rendered prompt and the compiled prompt. Planning
 * does not need customer-authored text to price a retry, and a field that is
 * never populated cannot be logged, serialized into a report or leaked through
 * an error. The repository reads the source rendered prompt itself, inside the
 * admission transaction, and copies it directly.
 */
export interface AutomaticMediaRecoveryCandidate {
  readonly organizationId: string;
  readonly sourceValidationId: string;
  readonly sourceAttemptId: string;
  readonly generationSceneRequestId: string;
  readonly mediaFailureKind: MediaFailureKind;
  readonly route: RecoveryExecutionRoute;
  /** The Job's product target, for re-checking the route against today's catalog. */
  readonly targetOutputResolution: string;
  /** The Scene's frozen duration, which the fresh pricing decision is for. */
  readonly sceneDurationSeconds: number;
  readonly jobQualityTier: "NORMAL" | "HIGH_QUALITY";
  /** The persisted identity, still untrusted JSON at this point. */
  readonly persistedPricingIdentity: unknown;
  readonly persistedPricingContractFingerprint: string;
}

export interface AutomaticMediaRecoveryQuery {
  readonly limit: number;
}

/** Why a candidate could not be planned. Closed, application-owned, no external text. */
export type RecoveryPlanRefusalCode =
  /** The persisted pricing identity is not a complete, well-formed identity. */
  | "PERSISTED_PRICING_IDENTITY_MALFORMED"
  /** Today's model catalog no longer delivers this exact route. */
  | "NO_SAFE_CURRENT_ROUTE"
  /** No currently eligible contract, or no usable FX rate, for this route. */
  | "NO_SAFE_CURRENT_PRICING"
  /** More than one current contract matches this route; choosing one would be a guess. */
  | "AMBIGUOUS_CURRENT_PRICING";

export type AutomaticMediaRecoveryPlan =
  | {
      readonly kind: "PLANNED";
      /** A fresh decision at the planning instant. Never the historical numbers. */
      readonly pricingSnapshot: PricingSnapshot;
      readonly fxSnapshot: FxSnapshot;
    }
  | { readonly kind: "NO_PLAN"; readonly code: RecoveryPlanRefusalCode };

export interface AutomaticMediaRecoveryPlannerPort {
  plan(candidate: AutomaticMediaRecoveryCandidate): Promise<AutomaticMediaRecoveryPlan>;
}

/**
 * Where a fresh rate comes from.
 *
 * A port, so this phase can prove the planning path without a network
 * integration. Nothing production-wires a rate provider.
 */
export interface FxRateSource {
  /** The rate to price against at this instant, or `null` when none is usable. */
  current(): Promise<FxSnapshot | null>;
}

export interface AdmitAutomaticMediaRecoveryInput {
  readonly organizationId: string;
  readonly sourceAttemptId: string;
  readonly sourceValidationId: string;
  /** Opaque, freshly generated. Never derived from any existing identifier. */
  readonly attemptId: string;
  readonly pricingSnapshotId: string;
  readonly pricingSnapshot: PricingSnapshot;
  readonly fxSnapshot: FxSnapshot;
  readonly context: TransitionContext;
}

export interface AutomaticMediaRecoveryRepository {
  /** Bounded, deterministic, one row per source validation. A hint only. */
  findAutomaticMediaRecoveryCandidates(
    query: AutomaticMediaRecoveryQuery,
  ): Promise<readonly AutomaticMediaRecoveryCandidate[]>;

  /**
   * Admit one automatic recovery attempt, in one short database transaction.
   *
   * Takes a fully materialized pricing decision. It does not plan, does not
   * look a contract up, does not fetch a rate and does not call a provider —
   * planning finished before this was called.
   */
  admitAutomaticMediaRecovery(
    input: AdmitAutomaticMediaRecoveryInput,
  ): Promise<AutomaticMediaRecoveryOutcome>;
}
