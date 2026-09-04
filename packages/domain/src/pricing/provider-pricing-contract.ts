import type { Bps, EpochMillis, MicroUsd } from "./units";

/**
 * What a provider charges, as a contract this application can audit.
 *
 * A price is identified by far more than a model name. Two H3 Max requests at
 * different native tiers, or with audio on versus off, are materially different
 * billing contracts, and collapsing them onto one "model price" is how a cost
 * estimate silently becomes wrong. Every dimension that changes the bill is a
 * dimension of the identity, and the lookup key is built from all of them.
 *
 * Every key is **opaque**. Nothing here parses `768P`, `1080p` or `2K` to infer
 * behaviour: a token is a label the catalog matches on, and the behaviour is
 * whatever this table explicitly says it is. Deriving business rules from vendor
 * strings is how a renamed tier becomes a pricing bug.
 *
 * Instants are `EpochMillis`, never `Date`. A deeply frozen contract holding a
 * `Date` still hands out something a consumer can rewrite with `setTime`, and a
 * past pricing decision whose effective instant can be moved is not a record.
 */

export interface ProviderPricingIdentity {
  /** Opaque provider key, matching the domain's `providerName` convention. */
  readonly provider: string;
  /** Opaque pricing-model key. **Not** an executable model id. */
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

/** The dimensions that make two pricing contracts different, in a fixed order. */
const IDENTITY_DIMENSIONS = [
  "provider",
  "pricingModelKey",
  "generationMode",
  "nativeTier",
  "audioMode",
  "durationBillingRuleId",
  "pricingVersion",
] as const satisfies readonly (keyof ProviderPricingIdentity)[];

/**
 * One opaque key that maps 1:1 to the complete identity.
 *
 * Every dimension participates. A lookup on provider and model alone would
 * happily return the 1080p audio-on price for a 768P audio-off request — the
 * same model, a different bill — so partial matching is not offered at all
 * rather than discouraged.
 *
 * Each segment is escaped before joining, so a value containing the separator
 * cannot forge a different identity's key.
 */
export function providerPricingContractKey(identity: ProviderPricingIdentity): string {
  return IDENTITY_DIMENSIONS.map((dimension) => encodeSegment(identity[dimension])).join("|");
}

/** Escaped so a value containing the separator cannot forge another's encoding. */
function encodeSegment(value: string | number): string {
  return String(value).replaceAll("\\", "\\\\").replaceAll("|", "\\|");
}

/** No rule, no promotion, no end date — one token, distinct from any real value. */
const ABSENT = "~";

/**
 * How a provider turns a duration into money.
 *
 * A discriminated union because not every provider is `seconds × rate`. Writing
 * the calculator as if they were, and treating a fixed-price or bucketed
 * provider as per-second, is a silent multiplication error on the one number
 * that decides whether the product is profitable.
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
 * different numbers, and the cost must use the provider's.
 */
export type BillableDurationPolicy =
  | { readonly kind: "CONTINUOUS"; readonly minSeconds: number; readonly maxSeconds: number }
  | { readonly kind: "DISCRETE"; readonly supportedSeconds: readonly number[] };

/**
 * Whether the stable/list price may be relied on.
 *
 * Separate from any promotion's state, and that separation is the point. A
 * single verification field forced one answer to two questions — "is the list
 * price verified?" and "is there a live promotion?" — and then a contract with
 * both had to pick one, which made a perfectly good stable price unusable
 * merely because a discount also existed.
 */
export type StableVerificationState = "VERIFIED_STABLE" | "UNVERIFIED" | "EXPIRED";

export type PromotionVerificationState = "VERIFIED_PROMOTIONAL" | "UNVERIFIED" | "EXPIRED";

/** The full vocabulary, kept for callers that describe either half. */
export type PricingVerificationState = StableVerificationState | PromotionVerificationState;

export interface StableListPrice {
  readonly verification: StableVerificationState;
  /**
   * `null` when no stable contract has been verified.
   *
   * That is what makes "promotional-only" representable, and refusable, rather
   * than a state the system can accidentally price against.
   */
  readonly rule: DurationBillingRule | null;
}

/**
 * A promotional price, structurally separate and never a planning base.
 *
 * Both ends of the window are required. A promotion with an unknown end date is
 * indistinguishable from a permanent price at planning time, which is exactly
 * how a launch discount becomes the assumed cost — so where the effective dates
 * are not known exactly, no promotion record is written at all rather than one
 * with an invented boundary.
 */
export interface ProviderPromotionalPrice {
  readonly verification: PromotionVerificationState;
  readonly rule: DurationBillingRule;
  readonly effectiveFrom: EpochMillis;
  readonly effectiveUntil: EpochMillis;
}

export interface ProviderPricingContract {
  readonly identity: ProviderPricingIdentity;
  readonly stable: StableListPrice;
  /** Optional, and irrelevant to both eligibility and planning cost. */
  readonly promotion: ProviderPromotionalPrice | null;
  readonly billableDuration: BillableDurationPolicy;
  readonly effectiveFrom: EpochMillis;
  /** `null` means open-ended, not "expired". */
  readonly effectiveUntil: EpochMillis | null;
}

/**
 * A complete encoding of everything about a contract that can change a bill.
 *
 * The identity key is not enough for an audit record. Two contracts can share
 * all seven identity dimensions and still differ in the stable price, the
 * verification state, the duration policy, the promotion or the effective
 * window — so a record that names only the identity cannot prove *which* of
 * them produced its numbers. The fingerprint closes that: re-encode any
 * candidate contract and compare, and a record either re-derives exactly or
 * demonstrably does not belong to that contract.
 *
 * Exact canonical text rather than a digest. A hash would buy brevity and pay
 * for it with collisions and a dependency, and nothing about an audit field is
 * length-constrained — an exact encoding has no false matches at all. Field
 * order is fixed here rather than taken from object key order, so re-ordering a
 * catalog literal cannot change a fingerprint without changing a price.
 *
 * Variable-length parts carry their own length, so no arrangement of one arm's
 * values can be read as another's.
 */
export function providerPricingContractFingerprint(contract: ProviderPricingContract): string {
  return [
    providerPricingContractKey(contract.identity),
    contract.stable.verification,
    ...encodeRule(contract.stable.rule),
    ...encodeDurationPolicy(contract.billableDuration),
    ...encodePromotion(contract.promotion),
    encodeSegment(contract.effectiveFrom),
    contract.effectiveUntil === null ? ABSENT : encodeSegment(contract.effectiveUntil),
  ].join("|");
}

function encodeRule(rule: DurationBillingRule | null): readonly string[] {
  if (rule === null) return [ABSENT];
  switch (rule.kind) {
    case "PER_SECOND":
      return [rule.kind, encodeSegment(rule.unitPriceMicroUsdPerSecond)];
    case "FIXED_DURATION":
      return [rule.kind, encodeSegment(rule.durationSeconds), encodeSegment(rule.priceMicroUsd)];
    case "DURATION_BUCKET":
      return [
        rule.kind,
        encodeSegment(rule.buckets.length),
        ...rule.buckets.flatMap((bucket) => [
          encodeSegment(bucket.upToSeconds),
          encodeSegment(bucket.priceMicroUsd),
        ]),
      ];
  }
}

function encodeDurationPolicy(policy: BillableDurationPolicy): readonly string[] {
  return policy.kind === "CONTINUOUS"
    ? [policy.kind, encodeSegment(policy.minSeconds), encodeSegment(policy.maxSeconds)]
    : [
        policy.kind,
        encodeSegment(policy.supportedSeconds.length),
        ...policy.supportedSeconds.map(encodeSegment),
      ];
}

function encodePromotion(promotion: ProviderPromotionalPrice | null): readonly string[] {
  return promotion === null
    ? [ABSENT]
    : [
        "PROMOTION",
        promotion.verification,
        ...encodeRule(promotion.rule),
        encodeSegment(promotion.effectiveFrom),
        encodeSegment(promotion.effectiveUntil),
      ];
}

/**
 * Planning risk, held apart from the provider's price.
 *
 * Deliberately not baked into the rate. A buffer folded into a stable price
 * becomes indistinguishable from what the vendor actually charges, and then
 * nobody can answer "what did this cost?" separately from "what did we plan
 * for?" — which is the question a margin review is made of.
 */
export type CostRiskProfileKey = "NORMAL_AI" | "HIGH_QUALITY_AI";

export interface CostRiskProfile {
  readonly key: CostRiskProfileKey;
  readonly bufferBps: Bps;
}

/**
 * An audited exchange rate, supplied by the caller.
 *
 * A rational rather than a decimal, and an explicit instant and source: a
 * profitability figure that cannot say which rate produced it cannot be
 * re-checked. Nothing in this phase fetches one.
 */
export interface FxSnapshot {
  readonly id: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly rateNumerator: number;
  readonly rateDenominator: number;
  readonly effectiveAt: EpochMillis;
  readonly sourceReference: string | null;
}
