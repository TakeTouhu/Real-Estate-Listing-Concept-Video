import { describe, expect, it, vi } from "vitest";
import type { RateLimitStore } from "@app/domain";
import { InMemoryRateLimitStore } from "@app/domain/testing";
import { RATE_LIMIT_DEFAULTS, rateLimitSubject, rateLimitSubjectKey } from "@app/shared";

/**
 * The web app's abuse limits (ADR-0171): the refusal's minutes, the keys, and
 * lines logged by code alone, on the in-memory store.
 */
const SECRET = "session-secret-0123456789abcdef";
const prismaUrl = vi.hoisted(() => ({ calls: [] as (string | undefined)[] }));

vi.mock("@app/database", async (original) => ({
  ...(await original<typeof import("@app/database")>()),
  getRateLimitPrismaClient: (url: string | undefined) => {
    prismaUrl.calls.push(url);
    return {};
  },
}));
vi.mock("./env", () => ({
  getServerEnv: () => ({ ...RATE_LIMIT_DEFAULTS, SESSION_SECRET: SECRET, DATABASE_URL: "postgresql://app@db/app" }),
}));

const { getRateLimiter, refusalMessage, refusalMinutes, WebRateLimits } = await import("./rate-limit");

const NOW = new Date("2026-11-25T09:00:00.000Z");
const after = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const subject = (family: "address" | "client" | "user", value: string) =>
  rateLimitSubject(rateLimitSubjectKey(SECRET), family, value);
const limitsWith = (trusted?: string) => {
  const log = { warn: vi.fn() };
  const settings = { ...RATE_LIMIT_DEFAULTS, SESSION_SECRET: SECRET, FORWARDED_FOR_TRUSTED_ENTRIES: trusted };
  return { log, limits: new WebRateLimits(new InMemoryRateLimitStore(), settings, log) };
};
const headers = (forwardedFor?: string) => new Headers(forwardedFor ? { "x-forwarded-for": forwardedFor } : {});

describe("a refusal's text", () => {
  it("names the wait in whole minutes, rounded up, at least one", () => {
    const cases: [number, number][] = [[-5, 1], [0, 1], [1, 1], [60, 1], [61, 2], [899, 15], [900, 15], [3600, 60]];
    for (const [seconds, minutes] of cases) expect(refusalMinutes(after(seconds), NOW)).toBe(minutes);
    expect(refusalMessage("SIGN_IN", after(900), NOW)).toBe("Too many sign-in attempts. Try again in 15 minutes.");
    expect(refusalMessage("MFA_CODE", after(61), NOW)).toBe("Too many wrong codes. Try again in 2 minutes.");
    expect(refusalMessage("MFA_CODE", after(30), NOW)).toBe("Too many wrong codes. Try again in 1 minute.");
  });
});

describe("the keys", () => {
  it("count a typed address as sign-in looks it up, a user by id, each in its own family", () => {
    const { limits } = limitsWith();
    const typed = limits.addressKey("sign-in.address", "  Person@Example.COM ");
    expect(typed).toEqual({
      policy: limits.policies["sign-in.address"],
      subject: subject("address", "person@example.com"),
    });
    expect(limits.userKey("mfa-code.user", "user-1")).toEqual({
      policy: limits.policies["mfa-code.user"],
      subject: subject("user", "user-1"),
    });
    expect(limits.userKey("mfa-code.user", "person@example.com").subject).not.toBe(typed.subject);
  });

  it("count the client address the setting names, and log only why there is none", () => {
    const { limits, log } = limitsWith("2");
    expect(limits.clientKey("sign-in.client", headers("198.51.100.1, 203.0.113.7, 10.0.0.1"))).toEqual({
      policy: limits.policies["sign-in.client"],
      subject: subject("client", "v4:203.0.113.7"),
    });
    expect(log.warn).not.toHaveBeenCalled();
    expect(limits.clientKey("sign-in.client", headers("203.0.113.7"))).toBeUndefined();
    expect(limits.clientKey("sign-in.client", headers("203.0.113.7:80, 10.0.0.1"))).toBeUndefined();
    expect(limits.clientKey("sign-in.client", headers())).toBeUndefined();
    expect(log.warn.mock.calls).toEqual([
      ["A request has no client address", { code: "CLIENT_ADDRESS_UNAVAILABLE", reason: "SHORT_CHAIN" }],
      ["A request has no client address", { code: "CLIENT_ADDRESS_UNAVAILABLE", reason: "MALFORMED" }],
      ["A request has no client address", { code: "CLIENT_ADDRESS_UNAVAILABLE", reason: "MISSING" }],
    ]);
    // Unset, there is no client-address key and nothing to say.
    const unset = limitsWith();
    expect(unset.limits.clientKey("sign-in.client", headers("203.0.113.7"))).toBeUndefined();
    expect(unset.log.warn).not.toHaveBeenCalled();
  });
});

describe("a refusal", () => {
  it("is logged once by its code, action and dimension, never by an address, IP, subject or user", async () => {
    const { limits, log } = limitsWith("1");
    for (let i = 0; i < 5; i += 1) {
      expect((await limits.signIn(headers("203.0.113.7"), `person${i}@example.com`, NOW)).allowed).toBe(true);
    }
    expect(await limits.signIn(headers("203.0.113.7"), "person@example.com", NOW)).toEqual({
      allowed: false,
      message: "Too many sign-in attempts. Try again in 15 minutes.",
    });
    for (let i = 0; i < 5; i += 1) await limits.mfaCode("user-1", NOW);
    expect(await limits.mfaCode("user-1", after(60))).toEqual({
      allowed: false,
      message: "Too many wrong codes. Try again in 15 minutes.",
    });
    expect(log.warn.mock.calls).toEqual([
      ["An attempt was refused by a rate limit", { code: "RATE_LIMITED", action: "SIGN_IN", dimension: "client" }],
      ["An attempt was refused by a rate limit", { code: "RATE_LIMITED", action: "MFA_CODE", dimension: "user" }],
    ]);
    const logged = JSON.stringify(log.warn.mock.calls);
    for (const secret of ["203.0.113.7", "example.com", "user-1", subject("client", "v4:203.0.113.7")]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe("one sign-in's keys", () => {
  /** The in-memory store, recording each call by its policy's last word. */
  const recorded = () => {
    const store = new InMemoryRateLimitStore();
    const calls: string[] = [];
    const word = (policy: { name: string }) => policy.name.slice(policy.name.lastIndexOf(".") + 1);
    const recording: RateLimitStore = {
      hit: (policy, key, now) => (calls.push(`hit ${word(policy)}`), store.hit(policy, key, now)),
      giveBack: (policy, key, at) => (calls.push(`giveBack ${word(policy)}`), store.giveBack(policy, key, at)),
      forget: (policy, key) => (calls.push(`forget ${word(policy)}`), store.forget(policy, key)),
    };
    const settings = { ...RATE_LIMIT_DEFAULTS, SESSION_SECRET: SECRET, FORWARDED_FOR_TRUSTED_ENTRIES: "1" };
    return { calls, limits: new WebRateLimits(recording, settings, { warn: vi.fn() }) };
  };

  it("hit the client address first, and a success forgets the address and gives the client's hit back", async () => {
    const { calls, limits } = recorded();
    const attempt = await limits.signIn(headers("203.0.113.7"), "person@example.com", NOW);
    expect(attempt.allowed).toBe(true);
    if (attempt.allowed) await attempt.succeeded();
    expect(calls).toEqual(["hit client", "hit address", "forget address", "giveBack client"]);
  });

  it("stop at a refusing client address, so the typed address is not counted", async () => {
    const { calls, limits } = recorded();
    for (let i = 0; i < 5; i += 1) await limits.signIn(headers("203.0.113.7"), `person${i}@example.com`, NOW);
    calls.length = 0;
    expect((await limits.signIn(headers("203.0.113.7"), "person@example.com", NOW)).allowed).toBe(false);
    expect(calls).toEqual(["hit client"]);
  });

  it("give the client's hit back when the typed address refuses", async () => {
    const { calls, limits } = recorded();
    for (let i = 0; i < 5; i += 1) await limits.signIn(headers(`203.0.113.${i}`), "person@example.com", NOW);
    calls.length = 0;
    expect((await limits.signIn(headers("203.0.113.7"), "person@example.com", NOW)).allowed).toBe(false);
    expect(calls).toEqual(["hit client", "hit address", "giveBack client"]);
  });
});

describe("the process's limits", () => {
  it("are built once, on the limiter's own client, with a small pool and a statement limit", () => {
    const first = getRateLimiter();
    expect(getRateLimiter()).toBe(first);
    expect(prismaUrl.calls).toEqual([
      "postgresql://app@db/app?connection_limit=3&options=-c+statement_timeout%3D1000",
    ]);
  });
});
