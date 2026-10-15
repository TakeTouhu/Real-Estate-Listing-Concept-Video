import { hotp, timingSafeEqualString } from "@app/shared";

/** RFC 6238 with the settings every authenticator app supports: SHA-1, 6 digits, 30 seconds. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps either side of the current one a code is accepted for, for clock drift. */
export const TOTP_DRIFT_STEPS = 1;

export function totpStep(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * The step `code` was made for, within the drift window around `at` and later
 * than `afterStep`; null if none.
 */
export function matchTotp(secret: Uint8Array, code: string, at: Date, afterStep: number | null): number | null {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const current = totpStep(at);
  let matched: number | null = null;
  for (let step = current - TOTP_DRIFT_STEPS; step <= current + TOTP_DRIFT_STEPS; step += 1) {
    if (afterStep !== null && step <= afterStep) continue;
    if (timingSafeEqualString(hotp(secret, step, TOTP_DIGITS), digits)) matched = step;
  }
  return matched;
}
