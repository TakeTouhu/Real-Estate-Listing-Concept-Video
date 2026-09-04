import type { Bps, MicroUsd } from "./units";

/**
 * What a provider charges, as a contract this application can audit.
 *
 * A price is identified by far more than a model name. Two H3 Max requests at
 * different native tiers, or with audio on versus off, are materially different
 * billing contracts, and collapsing them onto one "model price" is how a cost
 * estimate silently becomes wrong. Every dimension that changes the bill is a
 * dimension of the identity.
 *
 * Every key is **opaque**. Nothing here parses `768P`, `1080p` or `2K` to infer
 * behaviour: a token is a label the catalog matches on, and the behaviour is
 * whatever this table explicitly says it is (§14). Deriving business rules from
 * vendor strings is how a renamed tier becomes a pricing bug.
 */

/** An instant, passed in explicitly. Nothing here calls `Date.now()` (§21). */
export type EvaluationInstant = Date;

export interface ProviderPricingIdentity {
  /** Opaque provider key, matching the domain's `providerName` convention. */
  readonly provider: string;
  /** Opaque pricing-model key. **Not** an executable model id (§17). */
  readonly pricingModelKey: string;
  readonly generationMode: string;
  /** Opaque native tier label. Never parsed. */
  readonly nativeTier: string;
  readonly audioMode: string;
  /** Names the shape of the billing rule, so identity distinguishes rule changes. */
  readonly durationBillingRuleId: string;
  /** Opaque, immutable. A snapshot records this so a later price change is visible. */
  readonly pricingVersion: string;
}

/**
 * How a provider turns a duration into money.
 *
 * A discriminated union because not every provider is `seconds × rate`. Writing
 * the calculator as if they were, and treating a fixed-price or bucketed
 * provider as per-second, is a silent multiplication error on the one number
 * that decides whether the product is profitable (§18).
 */
export type DurationBillingRule =
  | { readonly kind: "PER_SECOND"; readonly unitPriceMicroUsdPerSecond: MicroUsd }
  | {
      readonly kind: "FIXED_DURATION";
      readonly durationSeconds: number;
      readonly priceMicroUsd: MicroUsd;
    }
  | {
      readonly kind: "DURATION_BUCKET";
      /** Ordered, ascending, inclusive upper bounds. The first match wins. */
      readonly buckets: readonly { readonly upToSeconds: number; readonly priceMicroUsd: MicroUsd }[];
    };

/**
 * Which durations the provider will actually generate.
 *
 * `DISCRETE` is the case that matters commercially: Veo generates 4, 6 or 8
 * seconds and nothing between, so a 5-second product scene is billed as 6. The
 * customer's final scene length and the provider's billable duration are
 * different numbers, and the cost must use the provider's (§19).
 */
export type BillableDurationPolicy =
  | { readonly kind: "CONTINUOUS"; readonly minSeconds: number; readonly maxSeconds: number }
  | { readonly kind: "DISCRETE"; readonly supportedSeconds: readonly number[] };

/**
 * Whether a price may be relied on.
 *
 * `VERIFIED_PROMOTIONAL` is a first-class state rather than a flag on a stable
 * price, because a promotion is a different commercial fact with its own
 * lifetime. A launch discount that expires while a plan is priced against it
 * turns a margin into a loss without anything in the system changing.
 */
export type PricingVerificationState =
  | "VERIFIED_STABLE"
  | "VERIFIED_PROMOTIONAL"
  | "UNVERIFIED"
  | "EXPIRED";

/**
 * A promotional price, kept structurally separate from the stable one.
 *
 * Both ends of the window are required. A promotion with an unknown end date is
 * indistinguishable from a permanent price at planning time, which is the exact
 * mistake that would let H3 Max's launch rate become the planning base — so
 * where the effective dates are not known exactly, no promotion record is
 * written at all rather than one with an invented boundary (§16).
 */
export interface ProviderPromotionalPrice {
  readonly rule: DurationBillingRule;
  readonly effectiveFrom: EvaluationInstant;
  readonly effectiveUntil: EvaluationInstant;
}

export interface ProviderPricingContract {
  readonly identity: ProviderPricingIdentity;
  readonly verification: PricingVerificationState;
  /**
   * The stable/list rule — the **only** planning base.
   *
   * `null` when no stable contract has been verified, which is what makes
   * "promotional-only" representable and refusable rather than a state the
   * system can accidentally price against.
   */
  readonly stableRule: DurationBillingRule | null;
  readonly promotional: ProviderPromotionalPrice | null;
  readonly billableDuration: BillableDurationPolicy;
  readonly effectiveFrom: EvaluationInstant;
  /** `null` means open-ended, not "expired". */
  readonly effectiveUntil: EvaluationInstant | null;
}

/**
 * Planning risk, held apart from the provider's price.
 *
 * Deliberately not baked into the rate. A buffer folded into a stable price
 * becomes indistinguishable from what the vendor actually charges, and then
 * nobody can answer "what did this cost?" separately from "what did we plan
 * for?" — which is the question a margin review is made of (§20).
 */
export type CostRiskProfileKey = "NORMAL_AI" | "HIGH_QUALITY_AI";

export interface CostRiskProfile {
  readonly key: CostRiskProfileKey;
  readonly bufferBps: Bps;
}

/**
 * An audited exchange rate, supplied by the caller.
 *
 * A rational rather than a decimal, and an explicit timestamp and source: a
 * profitability figure that cannot say which rate produced it cannot be
 * re-checked. Nothing in this phase fetches one (§21).
 */
export interface FxSnapshot {
  readonly id: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly rateNumerator: number;
  readonly rateDenominator: number;
  readonly effectiveAt: EvaluationInstant;
  readonly sourceReference: string | null;
}
