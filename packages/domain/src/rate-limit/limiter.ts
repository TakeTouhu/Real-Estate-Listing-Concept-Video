import type { RateLimitPolicy } from "./policy";
import type { RateLimitStore } from "./ports";

/** One counter: a policy and the subject it counts. */
export interface RateLimitKey {
  readonly policy: RateLimitPolicy;
  readonly subject: string;
}

/** A hit a key allowed, with its window, so a success can give it back. */
export interface RateLimitHit extends RateLimitKey {
  readonly windowStartedAt: Date;
}

/** What one attempt's keys decided together. */
export type RateLimiterDecision =
  | { readonly allowed: true; readonly hits: readonly RateLimitHit[] }
  | { readonly allowed: false; readonly retryAt: Date; readonly refusedBy: RateLimitKey };

/**
 * The keys of one attempt, hit together over a store (ADR-0171 Decision
 * 7). Each call stands alone, as the store's do; the clock is the caller's.
 */
export class RateLimiter {
  constructor(private readonly store: RateLimitStore) {}

  /**
   * Hits the keys in the order given, the client address's first. At the
   * first refusal the earlier keys' hits are given back and no later key is
   * hit, so a refused attempt counts against no key but the one that
   * refused, and its wait is the answer. When every key allows the attempt,
   * each one's hit is returned. A store's error is thrown as it came.
   */
  async hit(keys: readonly RateLimitKey[], now: Date): Promise<RateLimiterDecision> {
    const hits: RateLimitHit[] = [];
    for (const key of keys) {
      const decision = await this.store.hit(key.policy, key.subject, now);
      if (!decision.allowed) {
        for (const earlier of hits) await this.giveBack(earlier);
        return { allowed: false, retryAt: decision.retryAt, refusedBy: key };
      }
      hits.push({ policy: key.policy, subject: key.subject, windowStartedAt: decision.windowStartedAt });
    }
    return { allowed: true, hits };
  }

  /** Gives back one hit, as the store does: only within its window and never during a cooldown. */
  giveBack(hit: RateLimitHit): Promise<void> {
    return this.store.giveBack(hit.policy, hit.subject, hit.windowStartedAt);
  }

  /** Forgets one key: its count, its cooldown and its level. */
  forget(key: RateLimitKey): Promise<void> {
    return this.store.forget(key.policy, key.subject);
  }
}
