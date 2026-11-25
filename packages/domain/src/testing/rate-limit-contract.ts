import { rateLimitPolicy, type RateLimitPolicy, type RateLimitStore } from "../rate-limit/index";

/**
 * The rate-limit rule as data (ADR-0169). Every store must pass these
 * cases: the in-memory store runs them in the unit tests, and RD-7b's
 * PostgreSQL store is to run them in the database tests, so the two decide
 * alike. Times are milliseconds after `RATE_LIMIT_CONTRACT_T0`,
 * a date far from today, so a store that reads the system clock fails.
 */
export const RATE_LIMIT_CONTRACT_T0 = new Date("2030-01-01T00:00:00.000Z");

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Sign-in-like: 5 per 15 minutes, then 15, 30, 60, 60 ... minutes; the level forgotten a day after. */
export const RATE_LIMIT_CONTRACT_SIGN_IN = rateLimitPolicy({
  name: "contract.sign-in",
  limit: 5,
  windowSeconds: 900,
  cooldownBaseSeconds: 900,
  cooldownMaxSeconds: 3600,
  decaySeconds: 86_400,
});

/** Email-like: 3 per hour, no cooldown. */
export const RATE_LIMIT_CONTRACT_EMAIL = rateLimitPolicy({
  name: "contract.email",
  limit: 3,
  windowSeconds: 3600,
  cooldownBaseSeconds: 0,
  cooldownMaxSeconds: 0,
  decaySeconds: 0,
});

/** A cooldown shorter than the window: 2 per 10 minutes, then 1 minute. */
export const RATE_LIMIT_CONTRACT_SHORT_COOLDOWN = rateLimitPolicy({
  name: "contract.short-cooldown",
  limit: 2,
  windowSeconds: 600,
  cooldownBaseSeconds: 60,
  cooldownMaxSeconds: 60,
  decaySeconds: 0,
});

/** The longest cooldown, a year at every level: a store must not overflow working out a high level. */
export const RATE_LIMIT_CONTRACT_YEAR = rateLimitPolicy({
  name: "contract.year",
  limit: 1,
  windowSeconds: 1,
  cooldownBaseSeconds: 31_536_000,
  cooldownMaxSeconds: 31_536_000,
  decaySeconds: 31_536_000,
});

const POLICIES = {
  S: RATE_LIMIT_CONTRACT_SIGN_IN,
  E: RATE_LIMIT_CONTRACT_EMAIL,
  C: RATE_LIMIT_CONTRACT_SHORT_COOLDOWN,
  Y: RATE_LIMIT_CONTRACT_YEAR,
} as const;
const SUBJECTS = { s1: "1".repeat(64), s2: "2".repeat(64) } as const;
type PolicyKey = keyof typeof POLICIES;
type SubjectKey = keyof typeof SUBJECTS;

/** One call and, for a hit, what it must decide. `window`, `at` and `retryAt` are offsets from T0. */
export type RateLimitContractStep =
  | {
      readonly op: "hit";
      readonly policy: PolicyKey;
      readonly subject: SubjectKey;
      readonly at: number;
      readonly expect:
        | { readonly allowed: true; readonly count: number; readonly window: number }
        | { readonly allowed: false; readonly retryAt: number };
    }
  | { readonly op: "giveBack"; readonly policy: PolicyKey; readonly subject: SubjectKey; readonly window: number }
  | { readonly op: "forget"; readonly policy: PolicyKey; readonly subject: SubjectKey };

export interface RateLimitContractCase {
  readonly name: string;
  readonly steps: readonly RateLimitContractStep[];
}

function allowed(at: number, count: number, window: number, policy: PolicyKey = "S", subject: SubjectKey = "s1") {
  return { op: "hit", policy, subject, at, expect: { allowed: true, count, window } } as const;
}

function refused(at: number, retryAt: number, policy: PolicyKey = "S", subject: SubjectKey = "s1") {
  return { op: "hit", policy, subject, at, expect: { allowed: false, retryAt } } as const;
}

/** `limit` allowed hits one second apart from `start`, all in the window starting at `start`. */
function fill(start: number, limit = 5, policy: PolicyKey = "S", subject: SubjectKey = "s1") {
  return Array.from({ length: limit }, (_, i) => allowed(start + i * SECOND, i + 1, start, policy, subject));
}

/** A full window from `start`, then the refused hit one second after the last, waiting `seconds`. */
function cycle(start: number, seconds: number): RateLimitContractStep[] {
  const refusal = start + 5 * SECOND;
  return [...fill(start), refused(refusal, refusal + seconds * SECOND)];
}

const DAY = 86_400 * SECOND;
/** After C1's refusal at 5 s, the first cooldown ends here. */
const L = 5 * SECOND + 15 * MINUTE;

function cooldowns(count: number): RateLimitContractStep[] {
  const steps: RateLimitContractStep[] = [];
  let start = 0;
  for (let i = 0; i < count; i += 1) {
    const seconds = [900, 1800][i] ?? 3600;
    steps.push(...cycle(start, seconds));
    start = start + 5 * SECOND + seconds * SECOND;
  }
  return steps;
}

const YEAR = 31_536_000 * SECOND;

/** One allowed hit, then a refusal a millisecond later, cooling down a year, `count` times. */
function years(count: number): RateLimitContractStep[] {
  return Array.from({ length: count }, (_, i) => {
    const start = i * (YEAR + 1);
    return [allowed(start, 1, start, "Y"), refused(start + 1, start + 1 + YEAR, "Y")];
  }).flat();
}

export const RATE_LIMIT_CONTRACT_CASES: readonly RateLimitContractCase[] = [
  { name: "C1: five per window, the sixth refused for the base", steps: cycle(0, 900) },
  {
    name: "C2: refusals in a cooldown change nothing",
    steps: [
      ...cycle(0, 900),
      refused(MINUTE + 5 * SECOND, L),
      refused(L - 1, L),
      ...cycle(L, 1800),
    ],
  },
  { name: "C3: the cooldown ends at its retry time", steps: [...cycle(0, 900), refused(L - 1, L), allowed(L, 1, L)] },
  { name: "C4: the cooldown doubles up to the cap", steps: cooldowns(4) },
  { name: "C5: forty cooldowns in a row stay at the cap", steps: cooldowns(40) },
  {
    name: "C6: the level is forgotten exactly the decay after the cooldown ends",
    steps: [...cycle(0, 900), ...fill(L + DAY - 5 * SECOND), refused(L + DAY, L + DAY + 900 * SECOND)],
  },
  {
    name: "C6 twin: one millisecond earlier the level grows",
    steps: [...cycle(0, 900), ...fill(L + DAY - 5 * SECOND - 1), refused(L + DAY - 1, L + DAY - 1 + 1800 * SECOND)],
  },
  {
    name: "C7: the window is anchored at its first hit",
    steps: [...fill(0), ...fill(900 * SECOND)],
  },
  {
    name: "C7 twin: one millisecond before the window ends",
    steps: [...fill(0), refused(900 * SECOND - 1, 1800 * SECOND - 1)],
  },
  {
    name: "C8: without a cooldown, N per window and no level",
    steps: [
      ...fill(0, 3, "E"),
      refused(3 * SECOND, 3600 * SECOND, "E"),
      refused(4 * SECOND, 3600 * SECOND, "E"),
      ...fill(3600 * SECOND, 3, "E"),
      refused(3603 * SECOND, 7200 * SECOND, "E"),
      allowed(7200 * SECOND, 1, 7200 * SECOND, "E"),
    ],
  },
  {
    name: "C9: giving back returns exactly one hit",
    steps: [
      ...fill(0).slice(0, 4),
      { op: "giveBack", policy: "S", subject: "s1", window: 0 },
      allowed(4 * SECOND, 4, 0),
      allowed(5 * SECOND, 5, 0),
      refused(6 * SECOND, 6 * SECOND + 900 * SECOND),
    ],
  },
  {
    name: "C9 twin: a hit can be given back at the limit itself",
    steps: [
      ...fill(0),
      { op: "giveBack", policy: "S", subject: "s1", window: 0 },
      allowed(5 * SECOND, 5, 0),
      refused(6 * SECOND, 6 * SECOND + 900 * SECOND),
    ],
  },
  {
    name: "C10: giving back stops at 0",
    steps: [
      allowed(0, 1, 0),
      { op: "giveBack", policy: "S", subject: "s1", window: 0 },
      { op: "giveBack", policy: "S", subject: "s1", window: 0 },
      ...fill(SECOND).map((step) => ({ ...step, expect: { ...step.expect, window: 0 } })),
      refused(6 * SECOND, 6 * SECOND + 900 * SECOND),
    ],
  },
  {
    name: "C10 twin: giving back stays in its own window",
    steps: [
      allowed(0, 1, 0),
      allowed(900 * SECOND, 1, 900 * SECOND),
      { op: "giveBack", policy: "S", subject: "s1", window: 0 },
      ...fill(900 * SECOND).slice(1),
      refused(905 * SECOND, 1805 * SECOND),
    ],
  },
  {
    name: "C11: a refusal or a cooldown cannot be given back",
    steps: [
      ...cycle(0, 900),
      { op: "giveBack", policy: "S", subject: "s1", window: 0 },
      { op: "giveBack", policy: "S", subject: "s1", window: L },
      refused(6 * SECOND, L),
      allowed(L, 1, L),
    ],
  },
  {
    name: "C12: forgetting drops the count, the cooldown and the level",
    steps: [
      ...cooldowns(2),
      { op: "forget", policy: "S", subject: "s1" },
      ...cycle(L + 30 * MINUTE, 900),
    ],
  },
  {
    name: "C13: each policy and subject counts on its own",
    steps: [
      ...fill(0, 3),
      ...fill(0, 2, "E"),
      allowed(0, 1, 0, "S", "s2"),
      { op: "forget", policy: "S", subject: "s1" },
      allowed(10 * SECOND, 1, 10 * SECOND),
      allowed(10 * SECOND, 3, 0, "E"),
      allowed(10 * SECOND, 2, 0, "S", "s2"),
    ],
  },
  {
    name: "C13 twin: giving back counts on its own policy and subject",
    steps: [
      ...fill(0, 3),
      ...fill(0, 3, "E"),
      ...fill(0, 5, "S", "s2"),
      { op: "giveBack", policy: "S", subject: "s1", window: 0 },
      refused(10 * SECOND, 3600 * SECOND, "E"),
      refused(10 * SECOND, 910 * SECOND, "S", "s2"),
      allowed(10 * SECOND, 3, 0),
    ],
  },
  {
    name: "C14: a window starts when the cooldown ends, however short",
    steps: [
      ...fill(0, 2, "C"),
      refused(2 * SECOND, 62 * SECOND, "C"),
      ...fill(62 * SECOND, 2, "C"),
      refused(64 * SECOND, 124 * SECOND, "C"),
    ],
  },
  {
    name: "C15: the window after a cooldown starts when the cooldown ends, not at the next hit",
    steps: [
      ...cycle(0, 900),
      ...fill(L + 10 * MINUTE).map((step) => ({ ...step, expect: { ...step.expect, window: L } })),
      allowed(L + 15 * MINUTE, 1, L + 15 * MINUTE),
    ],
  },
  {
    name: "C16: a refusal without a cooldown cannot be given back",
    steps: [
      ...fill(0, 3, "E"),
      refused(3 * SECOND, 3600 * SECOND, "E"),
      { op: "giveBack", policy: "E", subject: "s1", window: 0 },
      { op: "giveBack", policy: "E", subject: "s1", window: 0 },
      refused(4 * SECOND, 3600 * SECOND, "E"),
      allowed(3600 * SECOND, 1, 3600 * SECOND, "E"),
    ],
  },
  { name: "C17: a year's cooldown at a high level stays a year", steps: years(32) },
];

/** Runs one case against a fresh store; returns each step that decided otherwise, empty when all agree. */
export async function replayRateLimitContract(
  store: RateLimitStore,
  contract: RateLimitContractCase,
): Promise<string[]> {
  const t0 = RATE_LIMIT_CONTRACT_T0.getTime();
  const policyOf = (key: PolicyKey): RateLimitPolicy => POLICIES[key];
  const misses: string[] = [];
  for (const [index, step] of contract.steps.entries()) {
    const policy = policyOf(step.policy);
    const subject = SUBJECTS[step.subject];
    if (step.op === "giveBack") {
      await store.giveBack(policy, subject, new Date(t0 + step.window));
      continue;
    }
    if (step.op === "forget") {
      await store.forget(policy, subject);
      continue;
    }
    const decision = await store.hit(policy, subject, new Date(t0 + step.at));
    const got = decision.allowed
      ? { allowed: true, count: decision.count, window: decision.windowStartedAt.getTime() - t0 }
      : { allowed: false, retryAt: decision.retryAt.getTime() - t0 };
    if (JSON.stringify(got) !== JSON.stringify(step.expect)) {
      misses.push(`step ${index} at ${step.at}: expected ${JSON.stringify(step.expect)}, got ${JSON.stringify(got)}`);
    }
  }
  return misses;
}
