/**
 * Read a persisted pricing identity back as the domain's own shape.
 *
 * A `GenerationPricingSnapshot.identityJson` column is `Json`. Prisma types it
 * as `JsonValue`, which is honest — the database cannot promise the seven
 * dimensions are present, are strings, or were written by this application at
 * all. Casting it to `ProviderPricingIdentity` and reading fields off it is the
 * bug this exists to remove: a row corrupted, partially migrated or written by
 * an older shape would be silently re-used to price a *new paid attempt*.
 *
 * So the value is parsed, not asserted. Every dimension the domain defines is
 * required, each must be a non-empty string, and nothing else about the object
 * is read. A malformed identity is an ordinary returned failure, and the
 * failure carries a closed reason — never the offending JSON, which can contain
 * whatever a corrupt row happens to hold.
 *
 * There is deliberately one definition of the identity and one parser for it.
 * A second, looser reader would eventually disagree with this one about whether
 * a row is usable, and the looser answer would win wherever it was called.
 */

import { pricingFailure, pricingOk, type PricingResult } from "./errors";
import { IDENTITY_DIMENSION_NAMES, type ProviderPricingIdentity } from "./provider-pricing-contract";

/**
 * Parse an untrusted persisted value into a complete pricing identity.
 *
 * Returns a failure rather than throwing: a corrupt historical row is a state
 * the caller must handle — by refusing to plan against it — not an assertion
 * violation in the parser.
 */
export function parseProviderPricingIdentity(
  value: unknown,
): PricingResult<ProviderPricingIdentity> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return pricingFailure("PRICING_IDENTITY_MALFORMED");
  }
  const record = value as Record<string, unknown>;

  // Every dimension the domain defines, read from the one canonical list, so a
  // future dimension cannot be added to the identity and quietly skipped here.
  const parsed: Record<string, string> = {};
  for (const name of IDENTITY_DIMENSION_NAMES) {
    const field = record[name];
    if (typeof field !== "string" || field.length === 0) {
      return pricingFailure("PRICING_IDENTITY_MALFORMED");
    }
    parsed[name] = field;
  }

  return pricingOk({
    provider: parsed.provider as string,
    pricingModelKey: parsed.pricingModelKey as string,
    generationMode: parsed.generationMode as string,
    nativeTier: parsed.nativeTier as string,
    audioMode: parsed.audioMode as string,
    durationBillingRuleId: parsed.durationBillingRuleId as string,
    pricingVersion: parsed.pricingVersion as string,
  });
}
