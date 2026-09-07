import { createPricingSnapshot, type PricingSnapshot } from "../pricing/pricing-snapshot";
import {
  providerPricingContractFingerprint,
  type CostRiskProfileKey,
  type FxSnapshot,
  type ProviderPricingContract,
} from "../pricing/provider-pricing-contract";
import { epochMillis } from "../pricing/units";
import { persistedIntegerToNumber, persistedMicroUsd } from "./persisted-money";
import type { PricingAuthorizationFailure } from "./types";

/**
 * Prove the persisted pricing decision is still the decision it claims to be.
 *
 * The weak version of this check reads a few binding fields — provider, model
 * key, contract key — decides they agree with the attempt, and then *trusts the
 * stored amount*. That is exactly the wrong place to stop. Provider and model
 * are the fields nobody tampers with, because changing them breaks the
 * submission; `estimatedPlanningCostMicroUsd` is the field that decides how much
 * of a cycle's Safety Guard headroom this attempt consumes, and it can be
 * rewritten to zero while every binding field still matches perfectly.
 *
 * Phase 4C-3B-2D introduced `contractFingerprint` for the other half of the same
 * problem: two contracts can share all seven identity dimensions and differ in
 * price, verification, duration policy, promotion or effective window. Resolving
 * a contract by identity and calling it the same contract is a guess.
 *
 * So this re-derives the whole snapshot. Take the persisted risk profile,
 * duration and effective instant, run them through the *same*
 * `createPricingSnapshot` that admission ran, and compare every immutable
 * commercial fact against what the row holds. A row that cannot reproduce
 * refuses. No arithmetic is repeated here — the pricing domain does all of it —
 * and no stored amount is trusted because a neighbouring column looked right.
 */

/** The persisted snapshot, exactly as the row holds it. */
export interface PersistedPricingSnapshotFacts {
  readonly sceneGenerationId: string;
  readonly pricingVersion: string;
  readonly provider: string;
  readonly contractKey: string;
  readonly contractFingerprint: string;
  readonly identityJson: unknown;
  readonly stablePriceReferenceJson: unknown;
  readonly riskProfileKey: string;
  readonly riskBufferBps: number;
  readonly requestedSeconds: number;
  readonly billableSeconds: number;
  /** `BIGINT` columns arrive unconverted — see {@link persistedMicroUsd}. */
  readonly estimatedStableCostMicroUsd: bigint;
  readonly estimatedPlanningCostMicroUsd: bigint;
  readonly pricingEffectiveAtEpochMs: bigint;
  readonly fxSnapshotId: string | null;
}

export type PricingIntegrityResult =
  | { readonly ok: true; readonly snapshot: PricingSnapshot }
  | { readonly ok: false; readonly reason: PricingAuthorizationFailure };

const RISK_PROFILE_KEYS: readonly CostRiskProfileKey[] = ["NORMAL_AI", "HIGH_QUALITY_AI"];

function isRiskProfileKey(value: string): value is CostRiskProfileKey {
  return RISK_PROFILE_KEYS.includes(value as CostRiskProfileKey);
}

/**
 * Structural equality over the JSON the row stores.
 *
 * `identityJson` and `stablePriceReferenceJson` are written by the same producer
 * whose output is being compared, so a deep comparison is exact rather than
 * approximate. Key order is not compared, because PostgreSQL's `json` round-trip
 * does not promise to preserve it and a re-ordered key is not a price change.
 */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqualJson(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) => Object.hasOwn(right, key) && deepEqualJson(left[key], right[key]),
  );
}

export function verifyPersistedPricingSnapshot(input: {
  readonly persisted: PersistedPricingSnapshotFacts;
  /** Resolved from the catalog by the persisted identity, or `null` on a miss. */
  readonly contract: ProviderPricingContract | null;
  /** The exact validated rate the snapshot names, when it names one. */
  readonly fx: FxSnapshot | null;
}): PricingIntegrityResult {
  const { persisted, contract, fx } = input;

  if (contract === null) {
    return { ok: false, reason: "PRICING_CONTRACT_MISSING" };
  }

  // Before anything is re-derived. A same-identity contract whose commercial
  // content differs would otherwise produce a perfectly self-consistent
  // "re-derivation" of numbers that never applied to this attempt.
  if (providerPricingContractFingerprint(contract) !== persisted.contractFingerprint) {
    return { ok: false, reason: "PRICING_CONTRACT_FINGERPRINT_MISMATCH" };
  }

  if (!isRiskProfileKey(persisted.riskProfileKey)) {
    return { ok: false, reason: "PRICING_SNAPSHOT_NOT_REPRODUCIBLE" };
  }

  // Range-checked before narrowing, so an out-of-range column refuses rather
  // than throwing `PricingArithmeticError` out of an ordinary authorization.
  const persistedPlanning = persistedMicroUsd(persisted.estimatedPlanningCostMicroUsd);
  const persistedStable = persistedMicroUsd(persisted.estimatedStableCostMicroUsd);
  const persistedEffectiveAt = persistedIntegerToNumber(persisted.pricingEffectiveAtEpochMs);
  if (persistedPlanning === null || persistedStable === null || persistedEffectiveAt === null) {
    return { ok: false, reason: "PRICING_AMOUNT_UNREPRESENTABLE" };
  }

  // The effective instant is an *input* to the derivation, so re-deriving with
  // it can never disagree with it — a moved instant would reproduce itself
  // perfectly. What can be checked is whether the moved value is a time at
  // which this contract applied at all: a snapshot claiming to have been priced
  // outside its own contract's window is not a record of anything that happened.
  if (
    persistedEffectiveAt < contract.effectiveFrom ||
    (contract.effectiveUntil !== null && persistedEffectiveAt >= contract.effectiveUntil)
  ) {
    return { ok: false, reason: "PRICING_SNAPSHOT_NOT_REPRODUCIBLE" };
  }

  const rederived = createPricingSnapshot({
    contract,
    riskProfileKey: persisted.riskProfileKey,
    requestedSeconds: persisted.requestedSeconds,
    pricingEffectiveAt: epochMillis(persistedEffectiveAt),
    fx,
  });
  if (!rederived.ok) {
    // The contract can no longer produce a snapshot for this duration at all —
    // a promotional-only contract, or a duration outside its policy. Whatever
    // the row holds was not produced by the contract it names.
    return { ok: false, reason: "PRICING_SNAPSHOT_NOT_REPRODUCIBLE" };
  }
  const derived = rederived.value;

  // Every immutable commercial fact, compared. A single disagreement refuses:
  // there is no such thing as a snapshot that is mostly the one that was
  // admitted.
  const agrees =
    derived.pricingVersion === persisted.pricingVersion &&
    derived.provider === persisted.provider &&
    derived.contractKey === persisted.contractKey &&
    derived.contractFingerprint === persisted.contractFingerprint &&
    derived.riskProfileKey === persisted.riskProfileKey &&
    derived.riskBufferBps === persisted.riskBufferBps &&
    derived.requestedSeconds === persisted.requestedSeconds &&
    derived.billableSeconds === persisted.billableSeconds &&
    derived.estimatedStableCostMicroUsd === persistedStable &&
    derived.estimatedPlanningCostMicroUsd === persistedPlanning &&
    derived.pricingEffectiveAt === persistedEffectiveAt &&
    derived.fxSnapshotId === persisted.fxSnapshotId &&
    deepEqualJson(derived.identity, persisted.identityJson) &&
    deepEqualJson(derived.stablePriceReference, persisted.stablePriceReferenceJson);
  if (!agrees) {
    return { ok: false, reason: "PRICING_SNAPSHOT_NOT_REPRODUCIBLE" };
  }

  // The re-derived value, not the persisted one. They are equal by the check
  // above, and returning the derived object means every downstream figure comes
  // from the calculation rather than from a column.
  return { ok: true, snapshot: derived };
}
