/**
 * The closed vocabulary of expected pricing failures.
 *
 * Every reason is a literal chosen here. No function accepts caller-supplied
 * diagnostic text, because a free-text field is an open channel — the same
 * reasoning that removed `falLocalConfigurationError(messageSanitized: string)`
 * from the fal adapter. Nothing in this module can carry an API key, a raw HTTP
 * body, a request object, a prompt, a credential, a provider URL, or customer
 * metadata, because there is no field for any of them.
 *
 * Expected validation failures are *returned*, not thrown. A price that cannot
 * be computed is an ordinary answer the caller must handle, and `catch` is the
 * wrong shape for it. Unexpected defects still throw.
 */

export type PricingErrorReason =
  // Duration and units
  | "DURATION_NOT_A_POSITIVE_INTEGER"
  | "DURATION_EXCEEDS_PRODUCT_POLICY"
  | "DURATION_NOT_SUPPORTED_BY_PROVIDER"
  // Quantities
  | "QUANTITY_NOT_A_POSITIVE_INTEGER"
  // Customer plan rules
  | "HIGH_QUALITY_ADD_ON_NOT_AVAILABLE_ON_PLAN"
  | "ROUNDED_PRICE_WOULD_BE_UNPROFITABLE"
  // Provider pricing contract
  | "PRICING_CONTRACT_MISSING"
  | "PRICING_CONTRACT_UNVERIFIED"
  | "PRICING_CONTRACT_EXPIRED"
  | "PRICING_CONTRACT_NOT_YET_EFFECTIVE"
  | "PRICING_CONTRACT_PROMOTIONAL_ONLY"
  // FX
  | "FX_SNAPSHOT_CURRENCY_MISMATCH"
  | "FX_SNAPSHOT_RATE_INVALID";

export interface PricingError {
  readonly reason: PricingErrorReason;
}

export function pricingError(reason: PricingErrorReason): PricingError {
  return Object.freeze({ reason });
}

/**
 * A computed pricing answer, or a reason it could not be computed.
 *
 * A discriminated union rather than `T | null`, so a caller that forgets the
 * failure case fails to compile instead of treating "unpriceable" as "free".
 */
export type PricingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PricingError };

export function pricingOk<T>(value: T): PricingResult<T> {
  return { ok: true, value };
}

export function pricingFailure<T>(reason: PricingErrorReason): PricingResult<T> {
  return { ok: false, error: pricingError(reason) };
}
