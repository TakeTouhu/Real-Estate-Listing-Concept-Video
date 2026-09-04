import { deepFreeze } from "@app/shared";
import { applyBpsToYen, bps, maxYen, yen, type Bps, type Yen } from "./units";

/**
 * The abnormal-cost Safety Guard, as a pure calculation.
 *
 * It exists for cost behaviour that is *wrong* — a provider incident, a run of
 * paid failures, an anomaly — and explicitly not as a lever on normal usage.
 * The frozen principle is worth stating in the module that could most easily
 * violate it: **normal customer entitlement must not be blocked solely because
 * the company's short-term margin declined** (§29). A customer who bought forty
 * videos is owed forty videos whether or not this month was profitable.
 *
 * Nothing here logs, blocks or reaches runtime (§28). It computes a state.
 */

export type SafetyGuardState = "SAFE" | "WARNING" | "HARD_PAUSE";

/** Floors below which a billing cycle's projected profit is abnormal. */
const WARNING_FLOOR_ABSOLUTE_YEN: Yen = yen(20_000);
const WARNING_FLOOR_REVENUE_SHARE_BPS: Bps = bps(2_500);
const HARD_PAUSE_FLOOR_ABSOLUTE_YEN: Yen = yen(15_000);
const HARD_PAUSE_FLOOR_REVENUE_SHARE_BPS: Bps = bps(2_000);

export interface SafetyGuardThresholds {
  readonly warningFloorYen: Yen;
  readonly hardPauseFloorYen: Yen;
}

/**
 * `max(absolute floor, revenue × share)`.
 *
 * The absolute floor is what protects a small contract: 25% of a ¥49,800 plan
 * is ¥12,450, which is a thinner cushion than the fixed ¥20,000 — so the fixed
 * floor governs there, and the proportional one governs as revenue grows.
 */
export function safetyGuardThresholds(billingCycleRevenueYen: Yen): SafetyGuardThresholds {
  return deepFreeze({
    warningFloorYen: maxYen(
      WARNING_FLOOR_ABSOLUTE_YEN,
      applyBpsToYen(billingCycleRevenueYen, WARNING_FLOOR_REVENUE_SHARE_BPS),
    ),
    hardPauseFloorYen: maxYen(
      HARD_PAUSE_FLOOR_ABSOLUTE_YEN,
      applyBpsToYen(billingCycleRevenueYen, HARD_PAUSE_FLOOR_REVENUE_SHARE_BPS),
    ),
  });
}

export interface SafetyGuardDecision {
  readonly state: SafetyGuardState;
  readonly projectedContributionProfitYen: Yen;
  readonly thresholds: SafetyGuardThresholds;
}

/**
 * Classify a billing cycle's projected contribution profit.
 *
 * Strictly **below**, never "at or below". Profit exactly at the hard floor is
 * not a hard pause and profit exactly at the warning floor is not a warning:
 * the floors are the last acceptable values, not the first unacceptable ones.
 * The distinction is one character in the source and a whole customer's service
 * in effect, which is why it is asserted at every boundary (§28).
 */
export function evaluateSafetyGuard(
  billingCycleRevenueYen: Yen,
  projectedContributionProfitYen: Yen,
): SafetyGuardDecision {
  const thresholds = safetyGuardThresholds(billingCycleRevenueYen);
  const state: SafetyGuardState =
    projectedContributionProfitYen < thresholds.hardPauseFloorYen
      ? "HARD_PAUSE"
      : projectedContributionProfitYen < thresholds.warningFloorYen
        ? "WARNING"
        : "SAFE";
  return deepFreeze({ state, projectedContributionProfitYen, thresholds });
}
