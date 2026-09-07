import { microUsd, type MicroUsd } from "../pricing/units";

/**
 * The one place a persisted `BIGINT` becomes a domain number.
 *
 * PostgreSQL stores pricing amounts as `BIGINT`, whose range is far wider than
 * JavaScript's safe-integer range. `microUsd(Number(value))` narrows first and
 * validates second, so a value beyond 2^53 is already wrong by the time the
 * pricing domain inspects it — and what the pricing domain does with a value it
 * cannot represent is *throw*, because inside that domain an unsafe integer is a
 * caller defect rather than a datum.
 *
 * At this boundary it is neither. A row holding an unrepresentable amount is a
 * corrupt or hostile financial fact, and the correct answer to one is to refuse
 * the authorization — not to raise `PricingArithmeticError` out of an ordinary
 * gate invocation, where it would surface as a 500 rather than as a refusal and
 * would skip every audit path a refusal takes.
 *
 * So the check happens *before* the narrowing, and the failure is a value:
 * `null` means "this persisted amount is not usable", and every caller in the
 * authorization path turns that into a closed refusal.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/** `null` when the stored value cannot be represented exactly as a number. */
export function persistedIntegerToNumber(value: bigint): number | null {
  if (value > MAX_SAFE || value < MIN_SAFE) return null;
  return Number(value);
}

/** `null` when the stored micro-USD amount is unrepresentable. */
export function persistedMicroUsd(value: bigint): MicroUsd | null {
  const asNumber = persistedIntegerToNumber(value);
  return asNumber === null ? null : microUsd(asNumber);
}
