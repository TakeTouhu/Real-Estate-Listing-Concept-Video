/**
 * Plan one automatic media-failure recovery: same route, fresh price.
 *
 * ## Historical identity, current money
 *
 * The source attempt's persisted pricing snapshot says which *route* was
 * priced. It does not say what that route costs now. A recovery is a new
 * provider attempt that will be billed at today's rate, so copying the old
 * `estimatedStableCostMicroUsd`, `estimatedPlanningCostMicroUsd` or
 * `riskBufferBps` would file a cost record that never happened — and the paid
 * authorization gate re-derives those numbers from the contract, so a copied
 * row would fail verification later, at the worst possible moment.
 *
 * So the identity is read back, the route is revalidated against *today's*
 * catalogs, a currently eligible contract is resolved, and a completely new
 * `PricingSnapshot` is computed at the planning instant.
 *
 * ## Why this is not inside a transaction
 *
 * Everything here is a lookup that can plausibly become external: a pricing
 * catalog can move behind a service, an FX rate is a rate *from somewhere*. A
 * database transaction that spanned them would hold row locks across a network
 * call. Planning therefore runs to completion first and hands the repository a
 * finished decision.
 */

import {
  createPricingSnapshot,
  evaluatePaidSubmissionPricingEligibility,
  parseProviderPricingIdentity,
  providerPricingContractKey,
  validateFxSnapshot,
  type EpochMillis,
  type ProviderPricingCatalog,
  type ProviderPricingContract,
  type ProviderPricingIdentity,
} from "../pricing/index";
import {
  isSelectableModel,
  isTargetOutputResolution,
  planGenerationResolution,
  type TargetOutputResolution,
  type VideoModelCatalog,
} from "../generation/model-catalog";
import { riskProfileKeyForQualityTier } from "../orchestration/entitlement";
import type {
  AutomaticMediaRecoveryCandidate,
  AutomaticMediaRecoveryPlan,
  AutomaticMediaRecoveryPlannerPort,
  FxRateSource,
  RecoveryExecutionRoute,
} from "./ports";

export interface AutomaticMediaRecoveryPlannerDeps {
  readonly models: VideoModelCatalog;
  readonly pricing: ProviderPricingCatalog;
  /** Injected, so the planning instant is a decision rather than ambient time. */
  readonly clock: () => number;
  readonly fx: FxRateSource;
}

export class AutomaticMediaRecoveryPricingPlanner implements AutomaticMediaRecoveryPlannerPort {
  readonly #models: VideoModelCatalog;
  readonly #pricing: ProviderPricingCatalog;
  readonly #clock: () => number;
  readonly #fx: FxRateSource;

  constructor(deps: AutomaticMediaRecoveryPlannerDeps) {
    this.#models = deps.models;
    this.#pricing = deps.pricing;
    this.#clock = deps.clock;
    this.#fx = deps.fx;
  }

  async plan(candidate: AutomaticMediaRecoveryCandidate): Promise<AutomaticMediaRecoveryPlan> {
    // ---- 1. The persisted identity, parsed rather than asserted. ---------
    const identity = parseProviderPricingIdentity(candidate.persistedPricingIdentity);
    if (!identity.ok) return { kind: "NO_PLAN", code: "PERSISTED_PRICING_IDENTITY_MALFORMED" };

    // ---- 2. The identity must describe the route it was stored against. --
    // A snapshot naming a different model or tier than the attempt it belongs
    // to is not a usable starting point for pricing that attempt's retry.
    if (!identityAgreesWithRoute(identity.value, candidate.route)) {
      return { kind: "NO_PLAN", code: "PERSISTED_PRICING_IDENTITY_MALFORMED" };
    }

    // ---- 3. Today's catalog must still deliver this exact route. ---------
    if (!routeIsStillSafe(this.#models, candidate)) {
      return { kind: "NO_PLAN", code: "NO_SAFE_CURRENT_ROUTE" };
    }

    // ---- 4. A currently eligible contract for the same commercial route. -
    // Deliberately not "the contract the snapshot named": a rate card expires,
    // and requiring the historical `pricingVersion` to stay current forever
    // would make recovery impossible after any price change. The five
    // *commercial* dimensions are what must match; `pricingVersion` and
    // `durationBillingRuleId` may legitimately have moved on.
    const at = this.#clock() as EpochMillis;
    const eligible = currentContractsForRoute(this.#pricing, identity.value, at);
    if (eligible.length === 0) return { kind: "NO_PLAN", code: "NO_SAFE_CURRENT_PRICING" };
    // Two eligible contracts for one route is a catalog the platform cannot
    // bill against unambiguously. Taking the first would silently pick a price.
    if (eligible.length > 1) return { kind: "NO_PLAN", code: "AMBIGUOUS_CURRENT_PRICING" };
    const contract = eligible[0] as ProviderPricingContract;

    // ---- 5. A usable rate. The paid gate re-derives yen from it later. ---
    // Recorded on the snapshot, because the authorization path refuses a
    // snapshot with no FX outright. Planning a recovery that can never be armed
    // would queue work nothing can ever execute.
    const rate = await this.#fx.current();
    if (rate === null) return { kind: "NO_PLAN", code: "NO_SAFE_CURRENT_PRICING" };
    if (!validateFxSnapshot(rate).ok) {
      return { kind: "NO_PLAN", code: "NO_SAFE_CURRENT_PRICING" };
    }

    // ---- 6. A completely new decision, computed not copied. --------------
    const snapshot = createPricingSnapshot({
      contract,
      // From the Job, so a HIGH_QUALITY job is never planned at the normal buffer.
      riskProfileKey: riskProfileKeyForQualityTier(candidate.jobQualityTier),
      // From the Scene, so the retry prices the work it will actually do.
      requestedSeconds: candidate.sceneDurationSeconds,
      pricingEffectiveAt: at,
      fx: rate,
    });
    if (!snapshot.ok) return { kind: "NO_PLAN", code: "NO_SAFE_CURRENT_PRICING" };
    // A snapshot that did not record the rate cannot be armed later, and a
    // silent `null` here is exactly the "dropped FX" this phase must not do.
    if (snapshot.value.fxSnapshotId === null) {
      return { kind: "NO_PLAN", code: "NO_SAFE_CURRENT_PRICING" };
    }

    return { kind: "PLANNED", pricingSnapshot: snapshot.value, fxSnapshot: rate };
  }
}

/** The stored identity must name the same model and tier the attempt executed. */
function identityAgreesWithRoute(
  identity: ProviderPricingIdentity,
  route: RecoveryExecutionRoute,
): boolean {
  return (
    identity.provider === route.providerName &&
    identity.pricingModelKey === route.requestModelKey &&
    identity.nativeTier === route.requestNativeGenerationResolution
  );
}

/**
 * Whether today's model catalog still delivers the source attempt's exact route.
 *
 * A route that was valid once is not automatically safe to re-run: the model
 * may have been withdrawn, un-verified, re-pointed at a different provider id,
 * or may deliver the same product target through a different native resolution
 * or normalization now. Re-running under any of those silently produces
 * *different work* than the attempt being retried.
 */
function routeIsStillSafe(
  models: VideoModelCatalog,
  candidate: AutomaticMediaRecoveryCandidate,
): boolean {
  const entry = models.find(candidate.route.requestModelKey);
  if (entry === undefined) return false;
  if (!isSelectableModel(entry)) return false;
  if (entry.providerName !== candidate.route.providerName) return false;
  if (entry.providerModelId !== candidate.route.providerModelId) return false;
  if (!isTargetOutputResolution(candidate.targetOutputResolution)) return false;

  const target = candidate.targetOutputResolution as TargetOutputResolution;
  // `planGenerationResolution` throws for an unsupported target rather than
  // returning, which is right at its own boundary and wrong here: an
  // unsupported target is an ordinary reason to refuse a retry.
  let delivery;
  try {
    delivery = planGenerationResolution(entry, target);
  } catch {
    return false;
  }
  // The persisted route stores the provider's own token, which is exactly what
  // `NativeGenerationResolution` wraps — so the comparison is against
  // `providerValue`, not the wrapper object.
  return (
    delivery.nativeGenerationResolution.providerValue ===
      candidate.route.requestNativeGenerationResolution &&
    (delivery.normalization as string) === candidate.route.requestResolutionNormalization &&
    delivery.nativeMeetsTarget === candidate.route.requestNativeMeetsTarget
  );
}

/**
 * Every currently eligible contract for one commercial route.
 *
 * Matches the five dimensions that describe *what is being bought* and leaves
 * `pricingVersion` and `durationBillingRuleId` free, because those are exactly
 * what a new rate card changes. Eligibility is then the existing authority —
 * verified, stable, in force at this instant.
 */
function currentContractsForRoute(
  pricing: ProviderPricingCatalog,
  identity: ProviderPricingIdentity,
  at: EpochMillis,
): readonly ProviderPricingContract[] {
  const matches = pricing
    .all()
    .filter(
      (contract) =>
        contract.identity.provider === identity.provider &&
        contract.identity.pricingModelKey === identity.pricingModelKey &&
        contract.identity.generationMode === identity.generationMode &&
        contract.identity.nativeTier === identity.nativeTier &&
        contract.identity.audioMode === identity.audioMode,
    )
    .filter((contract) => evaluatePaidSubmissionPricingEligibility(contract, at).ok);

  // Two catalog entries sharing a complete identity key are the same contract
  // listed twice; the catalog already refuses that at construction. De-duping
  // by key keeps this honest if that ever changes.
  const byKey = new Map<string, ProviderPricingContract>();
  for (const contract of matches) {
    byKey.set(providerPricingContractKey(contract.identity), contract);
  }
  return [...byKey.values()];
}
