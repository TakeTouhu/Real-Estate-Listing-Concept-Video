import { isRateLimitValue, type RateLimitSetting } from "@app/shared";
import { rateLimitPolicy, type RateLimitPolicy } from "./policy";

/**
 * The growing cooldown of sign-in, both keys, and of wrong MFA codes
 * (ADR-0170): its base is the limit's window, it doubles with each cooldown
 * that follows another, up to `maxSeconds`, and its level is forgotten
 * `decaySeconds` after a cooldown ends. A window longer than `maxSeconds`
 * is the cap instead, as a cap is never below its base. The emails have no
 * cooldown: each waits for its window to end.
 */
export const RATE_LIMIT_COOLDOWN = Object.freeze({ maxSeconds: 3_600, decaySeconds: 86_400 });

/** The six limits RD-7 keeps, each named by what it limits and the subject it counts (ADR-0170). */
export const RATE_LIMIT_POLICY_NAMES = [
  "sign-in.address",
  "sign-in.client",
  "mfa-code.user",
  "password-reset-email.address",
  "password-reset-email.client",
  "verification-email.address",
] as const;

export type RateLimitPolicyName = (typeof RATE_LIMIT_POLICY_NAMES)[number];

export type RateLimitPolicies = Readonly<Record<RateLimitPolicyName, RateLimitPolicy>>;

/**
 * One policy from its setting's `count/seconds`. A text out of that form is
 * read as a limit of 0, which the policy check refuses with its own error.
 */
function policyOf(name: RateLimitPolicyName, text: string, cooldown: boolean): RateLimitPolicy {
  const [limit = 0, windowSeconds = 0] = isRateLimitValue(text) ? text.split("/").map(Number) : [];
  return rateLimitPolicy({
    name,
    limit,
    windowSeconds,
    cooldownBaseSeconds: cooldown ? windowSeconds : 0,
    cooldownMaxSeconds: cooldown ? Math.max(RATE_LIMIT_COOLDOWN.maxSeconds, windowSeconds) : 0,
    decaySeconds: cooldown ? RATE_LIMIT_COOLDOWN.decaySeconds : 0,
  });
}

/** The six policies, checked and frozen, from the five settings as the environment's schema read them. */
export function rateLimitPolicies(settings: Readonly<Record<RateLimitSetting, string>>): RateLimitPolicies {
  return Object.freeze({
    "sign-in.address": policyOf("sign-in.address", settings.RATE_LIMIT_SIGN_IN, true),
    "sign-in.client": policyOf("sign-in.client", settings.RATE_LIMIT_SIGN_IN, true),
    "mfa-code.user": policyOf("mfa-code.user", settings.RATE_LIMIT_MFA_CODE, true),
    "password-reset-email.address": policyOf(
      "password-reset-email.address",
      settings.RATE_LIMIT_PASSWORD_RESET_EMAIL,
      false,
    ),
    "password-reset-email.client": policyOf(
      "password-reset-email.client",
      settings.RATE_LIMIT_PASSWORD_RESET_EMAIL_PER_IP,
      false,
    ),
    "verification-email.address": policyOf("verification-email.address", settings.RATE_LIMIT_VERIFICATION_EMAIL, false),
  });
}
