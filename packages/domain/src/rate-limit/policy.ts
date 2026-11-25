import { AppError } from "@app/shared";

/**
 * One abuse limit (ADR-0054 Decision 5, ADR-0169): at most `limit` hits per
 * `windowSeconds` for one subject. The hit after the limit is refused. With a
 * cooldown base above 0 it also starts a cooldown of
 * `min(base * 2^(level - 1), max)` seconds, the level growing while each
 * cooldown starts less than `decaySeconds` after the last one ended. With a
 * base of 0 the subject waits for its window to end, and the cap and decay
 * must be 0 too.
 */
export interface RateLimitPolicy {
  /** Dotted lowercase words, such as `sign-in.account`; the table's CHECK repeats the pattern. */
  readonly name: string;
  readonly limit: number;
  readonly windowSeconds: number;
  readonly cooldownBaseSeconds: number;
  readonly cooldownMaxSeconds: number;
  readonly decaySeconds: number;
}

/** Dotted words of lowercase letters and digits joined by single hyphens, 64 characters at most. */
export const RATE_LIMIT_POLICY_NAME = /^(?=.{3,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/;

/** A subject is an HMAC-SHA-256 in lowercase hex: the store never holds an address or an IP. */
export const RATE_LIMIT_SUBJECT = /^[0-9a-f]{64}$/;

/** The largest count a policy may allow. */
export const RATE_LIMIT_MAX_LIMIT = 99_999;
/** The longest window, cooldown or decay: one year. */
export const RATE_LIMIT_MAX_SECONDS = 31_536_000;

function whole(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/** The policy unchanged, or a refusal naming no value. Every store checks again before it writes. */
export function checkRateLimitPolicy(policy: RateLimitPolicy): RateLimitPolicy {
  const fits =
    typeof policy.name === "string" &&
    RATE_LIMIT_POLICY_NAME.test(policy.name) &&
    whole(policy.limit, 1, RATE_LIMIT_MAX_LIMIT) &&
    whole(policy.windowSeconds, 1, RATE_LIMIT_MAX_SECONDS) &&
    whole(policy.cooldownBaseSeconds, 0, RATE_LIMIT_MAX_SECONDS) &&
    whole(policy.cooldownMaxSeconds, policy.cooldownBaseSeconds, RATE_LIMIT_MAX_SECONDS) &&
    whole(policy.decaySeconds, 0, RATE_LIMIT_MAX_SECONDS) &&
    (policy.cooldownBaseSeconds > 0 || (policy.cooldownMaxSeconds === 0 && policy.decaySeconds === 0));
  if (!fits) throw new AppError("CONFIGURATION_ERROR", "A rate-limit policy is out of range");
  return policy;
}

/** A checked, frozen policy. */
export function rateLimitPolicy(policy: RateLimitPolicy): RateLimitPolicy {
  return Object.freeze({ ...checkRateLimitPolicy(policy) });
}

/** The subject unchanged, or a refusal that does not repeat it. */
export function checkRateLimitSubject(subject: string): string {
  if (typeof subject !== "string" || !RATE_LIMIT_SUBJECT.test(subject)) {
    throw new AppError("INTERNAL_ERROR", "A rate-limit subject must be 64 lowercase hex characters");
  }
  return subject;
}
