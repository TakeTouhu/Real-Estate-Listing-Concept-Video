/**
 * The integer units every pricing contract is expressed in, and the exact
 * arithmetic over them.
 *
 * Floating point is not usable for contract money. `0.1 + 0.2 !== 0.3`, and a
 * pricing engine that is wrong in the seventh decimal place is wrong about
 * whether a configuration loses money. So nothing here stores `0.08`, `1.2` or
 * `0.05`: prices are integers in their smallest unit and every rate is basis
 * points.
 *
 * The three units are deliberately distinct nominal types. Micro-USD and yen
 * are both "integers" to JavaScript, and a provider cost accidentally added to
 * a customer price would type-check without this.
 */

declare const microUsdBrand: unique symbol;
declare const yenBrand: unique symbol;
declare const bpsBrand: unique symbol;
declare const epochMillisBrand: unique symbol;

/** United States dollars in millionths. `$0.08` is `80_000`. */
export type MicroUsd = number & { readonly [microUsdBrand]: "MicroUsd" };

/** Japanese yen, whole. The yen has no minor unit, so this is the minor unit. */
export type Yen = number & { readonly [yenBrand]: "Yen" };

/** Basis points: hundredths of a percent. `30%` is `3_000`, `1.20x` is `12_000`. */
export type Bps = number & { readonly [bpsBrand]: "Bps" };

/**
 * An instant, as integer milliseconds since the Unix epoch.
 *
 * Deliberately **not** a `Date`. `Object.freeze` protects a reference, not the
 * object behind it, so a deeply frozen pricing contract holding a `Date` still
 * hands every consumer something they can rewrite with `setTime` — and a
 * "past decision" whose effective instant can be moved is not a record. A
 * number cannot be mutated by anyone.
 */
export type EpochMillis = number & { readonly [epochMillisBrand]: "EpochMillis" };

/** One hundred percent, and the denominator of every basis-point calculation. */
export const ONE_HUNDRED_PERCENT_BPS = 10_000;

/** Thrown for a defect in a *caller*, not for an expected pricing outcome. */
class PricingArithmeticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingArithmeticError";
  }
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    // No value is interpolated: a defect message is not a place to echo inputs.
    throw new PricingArithmeticError(`${label} must be a safe integer`);
  }
}

export function microUsd(value: number): MicroUsd {
  assertSafeInteger(value, "micro-USD amount");
  return value as MicroUsd;
}

export function yen(value: number): Yen {
  assertSafeInteger(value, "yen amount");
  return value as Yen;
}

export function epochMillis(value: number): EpochMillis {
  assertSafeInteger(value, "epoch milliseconds");
  return value as EpochMillis;
}

/** Convert at the outer boundary, where a `Date` is still convenient. */
export function epochMillisFromDate(value: Date): EpochMillis {
  return epochMillis(value.getTime());
}

export function bps(value: number): Bps {
  assertSafeInteger(value, "basis points");
  return value as Bps;
}

/**
 * `value × numerator / denominator`, rounded half away from zero.
 *
 * `BigInt` for the product, not `number`. A yen amount multiplied by basis
 * points is routinely in the billions — an annual Enterprise contract times a
 * multiplier already exceeds 3.5×10¹² — and while that still fits a double
 * today, "still fits" is not a property to depend on when the failure mode is a
 * silently wrong price. The result is range-checked on the way back out.
 *
 * Rounding is half away from zero rather than JavaScript's `Math.round`, which
 * rounds half *up* and is therefore asymmetric about zero. Every frozen figure
 * in this phase divides exactly; the mode matters only for values that do not,
 * and an asymmetric one would make a refund behave differently from a charge.
 */
function mulDiv(value: number, numerator: number, denominator: number): number {
  assertSafeInteger(denominator, "denominator");
  if (denominator === 0) throw new PricingArithmeticError("denominator must not be zero");
  return mulDivBig(value, numerator, BigInt(denominator));
}

/**
 * The same arithmetic, with the denominator already formed as a `BigInt`.
 *
 * Exists because a denominator can be a *product* — an exchange rate's
 * denominator times the millionth that converts micro-USD to USD — and forming
 * that product as a `number` can leave the safe-integer range even when both
 * factors are comfortably inside it. That threw `PricingArithmeticError` from
 * inside the arithmetic, turning a merely large input into an unhandled defect
 * rather than a pricing answer. Composing the denominator in `BigInt` removes
 * the intermediate entirely.
 */
function mulDivBig(value: number, numerator: number, den: bigint): number {
  assertSafeInteger(value, "operand");
  assertSafeInteger(numerator, "numerator");
  if (den === 0n) throw new PricingArithmeticError("denominator must not be zero");

  const product = BigInt(value) * BigInt(numerator);
  const quotient = product / den;
  const remainder = product % den;
  const twiceRemainder = (remainder < 0n ? -remainder : remainder) * 2n;
  const roundsAway = twiceRemainder >= (den < 0n ? -den : den);
  const sign = product < 0n !== den < 0n ? -1n : 1n;
  const result = roundsAway ? quotient + sign : quotient;

  const asNumber = Number(result);
  assertSafeInteger(asNumber, "result");
  return asNumber;
}

/** `amount × rate`, where `rate` is basis points. `applyBps(400_000, 13_000)` is `520_000`. */
export function applyBpsToMicroUsd(amount: MicroUsd, rate: Bps): MicroUsd {
  return microUsd(mulDiv(amount, rate, ONE_HUNDRED_PERCENT_BPS));
}

export function applyBpsToYen(amount: Yen, rate: Bps): Yen {
  return yen(mulDiv(amount, rate, ONE_HUNDRED_PERCENT_BPS));
}

/**
 * `amount × numerator / denominator` in yen, in **one** exact step.
 *
 * The reason this exists rather than two chained calls: an add-on price is
 * `planPrice ÷ includedUnits × multiplier × quantity`, and rounding the
 * per-unit value before multiplying gives a different total. Premium's
 * high-quality unit is ¥4,492.5 exactly — round it either way and two units
 * come to ¥8,986 or ¥8,984 instead of ¥8,985. Callers pass the whole fraction.
 */
export function scaleYen(amount: Yen, numerator: number, denominator: number): Yen {
  return yen(mulDiv(amount, numerator, denominator));
}

/**
 * `amount × numerator / (denominator × scale)`, the denominator formed in BigInt.
 *
 * The exchange-rate case. Writing it as `scaleYen(amount, numerator,
 * denominator * scale)` looks equivalent and is not: `denominator × 1,000,000`
 * can exceed the safe-integer range while the denominator itself is a perfectly
 * ordinary positive integer, and the arithmetic would then reject an input it
 * had already accepted. Here the product never becomes a `number` at all.
 */
export function scaleYenByRate(
  amount: Yen,
  numerator: number,
  denominator: number,
  scale: number,
): Yen {
  assertSafeInteger(denominator, "denominator");
  assertSafeInteger(scale, "scale");
  return yen(mulDivBig(amount, numerator, BigInt(denominator) * BigInt(scale)));
}

export function multiplyMicroUsd(amount: MicroUsd, factor: number): MicroUsd {
  assertSafeInteger(factor, "factor");
  return microUsd(mulDiv(amount, factor, 1));
}

/** Nearest ¥100, half away from zero: ¥8,985 → ¥9,000, ¥8,949 → ¥8,900. */
export function roundYenToNearestHundred(amount: Yen): Yen {
  return yen(mulDiv(mulDiv(amount, 1, 100), 100, 1));
}

/** Next ¥100 at or above `amount` — the safe direction when rounding down would lose money. */
export function roundYenUpToHundred(amount: Yen): Yen {
  return yen(Math.ceil(amount / 100) * 100);
}

/**
 * `part / whole` as basis points, or `null` when there is no whole to divide by.
 *
 * `null` rather than zero or infinity: a margin on zero revenue is undefined,
 * and reporting it as `0 bps` would read as "breaking even".
 */
export function ratioToBps(part: Yen, whole: Yen): Bps | null {
  if (whole === 0) return null;
  return bps(mulDiv(part, ONE_HUNDRED_PERCENT_BPS, whole));
}

export function maxYen(a: Yen, b: Yen): Yen {
  return a >= b ? a : b;
}
