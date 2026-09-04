import { pricingFailure, pricingOk, type PricingResult } from "./errors";
import {
  ADDITIONAL_USER_PRICE_YEN_EX_TAX_PER_MONTH,
  ANNUAL_PREPAYMENT_DISCOUNT_BPS,
  CONTRACT_MONTHS,
  HIGH_QUALITY_ADD_ON_MULTIPLIER_BPS,
  NORMAL_ADD_ON_MULTIPLIER_BPS,
  type CustomerPlan,
} from "./customer-plan-catalog";
import {
  ONE_HUNDRED_PERCENT_BPS,
  applyBpsToYen,
  roundYenToNearestHundred,
  roundYenUpToHundred,
  scaleYen,
  type Yen,
} from "./units";

/**
 * Customer-facing pricing arithmetic. Nothing here reads a provider price.
 *
 * Every amount is tax-exclusive and every intermediate is exact: rounding
 * happens once, at the end, and only where the contract says a customer-facing
 * figure is produced.
 */

/** The longest scene the current product policy supports. */
export const MAX_SUPPORTED_SCENE_SECONDS = 90;

/** Seconds per video unit: 1–30 → 1, 31–60 → 2, 61–90 → 3. */
const SECONDS_PER_VIDEO_UNIT = 30;

/**
 * Convert a scene duration into customer video units.
 *
 * This is a *product* rule and has nothing to do with what a provider bills.
 * A 15-second scene consumes a whole unit; a provider charging per second does
 * not. Deriving one from the other would make a vendor's billing granularity a
 * customer-visible entitlement change (§9).
 */
export function videoUnitsForSeconds(seconds: number): PricingResult<number> {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    return pricingFailure("DURATION_NOT_A_POSITIVE_INTEGER");
  }
  if (seconds > MAX_SUPPORTED_SCENE_SECONDS) {
    return pricingFailure("DURATION_EXCEEDS_PRODUCT_POLICY");
  }
  return pricingOk(Math.ceil(seconds / SECONDS_PER_VIDEO_UNIT));
}

/**
 * What one generation draws down.
 *
 * High-quality usage consumes total units **and** high-quality units — the same
 * count, not a separate charge. It is a sub-limit inside the entitlement, so a
 * 90-second high-quality scene is 3 total and 3 high-quality (§10).
 */
export interface EntitlementConsumption {
  readonly totalVideoUnits: number;
  readonly highQualityUnits: number;
}

export function consumptionForScene(
  seconds: number,
  highQuality: boolean,
): PricingResult<EntitlementConsumption> {
  const units = videoUnitsForSeconds(seconds);
  if (!units.ok) return units;
  return pricingOk({
    totalVideoUnits: units.value,
    highQualityUnits: highQuality ? units.value : 0,
  });
}

/** Monthly cost of extra seats. Seats never change generation entitlement (§8). */
export function additionalUserMonthlyPriceYenExTax(additionalUsers: number): PricingResult<Yen> {
  if (!Number.isSafeInteger(additionalUsers) || additionalUsers <= 0) {
    return pricingFailure("QUANTITY_NOT_A_POSITIVE_INTEGER");
  }
  return pricingOk(scaleYen(ADDITIONAL_USER_PRICE_YEN_EX_TAX_PER_MONTH, additionalUsers, 1));
}

export interface AnnualContractRawPricing {
  readonly grossAnnualYenExTax: Yen;
  /** Exact and unrounded. Not a quotable price — see `finalizeCustomerPrice`. */
  readonly prepaymentRawYenExTax: Yen;
}

/**
 * The raw arithmetic of the two ways of paying for one 12-month contract.
 *
 * Returns no final figure on purpose. Rounding a customer price is the step
 * that can push it under a profitability floor, so it is not something a pure
 * calculation may do on its own — a caller that wants a quotable number passes
 * this through {@link finalizeCustomerPrice} and supplies the floor.
 *
 * The gross figure is derived from the frozen monthly price rather than stored,
 * so a monthly price and an annual total cannot disagree.
 */
export function annualContractRawPricing(plan: CustomerPlan): AnnualContractRawPricing {
  const gross = scaleYen(plan.monthlyPriceYenExTax, CONTRACT_MONTHS, 1);
  return {
    grossAnnualYenExTax: gross,
    prepaymentRawYenExTax: applyBpsToYen(
      gross,
      (ONE_HUNDRED_PERCENT_BPS -
        ANNUAL_PREPAYMENT_DISCOUNT_BPS) as typeof ANNUAL_PREPAYMENT_DISCOUNT_BPS,
    ),
  };
}

export interface FinalCustomerPrice {
  /** Exact, unrounded, before any customer-facing rounding. */
  readonly rawYenExTax: Yen;
  /** What the customer is quoted. */
  readonly finalYenExTax: Yen;
  /** True when nearest-¥100 was rejected because it would have been unprofitable. */
  readonly roundedAwayFromNearestForSafety: boolean;
}

/**
 * Turn an exact price into a quotable one, safely.
 *
 * This is the **only** way to obtain a final customer price, and the floor is a
 * required argument rather than a defaulted one. A default of zero would have
 * made the commercial rule opt-in, and a safety rule a caller can skip by
 * omitting a parameter is not a safety rule.
 *
 * The order is fixed: raw → validate → rounded candidate → re-validate → final.
 * Nearest-¥100 can move a price *down*, so when the rounded candidate falls
 * below the floor the next ¥100 up is used instead, and if even that is below
 * the floor the price is refused rather than quoted at a loss.
 */
export function finalizeCustomerPrice(
  rawYenExTax: Yen,
  minimumSafePriceYenExTax: Yen,
): PricingResult<FinalCustomerPrice> {
  if (rawYenExTax < minimumSafePriceYenExTax) {
    return pricingFailure("ROUNDED_PRICE_WOULD_BE_UNPROFITABLE");
  }

  const nearest = roundYenToNearestHundred(rawYenExTax);
  if (nearest >= minimumSafePriceYenExTax) {
    return pricingOk({
      rawYenExTax,
      finalYenExTax: nearest,
      roundedAwayFromNearestForSafety: false,
    });
  }

  const safeUp = roundYenUpToHundred(rawYenExTax);
  if (safeUp < minimumSafePriceYenExTax) {
    return pricingFailure("ROUNDED_PRICE_WOULD_BE_UNPROFITABLE");
  }
  return pricingOk({
    rawYenExTax,
    finalYenExTax: safeUp,
    roundedAwayFromNearestForSafety: true,
  });
}

/** The quotable annual prepayment price, which cannot be produced unvalidated. */
export function annualPrepaymentFinalPrice(
  plan: CustomerPlan,
  minimumSafePriceYenExTax: Yen,
): PricingResult<FinalCustomerPrice> {
  return finalizeCustomerPrice(
    annualContractRawPricing(plan).prepaymentRawYenExTax,
    minimumSafePriceYenExTax,
  );
}

/**
 * The plan-derived add-on calculation base: monthly price ÷ included units.
 *
 * **Internal only.** It is not a per-video list price and must not be shown to
 * a customer as one. There is exactly one base — the rejected `×1.25`
 * high-quality base is not implemented (§11); the difference between normal and
 * high-quality add-ons lives entirely in the multiplier.
 *
 * Exposed as an exact fraction rather than a rounded yen figure, because
 * rounding it is precisely the mistake §5 forbids.
 */
export interface AddOnCalculationBase {
  readonly planMonthlyPriceYenExTax: Yen;
  readonly includedVideoUnits: number;
}

export function addOnCalculationBase(plan: CustomerPlan): AddOnCalculationBase {
  return {
    planMonthlyPriceYenExTax: plan.monthlyPriceYenExTax,
    includedVideoUnits: plan.includedVideoUnits,
  };
}

export type AddOnKind = "NORMAL" | "HIGH_QUALITY";

export interface AddOnPackagePrice extends FinalCustomerPrice {
  readonly kind: AddOnKind;
  readonly units: number;
}

/**
 * Price an add-on package of `units`.
 *
 * The whole calculation is one fraction:
 *
 * ```text
 * planMonthlyPrice × multiplierBps × units
 * ─────────────────────────────────────────
 *       includedVideoUnits × 10_000
 * ```
 *
 * It is deliberately **not** `round(planPrice ÷ units) × multiplier × quantity`.
 * Premium's high-quality unit is ¥4,492.5 exactly; rounding it first and then
 * multiplying by two gives ¥8,986 or ¥8,984 depending on direction, against a
 * true ¥8,985. Rounding once, at the end, is the only way the quoted total is
 * the price of the package rather than the price of a rounded unit times a
 * count (§5, §12).
 *
 * `minimumSafePriceYenExTax` is the profitability floor, and it is required.
 * A defaulted floor would make the commercial rule opt-in, and a safety rule a
 * caller can skip by omitting a parameter is not a safety rule. Finalization is
 * delegated to {@link finalizeCustomerPrice}, so add-ons and annual prepayment
 * cannot diverge in how they round.
 */
export function addOnPackagePrice(
  plan: CustomerPlan,
  kind: AddOnKind,
  units: number,
  minimumSafePriceYenExTax: Yen,
): PricingResult<AddOnPackagePrice> {
  if (!Number.isSafeInteger(units) || units <= 0) {
    return pricingFailure("QUANTITY_NOT_A_POSITIVE_INTEGER");
  }
  if (kind === "HIGH_QUALITY" && !plan.highQualityAddOnAvailable) {
    return pricingFailure("HIGH_QUALITY_ADD_ON_NOT_AVAILABLE_ON_PLAN");
  }

  const multiplierBps =
    kind === "HIGH_QUALITY" ? HIGH_QUALITY_ADD_ON_MULTIPLIER_BPS : NORMAL_ADD_ON_MULTIPLIER_BPS;

  const raw = scaleYen(
    plan.monthlyPriceYenExTax,
    multiplierBps * units,
    plan.includedVideoUnits * ONE_HUNDRED_PERCENT_BPS,
  );

  const finalized = finalizeCustomerPrice(raw, minimumSafePriceYenExTax);
  if (!finalized.ok) return finalized;
  return pricingOk({ kind, units, ...finalized.value });
}
