import { describe, expect, it } from "vitest";
import { RATE_LIMIT_DEFAULTS, rateLimitSubject, rateLimitSubjectKey } from "@app/shared";
import { InMemoryRateLimitStore } from "../testing/index";
import {
  checkRateLimitSubject,
  rateLimitPolicies,
  rateLimitPolicy,
  RateLimiter,
  type RateLimitKey,
  type RateLimitStore,
} from "./index";

/** A store that records each call, in order, before the in-memory one answers it. */
function recording(failOn?: "hit" | "giveBack") {
  const inner = new InMemoryRateLimitStore();
  const calls: string[] = [];
  const store: RateLimitStore = {
    hit: async (policy, subject, now) => {
      calls.push(`hit ${policy.name}`);
      if (failOn === "hit") throw new Error("the store is down");
      return inner.hit(policy, subject, now);
    },
    giveBack: async (policy, subject, windowStartedAt) => {
      calls.push(`giveBack ${policy.name}`);
      if (failOn === "giveBack") throw new Error("the store is down");
      return inner.giveBack(policy, subject, windowStartedAt);
    },
    forget: async (policy, subject) => {
      calls.push(`forget ${policy.name}`);
      return inner.forget(policy, subject);
    },
  };
  return { store, calls, inner };
}

describe("RateLimiter", () => {
  const NOW = new Date("2026-11-25T09:00:00.000Z");
  const later = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);
  // The sign-in policies with small limits: 3 for the client address, 2 for the address.
  const policies = rateLimitPolicies({ ...RATE_LIMIT_DEFAULTS, RATE_LIMIT_SIGN_IN: "3/900" });
  const subjectKey = rateLimitSubjectKey("session-secret-abcdef123456");
  const client: RateLimitKey = {
    policy: policies["sign-in.client"],
    subject: rateLimitSubject(subjectKey, "client", "v4:203.0.113.7"),
  };
  const address: RateLimitKey = {
    policy: rateLimitPolicy({ ...policies["sign-in.address"], limit: 2 }),
    subject: rateLimitSubject(subjectKey, "address", "person@example.com"),
  };

  it("counts subjects the store takes", () => {
    for (const key of [client, address]) expect(checkRateLimitSubject(key.subject)).toBe(key.subject);
  });

  it("hits the keys in the order given and returns each one's hit when all allow", async () => {
    const { store, calls } = recording();
    const limiter = new RateLimiter(store);
    const decision = await limiter.hit([client, address], NOW);
    expect(decision).toEqual({
      allowed: true,
      hits: [
        { ...client, windowStartedAt: NOW },
        { ...address, windowStartedAt: NOW },
      ],
    });
    expect(calls).toEqual(["hit sign-in.client", "hit sign-in.address"]);
    expect(await limiter.hit([], NOW)).toEqual({ allowed: true, hits: [] });
  });

  it("gives back the earlier keys' hits when a later key refuses, with the refusing key's wait", async () => {
    const { store, calls, inner } = recording();
    const limiter = new RateLimiter(store);
    // The address key at its limit: two attempts from elsewhere.
    for (let i = 0; i < 2; i += 1) await inner.hit(address.policy, address.subject, NOW);
    await inner.hit(client.policy, client.subject, NOW);
    const refused = await limiter.hit([client, address], later(1));
    // The third hit on the address starts its cooldown, the window's length, from the refused attempt.
    expect(refused).toEqual({ allowed: false, retryAt: later(901), refusedBy: address });
    expect(calls).toEqual(["hit sign-in.client", "hit sign-in.address", "giveBack sign-in.client"]);
    // The client's count is back at one: two more are allowed, and the next is refused.
    expect((await inner.hit(client.policy, client.subject, later(2))).allowed).toBe(true);
    expect(await inner.hit(client.policy, client.subject, later(3))).toMatchObject({ allowed: true, count: 3 });
    expect((await inner.hit(client.policy, client.subject, later(4))).allowed).toBe(false);
  });

  it("hits no later key when the first refuses", async () => {
    const { store, calls, inner } = recording();
    const limiter = new RateLimiter(store);
    for (let i = 0; i < 3; i += 1) await inner.hit(client.policy, client.subject, NOW);
    const refused = await limiter.hit([client, address], NOW);
    expect(refused).toEqual({ allowed: false, retryAt: later(900), refusedBy: client });
    expect(calls).toEqual(["hit sign-in.client"]);
    // The address key was never counted.
    expect(await inner.hit(address.policy, address.subject, NOW)).toMatchObject({ allowed: true, count: 1 });
  });

  it("passes a give-back and a forget through to the store", async () => {
    const { store, calls, inner } = recording();
    const limiter = new RateLimiter(store);
    const decision = await limiter.hit([client, address], NOW);
    if (!decision.allowed) throw new Error("expected the attempt to be allowed");
    const [clientHit] = decision.hits;
    if (clientHit === undefined) throw new Error("expected the client's hit");
    await limiter.giveBack(clientHit);
    await limiter.forget(address);
    expect(calls.slice(2)).toEqual(["giveBack sign-in.client", "forget sign-in.address"]);
    expect(await inner.hit(client.policy, client.subject, NOW)).toMatchObject({ count: 1 });
    expect(await inner.hit(address.policy, address.subject, NOW)).toMatchObject({ count: 1 });
  });

  it("throws a store's error as it came, from a hit or from a give-back", async () => {
    await expect(new RateLimiter(recording("hit").store).hit([client], NOW)).rejects.toThrow("the store is down");
    const failing = recording("giveBack");
    for (let i = 0; i < 2; i += 1) await failing.inner.hit(address.policy, address.subject, NOW);
    await expect(new RateLimiter(failing.store).hit([client, address], NOW)).rejects.toThrow("the store is down");
  });
});
