import { describe, expect, it, vi } from "vitest";
import type { RateLimitStore } from "@app/domain";
import { InMemoryRateLimitStore } from "@app/domain/testing";
import { AppError, RATE_LIMIT_DEFAULTS, rateLimitSubject, rateLimitSubjectKey } from "@app/shared";

/**
 * The web app's abuse limits (ADR-0171, ADR-0172): the refusal's minutes, the
 * keys, and lines logged by code alone, on the in-memory store.
 */
const SECRET = "session-secret-0123456789abcdef";
const prismaUrl = vi.hoisted(() => ({ calls: [] as (string | undefined)[] }));

vi.mock("@app/database", async (original) => ({
  ...(await original<typeof import("@app/database")>()),
  getRateLimitPrismaClient: (url: string | undefined) => {
    prismaUrl.calls.push(url);
    return {};
  },
  getSignedInRateLimitPrismaClient: (url: string | undefined) => {
    prismaUrl.calls.push(`signed in: ${url}`);
    return {};
  },
}));
vi.mock("./env", () => ({
  getServerEnv: () => ({ ...RATE_LIMIT_DEFAULTS, SESSION_SECRET: SECRET, DATABASE_URL: "postgresql://app@db/app" }),
}));

const {
  getRateLimiter,
  limitJsonRequest,
  refusalMessage,
  refusalMinutes,
  retryAfterSeconds,
  WebRateLimits,
  withoutLimiterText,
} = await import("./rate-limit");

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
    expect(refusalMessage("SIGN_UP", after(3600), NOW)).toBe("Too many sign-ups. Try again in 60 minutes.");
  });

  it("agrees with the seconds a JSON refusal waits, and reads in hours above 120 minutes for RD-8 only", () => {
    const cases: [number, number, string][] = [
      [59, 59, "1 minute"],
      [60, 60, "1 minute"],
      [61, 61, "2 minutes"],
      [7200, 7200, "120 minutes"],
      [7201, 7201, "3 hours"],
      [86_399.5, 86_400, "24 hours"],
    ];
    for (const [wait, seconds, text] of cases) {
      expect(retryAfterSeconds(after(wait), NOW)).toBe(seconds);
      expect(refusalMessage("UPLOAD", after(wait), NOW)).toBe(`Too many uploads. Try again in ${text}.`);
    }
    expect(retryAfterSeconds(after(-5), NOW)).toBe(1);
    expect(refusalMessage("SIGN_UP", after(7201), NOW)).toBe("Too many sign-ups. Try again in 3 hours.");
    expect(refusalMessage("INVITATION", after(7201), NOW)).toBe("Too many invitations. Try again in 3 hours.");
    expect(refusalMessage("SIGN_IN", after(7201), NOW)).toBe("Too many sign-in attempts. Try again in 121 minutes.");
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
    for (let i = 0; i < 3; i += 1) await limits.passwordResetEmail(headers("198.51.100.1"), "person@example.com", NOW);
    expect(await limits.passwordResetEmail(headers("198.51.100.1"), "person@example.com", after(61))).toEqual({
      allowed: false,
      minutes: 59,
    });
    for (let i = 0; i < 3; i += 1) await limits.verificationEmail("person@example.com", NOW);
    expect(await limits.verificationEmail("person@example.com", NOW)).toEqual({ allowed: false, minutes: 60 });
    for (let i = 0; i < 60; i += 1) expect((await limits.signUp(headers("198.51.100.9"), NOW)).allowed).toBe(true);
    expect(await limits.signUp(headers("198.51.100.9"), after(60))).toEqual({
      allowed: false,
      message: "Too many sign-ups. Try again in 59 minutes.",
    });
    for (let i = 0; i < 1000; i += 1) expect((await limits.account("UPLOAD", "user-1", NOW)).allowed).toBe(true);
    expect(await limits.account("UPLOAD", "user-1", after(3600))).toEqual({
      allowed: false,
      message: "Too many uploads. Try again in 23 hours.",
      seconds: 82_800,
    });
    expect(log.warn.mock.calls).toEqual([
      ["An attempt was refused by a rate limit", { code: "RATE_LIMITED", action: "SIGN_IN", dimension: "client" }],
      ["An attempt was refused by a rate limit", { code: "RATE_LIMITED", action: "MFA_CODE", dimension: "user" }],
      [
        "An attempt was refused by a rate limit",
        { code: "RATE_LIMITED", action: "PASSWORD_RESET_EMAIL", dimension: "address" },
      ],
      [
        "An attempt was refused by a rate limit",
        { code: "RATE_LIMITED", action: "VERIFICATION_EMAIL", dimension: "address" },
      ],
      ["An attempt was refused by a rate limit", { code: "RATE_LIMITED", action: "SIGN_UP", dimension: "client" }],
      ["An attempt was refused by a rate limit", { code: "RATE_LIMITED", action: "UPLOAD", dimension: "user" }],
    ]);
    const logged = JSON.stringify(log.warn.mock.calls);
    const named = ["203.0.113.7", "198.51.100.", "example.com", "user-1", subject("client", "v4:203.0.113.7")];
    for (const secret of named) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe("one attempt's keys", () => {
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

  it("count a reset request by its client address first, giving it back when the address refuses", async () => {
    const { calls, limits } = recorded();
    for (let i = 0; i < 3; i += 1) await limits.passwordResetEmail(headers("203.0.113.7"), "person@example.com", NOW);
    calls.length = 0;
    expect(await limits.passwordResetEmail(headers("203.0.113.7"), "person@example.com", NOW)).toEqual({
      allowed: false,
      minutes: 60,
    });
    expect(calls).toEqual(["hit client", "hit address", "giveBack client"]);
    for (let i = 0; i < 17; i += 1) await limits.passwordResetEmail(headers("203.0.113.7"), `p${i}@example.com`, NOW);
    calls.length = 0;
    expect((await limits.passwordResetEmail(headers("203.0.113.7"), "other@example.com", NOW)).allowed).toBe(false);
    expect(calls).toEqual(["hit client"]);
  });

  it("count a sign-up by its client address alone, giving nothing back, and not at all without one", async () => {
    const { calls, limits } = recorded();
    expect(await limits.signUp(headers("203.0.113.7"), NOW)).toEqual({ allowed: true });
    expect(calls).toEqual(["hit client"]);
    calls.length = 0;
    expect(await limits.signUp(headers(), NOW)).toEqual({ allowed: true });
    expect(calls).toEqual([]);
  });

  it("count a signed-in request by its account alone, on the signed-in store, giving nothing back", async () => {
    const anonymous = new InMemoryRateLimitStore();
    const signedIn = new InMemoryRateLimitStore();
    const settings = {
      ...RATE_LIMIT_DEFAULTS,
      SESSION_SECRET: SECRET,
      RATE_LIMIT_UPLOAD: "1/60",
      FORWARDED_FOR_TRUSTED_ENTRIES: "1",
    };
    const hits = vi.spyOn(signedIn, "hit");
    const anonymousHits = vi.spyOn(anonymous, "hit");
    const limits = new WebRateLimits(anonymous, settings, { warn: vi.fn() }, signedIn);
    expect(await limits.account("UPLOAD", "user-1", NOW)).toEqual({ allowed: true });
    expect(await limits.account("UPLOAD", "user-1", after(1))).toMatchObject({ allowed: false, seconds: 59 });
    expect(await limits.account("UPLOAD", "user-2", after(1))).toEqual({ allowed: true });
    expect(hits.mock.calls.map(([policy, key]) => [policy.name, key])).toEqual([
      ["upload.user", subject("user", "user-1")],
      ["upload.user", subject("user", "user-1")],
      ["upload.user", subject("user", "user-2")],
    ]);
    // The first store, which sign-in and sign-up count on, is never asked.
    expect(anonymousHits).not.toHaveBeenCalled();
    // And sign-in and sign-up stay on the first store (ADR-0173 Decision 6).
    await limits.signUp(headers("203.0.113.7"), NOW);
    await limits.signIn(headers("203.0.113.7"), "person@example.com", NOW);
    expect(anonymousHits.mock.calls.map(([policy]) => policy.name)).toEqual([
      "sign-up.client",
      "sign-in.client",
      "sign-in.address",
    ]);
    expect(hits).toHaveBeenCalledTimes(3);
  });
});

describe("a JSON route's request", () => {
  const settings = { ...RATE_LIMIT_DEFAULTS, SESSION_SECRET: SECRET, RATE_LIMIT_UPLOAD: "1/86400" };

  it("is refused with the JSON answer: RATE_LIMITED, its text and the seconds to wait alone", async () => {
    const limits = new WebRateLimits(new InMemoryRateLimitStore(), settings, { warn: vi.fn() });
    await limitJsonRequest(() => limits, "UPLOAD", "user-1", NOW);
    const refused: unknown = await limitJsonRequest(() => limits, "UPLOAD", "user-1", after(60)).catch((e) => e);
    expect(refused).toBeInstanceOf(AppError);
    expect(refused).toMatchObject({
      code: "RATE_LIMITED",
      httpStatus: 429,
      message: "Too many uploads. Try again in 24 hours.",
      details: { retryAfterSeconds: 86_340 },
    });
    expect(Object.keys((refused as AppError).details ?? {})).toEqual(["retryAfterSeconds"]);
  });

  it("fails as a plain error, never with the limiter's text, when the limiter cannot answer or be built", async () => {
    const broken: RateLimitStore = {
      hit: () => Promise.reject(new AppError("INTERNAL_ERROR", "The rate-limit hit returned no row")),
      giveBack: () => Promise.resolve(),
      forget: () => Promise.resolve(),
    };
    const limits = new WebRateLimits(new InMemoryRateLimitStore(), settings, { warn: vi.fn() }, broken);
    const unbuilt = () => {
      throw new AppError("CONFIGURATION_ERROR", "A rate-limit policy is out of range");
    };
    for (const getter of [() => limits, unbuilt]) {
      const caught: unknown = await limitJsonRequest(getter, "UPLOAD", "user-1", NOW).catch((e) => e);
      expect(caught).not.toBeInstanceOf(AppError);
      expect(String(caught)).not.toMatch(/no row|out of range/);
    }
  });
});

describe("a limiter's failure", () => {
  it("reaches a route as a plain error, never with the limiter's own text", async () => {
    const internal = new AppError("INTERNAL_ERROR", "The rate-limit hit returned no row");
    const caught: unknown = await withoutLimiterText(Promise.reject(internal)).catch((error: unknown) => error);
    expect(caught).not.toBeInstanceOf(AppError);
    expect(String(caught)).not.toContain("no row");
    expect(await withoutLimiterText(Promise.resolve("answer"))).toBe("answer");
  });
});

describe("the process's limits", () => {
  it("are built once, on the limiter's own two clients, each with a small pool and a statement limit", () => {
    const first = getRateLimiter();
    expect(getRateLimiter()).toBe(first);
    const url = "postgresql://app@db/app?connection_limit=3&options=-c+statement_timeout%3D1000";
    expect(prismaUrl.calls).toEqual([url, `signed in: ${url}`]);
  });
});
