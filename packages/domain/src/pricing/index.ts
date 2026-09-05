/**
 * The pricing domain.
 *
 * Provider cost and customer price are separate modules on purpose, and this
 * barrel does not blur them: a provider rate change must never be able to move
 * a customer price by construction, not by convention (§4).
 *
 * Internal calculation helpers are deliberately not re-exported. `units.ts` is
 * arithmetic this domain owns; tests exercise behaviour through the contracts
 * below rather than through the arithmetic underneath them (§36).
 */

export * from "./errors";
export * from "./customer-plan-catalog";
export * from "./customer-pricing";
export * from "./provider-pricing-contract";
export * from "./provider-pricing-catalog";
export * from "./provider-cost-calculator";
export * from "./pricing-eligibility";
export * from "./pricing-snapshot";
export * from "./profitability";
export * from "./safety-guard";
export type { Bps, EpochMillis, MicroUsd, Yen } from "./units";
export { bps, microUsd, yen } from "./units";
/**
 * The instant constructors, exported because `createPricingSnapshot` *requires*
 * an `EpochMillis` and the brand makes one unconstructable from outside this
 * module. Withholding them would leave the snapshot API callable only by a
 * caller willing to cast, which is the one thing the brand exists to prevent.
 */
export { epochMillis, epochMillisFromDate } from "./units";
