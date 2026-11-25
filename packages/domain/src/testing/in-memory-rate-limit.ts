import {
  checkRateLimitPolicy,
  checkRateLimitSubject,
  type RateLimitDecision,
  type RateLimitPolicy,
  type RateLimitStore,
} from "../rate-limit/index";

/** One counter as the table keeps it (ADR-0169). */
interface Counter {
  windowStartedAt: number;
  count: number;
  lockedUntil: number | null;
  lockLevel: number;
}

const SECOND = 1000;

/**
 * The rule in TypeScript, as the counters table runs it in one statement:
 * the decision is made from the row as it was.
 */
function next(policy: RateLimitPolicy, row: Counter | undefined, now: number): Counter {
  if (row === undefined) return { windowStartedAt: now, count: 1, lockedUntil: null, lockLevel: 0 };
  const locked = row.lockedUntil !== null && row.lockedUntil > now;
  if (locked) return row;
  const window = policy.windowSeconds * SECOND;
  if (now >= row.windowStartedAt + window) return { ...row, windowStartedAt: now, count: 1 };
  if (row.count < policy.limit) return { ...row, count: row.count + 1 };
  if (policy.cooldownBaseSeconds === 0) return { ...row, count: policy.limit + 1 };
  const decay = policy.decaySeconds * SECOND;
  const level = row.lockedUntil !== null && now < row.lockedUntil + decay ? row.lockLevel + 1 : 1;
  // 2^25 is above every cap-to-base ratio a policy allows, so the clamp changes no answer; it keeps the number small.
  const cooldown = Math.min(policy.cooldownBaseSeconds * 2 ** Math.min(level - 1, 25), policy.cooldownMaxSeconds);
  const lockedUntil = now + cooldown * SECOND;
  return { windowStartedAt: lockedUntil, count: 0, lockedUntil, lockLevel: level };
}

/** Counters in memory, deciding as the PostgreSQL store does; the contract cases hold both to one rule. */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly counters = new Map<string, Counter>();

  private static key(policy: RateLimitPolicy, subject: string): string {
    return `${checkRateLimitPolicy(policy).name}\u0000${checkRateLimitSubject(subject)}`;
  }

  async hit(policy: RateLimitPolicy, subject: string, now: Date): Promise<RateLimitDecision> {
    const key = InMemoryRateLimitStore.key(policy, subject);
    const at = now.getTime();
    const row = next(policy, this.counters.get(key), at);
    this.counters.set(key, row);
    const locked = row.lockedUntil !== null && row.lockedUntil > at;
    if (!locked && row.count <= policy.limit) {
      return { allowed: true, windowStartedAt: new Date(row.windowStartedAt), count: row.count };
    }
    const windowEnd = row.windowStartedAt + policy.windowSeconds * SECOND;
    const retryAt = locked && row.lockedUntil !== null ? row.lockedUntil : windowEnd;
    return { allowed: false, retryAt: new Date(retryAt) };
  }

  async giveBack(policy: RateLimitPolicy, subject: string, windowStartedAt: Date): Promise<void> {
    const key = InMemoryRateLimitStore.key(policy, subject);
    const row = this.counters.get(key);
    if (row === undefined || row.windowStartedAt !== windowStartedAt.getTime()) return;
    if (row.count < 1 || row.count > policy.limit) return;
    this.counters.set(key, { ...row, count: row.count - 1 });
  }

  async forget(policy: RateLimitPolicy, subject: string): Promise<void> {
    this.counters.delete(InMemoryRateLimitStore.key(policy, subject));
  }
}
