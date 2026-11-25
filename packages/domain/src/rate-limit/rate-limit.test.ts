import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import {
  InMemoryRateLimitStore,
  RATE_LIMIT_CONTRACT_CASES,
  RATE_LIMIT_CONTRACT_SIGN_IN,
  replayRateLimitContract,
} from "../testing/index";
import { checkRateLimitPolicy, rateLimitPolicy, RATE_LIMIT_POLICY_NAME, type RateLimitPolicy } from "./index";

/**
 * The abuse limiter's rule (ADR-0169). The contract cases are the rule; the
 * in-memory store runs them here, PostgreSQL in the database tests.
 */

const VALID: RateLimitPolicy = {
  name: "sign-in.account",
  limit: 5,
  windowSeconds: 900,
  cooldownBaseSeconds: 900,
  cooldownMaxSeconds: 3600,
  decaySeconds: 86_400,
};

const OUT_OF_RANGE = new AppError("CONFIGURATION_ERROR", "A rate-limit policy is out of range");

describe("the rule, on the in-memory store", () => {
  it.each(RATE_LIMIT_CONTRACT_CASES.map((contract) => [contract.name, contract] as const))(
    "%s",
    async (_name, contract) => {
      expect(await replayRateLimitContract(new InMemoryRateLimitStore(), contract)).toEqual([]);
    },
  );

  it("notices a store that decides otherwise", async () => {
    // A store that allows everything must fail the cases, or the replay proves nothing.
    const lenient = {
      hit: async (_policy: RateLimitPolicy, _subject: string, now: Date) =>
        ({ allowed: true, windowStartedAt: now, count: 1 }) as const,
      giveBack: async () => undefined,
      forget: async () => undefined,
    };
    const misses = await Promise.all(RATE_LIMIT_CONTRACT_CASES.map((c) => replayRateLimitContract(lenient, c)));
    expect(misses.every((list) => list.length > 0)).toBe(true);
  });
});

describe("a policy", () => {
  it("is checked and frozen", () => {
    const policy = rateLimitPolicy(VALID);
    expect(policy).toEqual(VALID);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(checkRateLimitPolicy(VALID)).toBe(VALID);
    expect(rateLimitPolicy({ ...VALID, cooldownBaseSeconds: 0, cooldownMaxSeconds: 0, decaySeconds: 0 })).toBeTruthy();
    expect(rateLimitPolicy({ ...VALID, limit: 99_999, windowSeconds: 31_536_000 })).toBeTruthy();
  });

  it.each<[string, Partial<RateLimitPolicy>]>([
    ["a limit of 0", { limit: 0 }],
    ["a limit over 99,999", { limit: 100_000 }],
    ["a fractional limit", { limit: 2.5 }],
    ["a window of 0", { windowSeconds: 0 }],
    ["a window over a year", { windowSeconds: 31_536_001 }],
    ["a negative cooldown", { cooldownBaseSeconds: -1 }],
    ["a cap below the base", { cooldownMaxSeconds: 899 }],
    ["a negative decay", { decaySeconds: -1 }],
    ["a fractional decay", { decaySeconds: 0.5 }],
    ["a number that is not one", { windowSeconds: Number.NaN }],
    ["a name out of pattern", { name: "SignIn.account" }],
    ["a cap without a cooldown", { cooldownBaseSeconds: 0, cooldownMaxSeconds: 60, decaySeconds: 0 }],
    ["a decay without a cooldown", { cooldownBaseSeconds: 0, cooldownMaxSeconds: 0, decaySeconds: 60 }],
  ])("refuses %s before any store is asked", async (_reason, change) => {
    const policy = { ...VALID, ...change };
    expect(() => rateLimitPolicy(policy)).toThrow(OUT_OF_RANGE);
    await expect(new InMemoryRateLimitStore().hit(policy, "a".repeat(64), new Date())).rejects.toThrow(OUT_OF_RANGE);
  });

  it("is named by dotted lowercase words, as the table's CHECK will require", () => {
    const names = ["sign-in.account", "password-reset-email.ip", "mfa-code.user", "a.b", `a.${"b".repeat(62)}`];
    for (const name of names) {
      expect(RATE_LIMIT_POLICY_NAME.test(name)).toBe(true);
    }
    const refused = ["SignIn.account", "sign-in", "a..b", ".a.b", "a.b.", "a-.b", "a--b.c", "1a.b"];
    refused.push(`a.${"b".repeat(63)}`);
    for (const name of refused) {
      expect(RATE_LIMIT_POLICY_NAME.test(name)).toBe(false);
    }
  });
});

describe("a subject", () => {
  it("is 64 lowercase hex characters, and a refusal does not repeat it", async () => {
    const store = new InMemoryRateLimitStore();
    const now = new Date("2030-01-01T00:00:00.000Z");
    expect((await store.hit(RATE_LIMIT_CONTRACT_SIGN_IN, "0f".repeat(32), now)).allowed).toBe(true);
    for (const subject of ["owner@example.test", "203.0.113.7", "A".repeat(64), "a".repeat(63), "a".repeat(65), ""]) {
      for (const call of [
        () => store.hit(RATE_LIMIT_CONTRACT_SIGN_IN, subject, now),
        () => store.giveBack(RATE_LIMIT_CONTRACT_SIGN_IN, subject, now),
        () => store.forget(RATE_LIMIT_CONTRACT_SIGN_IN, subject),
      ]) {
        const error = await call().catch((thrown: unknown) => thrown);
        const refusal = new AppError("INTERNAL_ERROR", "A rate-limit subject must be 64 lowercase hex characters");
        expect(error).toEqual(refusal);
        if (subject !== "") expect((error as Error).message).not.toContain(subject);
      }
    }
  });
});
