import { deepFreeze } from "@app/shared";
import type {
  CostRiskProfile,
  CostRiskProfileKey,
  ProviderPricingContract,
} from "./provider-pricing-contract";
import { bps, microUsd } from "./units";

/**
 * The provider pricing catalog: cost facts only, never a customer price.
 *
 * Entries appear here only when their commercial dimensions are known exactly.
 * Where they are not, the honest representation is `UNVERIFIED` with a `null`
 * stable rule — a guessed price is worse than a missing one, because a missing
 * one refuses and a guessed one quietly plans against fiction.
 */

/** 30% and 50%, held apart from every provider rate (§20). */
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

const CONTRACTS: readonly ProviderPricingContract[] = deepFreeze([
  /**
   * MiniMax H3 Max on fal — the current default generation path.
   *
   * The stable/list price is $0.08 per billable second. The launch promotion at
   * $0.02 is **deliberately absent**: its exact effective window is not known,
   * and a promotion without a verified end date is indistinguishable from a
   * permanent price at planning time. Recording it would make the entire margin
   * model depend on a discount that can end without notice (§16).
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
    verification: "VERIFIED_STABLE",
    stableRule: { kind: "PER_SECOND", unitPriceMicroUsdPerSecond: microUsd(80_000) },
    promotional: null,
    billableDuration: { kind: "CONTINUOUS", minSeconds: 5, maxSeconds: 15 },
    effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
    effectiveUntil: null,
  },
  /**
   * Veo 3.1 Fast — the provisional high-quality choice.
   *
   * Present as a *pricing* contract only. Pricing verification and executable
   * verification are separate concerns (§2): nothing here makes Veo selectable,
   * and there is no Veo adapter.
   *
   * The discrete duration set is the commercially significant part. Veo
   * generates 4, 6 or 8 seconds and nothing between, so a 5-second product
   * scene bills at 6 (§19).
   */
  {
    identity: {
      provider: "google-veo",
      pricingModelKey: "veo-3-1-fast",
      generationMode: "image-to-video",
      nativeTier: "1080p",
      audioMode: "off",
      durationBillingRuleId: "per-second",
      pricingVersion: "2026-09-02.1",
    },
    verification: "VERIFIED_STABLE",
    stableRule: { kind: "PER_SECOND", unitPriceMicroUsdPerSecond: microUsd(100_000) },
    promotional: null,
    billableDuration: { kind: "DISCRETE", supportedSeconds: [4, 6, 8] },
    effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
    effectiveUntil: null,
  },
  /**
   * WaveSpeed OpenVideo — economy/fallback, unchanged in every other respect.
   *
   * Only the 1080p tier is recorded, because that is the tier whose price is
   * verified. Its published rate card is resolution-dependent, and the other
   * tiers are omitted rather than assumed.
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
    verification: "VERIFIED_STABLE",
    stableRule: { kind: "PER_SECOND", unitPriceMicroUsdPerSecond: microUsd(60_000) },
    promotional: null,
    billableDuration: { kind: "CONTINUOUS", minSeconds: 1, maxSeconds: 20 },
    effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
    effectiveUntil: null,
  },
] as const);

export interface ProviderPricingCatalog {
  find(provider: string, pricingModelKey: string): ProviderPricingContract | undefined;
  all(): readonly ProviderPricingContract[];
}

export function createProviderPricingCatalog(): ProviderPricingCatalog {
  return {
    find: (provider, pricingModelKey) =>
      CONTRACTS.find(
        (contract) =>
          contract.identity.provider === provider &&
          contract.identity.pricingModelKey === pricingModelKey,
      ),
    all: () => CONTRACTS,
  };
}
