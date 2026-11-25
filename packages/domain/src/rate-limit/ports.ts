import type { RateLimitPolicy } from "./policy";

/**
 * What one hit decided. An allowed hit names its window, which a success
 * hands back to `giveBack`; a refused one says when the subject may try
 * again.
 */
export type RateLimitDecision =
  | { readonly allowed: true; readonly windowStartedAt: Date; readonly count: number }
  | { readonly allowed: false; readonly retryAt: Date };

/**
 * Counters for abuse limits, one per (policy, subject) (ADR-0169). Every
 * attempt is a hit before the step it guards; only a success gives anything
 * back. Each call stands alone: a store never joins a caller's transaction.
 */
export interface RateLimitStore {
  /** Counts one attempt at `now`, the caller's clock, and decides it. */
  hit(policy: RateLimitPolicy, subject: string, now: Date): Promise<RateLimitDecision>;
  /**
   * Takes back one hit the window starting at `windowStartedAt` allowed,
   * while that is still the counter's window and its count is between 1 and
   * the limit: never below 0, during a cooldown or after a refusal.
   */
  giveBack(policy: RateLimitPolicy, subject: string, windowStartedAt: Date): Promise<void>;
  /** Forgets the subject under the policy: its count, its cooldown and its level. */
  forget(policy: RateLimitPolicy, subject: string): Promise<void>;
}
