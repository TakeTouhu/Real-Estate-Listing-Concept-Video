import { deepFreeze } from "@app/shared";
import {
  providerPricingContractKey,
  type CostRiskProfile,
  type CostRiskProfileKey,
  type ProviderPricingContract,
  type ProviderPricingIdentity,
} from "./provider-pricing-contract";
import { bps, epochMillisFromDate, microUsd } from "./units";

/**
 * The provider pricing catalog: cost facts only, never a customer price.
 *
 * Entries appear here only when their commercial dimensions are known exactly.
 * Where they are not, the honest representation is `UNVERIFIED` with a `null`
 * stable rule — a guessed price is worse than a missing one, because a missing
 * one refuses and a guessed one quietly plans against fiction.
 */

/** 30% and 50%, held apart from every provider rate. */
const RISK_PROFILES: readonly CostRiskProfile[] = deepFreeze([
  { key: "NORMAL_AI", bufferBps: bps(3_000) },
  { key: "HIGH_QUALITY_AI", bufferBps: bps(5_000) },
] as const);

export function costRiskProfile(key: CostRiskProfileKey): CostRiskProfile {
  const profile = RISK_PROFILES.find((candidate) => candidate.key === key);
  // The key is a closed union, so a miss is a defect, not a pricing outcome.
  if (profile === undefined) throw new Error("Unknown cost risk profile");
  return profile;
}

/** Written once here so every entry's effective instant is the same literal. */
const CATALOG_EFFECTIVE_FROM = epochMillisFromDate(new Date("2026-09-01T00:00:00.000Z"));

const CONTRACTS: readonly ProviderPricingContract[] = deepFreeze([
  /**
   * MiniMax H3 Max on fal — the current default generation path.
   *
   * The stable/list price is $0.08 per billable second. The launch promotion at
   * $0.02 is **deliberately absent**: its exact effective window is not known,
   * and a promotion without a verified end date is indistinguishable from a
   * permanent price at planning time. Recording it would make the entire margin
   * model depend on a discount that can end without notice.
   *
   * `pricingModelKey` is a pricing label. The executable endpoint remains
   * `MINIMAX_H3_MAX_MODEL_ID` in the video-providers catalog, and is not
   * duplicated here — one executable authority, as the fal adapter established.
   */
  {
    identity: {
      provider: "fal",
      pricingModelKey: "minimax-h3-max",
      generationMode: "image-to-video",
      nativeTier: "768P",
      audioMode: "none",
      durationBillingRuleId: "per-second",
      pricingVersion: "2026-09-02.1",
    },
    stable: {
      verification: "VERIFIED_STABLE",
      rule: { kind: "PER_SECOND", unitPriceMicroUsdPerSecond: microUsd(80_000) },
    },
    promotion: null,
    billableDuration: { kind: "CONTINUOUS", minSeconds: 5, maxSeconds: 15 },
    effectiveFrom: CATALOG_EFFECTIVE_FROM,
    effectiveUntil: null,
  },
  /**
   * Veo 3.1 Fast, 1080p, audio off — the provisional high-quality choice.
   *
   * The provider is **fal**, not Google. The model is Google's, but the billing
   * contract this record represents is fal's: fal issues the invoice, and a
   * pricing contract names whoever charges. Recording the manufacturer would
   * have made the entry unmatchable against the model catalog's provider
   * convention, which is `fal` for this route.
   *
   * Present as a *pricing* contract only. Pricing verification and executable
   * verification are separate concerns: nothing here makes Veo selectable, and
   * there is no Veo adapter.
   *
   * The discrete duration set is the commercially significant part — Veo
   * generates 4, 6 or 8 seconds and nothing between, so a 5-second product
   * scene bills at 6.
   */
  {
    identity: {
      provider: "fal",
      pricingModelKey: "veo-3-1-fast",
      generationMode: "image-to-video",
      nativeTier: "1080p",
      audioMode: "off",
      durationBillingRuleId: "per-second",
      pricingVersion: "2026-09-02.1",
    },
    stable: {
      verification: "VERIFIED_STABLE",
      rule: { kind: "PER_SECOND", unitPriceMicroUsdPerSecond: microUsd(100_000) },
    },
    promotion: null,
    billableDuration: { kind: "DISCRETE", supportedSeconds: [4, 6, 8] },
    effectiveFrom: CATALOG_EFFECTIVE_FROM,
    effectiveUntil: null,
  },
  /**
   * WaveSpeed OpenVideo — economy/fallback, unchanged in every other respect.
   *
   * Only the 1080p tier is recorded, because that is the tier whose price is
   * verified. Its published rate card is resolution-dependent, and the other
   * tiers are omitted rather than assumed. The verified duration range is 3–20
   * seconds inclusive.
   */
  {
    identity: {
      provider: "wavespeed",
      pricingModelKey: "wavespeed-open-video",
      generationMode: "image-to-video",
      nativeTier: "1080p",
      audioMode: "none",
      durationBillingRuleId: "per-second",
      pricingVersion: "2026-09-02.1",
    },
    stable: {
      verification: "VERIFIED_STABLE",
      rule: { kind: "PER_SECOND", unitPriceMicroUsdPerSecond: microUsd(60_000) },
    },
    promotion: null,
    billableDuration: { kind: "CONTINUOUS", minSeconds: 3, maxSeconds: 20 },
    effectiveFrom: CATALOG_EFFECTIVE_FROM,
    effectiveUntil: null,
  },
] as const);

/**
 * Two contracts sharing a key would make lookup return whichever came first,
 * which is precisely the wrong-price failure the full identity exists to
 * prevent. A duplicate is a defect in this table, so it fails at module load
 * rather than at the first mispriced request.
 */
const BY_KEY: ReadonlyMap<string, ProviderPricingContract> = (() => {
  const map = new Map<string, ProviderPricingContract>();
  for (const contract of CONTRACTS) {
    const key = providerPricingContractKey(contract.identity);
    if (map.has(key)) throw new Error("Duplicate provider pricing contract identity");
    map.set(key, contract);
  }
  return map;
})();

export interface ProviderPricingCatalog {
  /**
   * Look up by the **complete** identity. There is deliberately no lookup by
   * provider and model alone: several variants of one model can differ in tier,
   * audio mode or billing rule, and a partial match would return one of them
   * arbitrarily.
   */
  findByIdentity(identity: ProviderPricingIdentity): ProviderPricingContract | undefined;
  /** Look up by the opaque key, for callers that already hold one. */
  findByKey(key: string): ProviderPricingContract | undefined;
  all(): readonly ProviderPricingContract[];
}

export function createProviderPricingCatalog(): ProviderPricingCatalog {
  return {
    findByIdentity: (identity) => BY_KEY.get(providerPricingContractKey(identity)),
    findByKey: (key) => BY_KEY.get(key),
    all: () => CONTRACTS,
  };
}
