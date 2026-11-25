import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService, MfaService, createMfaSecretCipher, systemMfaRandom, totpStep } from "@app/domain";
import { InMemoryRateLimitStore, createTestDeps, markEmailVerified, type TestDeps } from "@app/domain/testing";
import { RATE_LIMIT_DEFAULTS, hotp } from "@app/shared";
import { readDevelopmentEmailOutbox } from "@app/storage";
import { pathOf } from "./redirect-location";

/**
 * Route tests for password reset (AT-4c, ADR-0133): asking for a link answers
 * the same for every address and every failure, and a link replaces the
 * password once, ends every session and leaves MFA and email verification to
 * the next sign-in. Requests are limited, and a reset forgets the address's
 * failed sign-ins (ADR-0172). Only the cookie store, the environment and the identity
 * wiring are stubbed: the session gate, the domain services and the
 * development outbox run for real.
 */
const PASSWORD = "password-123456";
const NEW_PASSWORD = "new-password-7890";
const MFA_KEY = "66".repeat(32);
const BASE = "http://localhost:3210";

const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));
const limits = vi.hoisted(() => ({ value: null as unknown }));

// `next` is installed for the web app only, so its module is named by its resolved path.
const nextHeaders = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  return createRequire(new URL("../../apps/web/package.json", import.meta.url)).resolve("next/headers");
});

vi.mock(nextHeaders, () => ({
  cookies: () => Promise.resolve({ get: () => (cookie.value ? { value: cookie.value } : undefined) }),
}));
vi.mock("@/lib/env", () => ({ getServerEnv: () => env.value }));
vi.mock("@/lib/identity", () => ({ getIdentityServices: () => identity.value }));
// The limits run for real, on an in-memory store made afresh for each test (ADR-0171, ADR-0172).
vi.mock("@/lib/rate-limit", async (original) => ({
  ...(await original<typeof import("@/lib/rate-limit")>()),
  getRateLimiter: () => limits.value,
}));
const { WebRateLimits } = await import("@/lib/rate-limit");

const { getSignIn } = await import("@/lib/auth");
const { POST: login } = await import("@/app/api/auth/login/route");
const { POST: ask } = await import("@/app/api/auth/reset-password/request/route");
const { POST: reset } = await import("@/app/api/auth/reset-password/route");

let deps: TestDeps;
let auth: AuthService;
let outbox: string;
let userId: string;

beforeEach(async () => {
  deps = createTestDeps();
  const settings = { ...RATE_LIMIT_DEFAULTS, SESSION_SECRET: "x".repeat(32) };
  limits.value = new WebRateLimits(new InMemoryRateLimitStore(), settings);
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  identity.value = { deps, auth };
  outbox = mkdtempSync(join(tmpdir(), "vtavision-outbox-reset-"));
  env.value = {
    NODE_ENV: "test",
    USER_SESSION_TTL_SECONDS: 3600,
    MFA_SECRET_KEY: MFA_KEY,
    EMAIL_OUTBOX_DIR: outbox,
    APP_BASE_URL: BASE,
  };
  cookie.value = undefined;
  userId = (await auth.register({ email: "user@example.com", name: "User", password: PASSWORD })).id;
  markEmailVerified(deps, userId);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  rmSync(outbox, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Posted as the reset page's forms post, from `APP_BASE_URL`'s origin (ADR-0174). */
const SITE = { host: "localhost:3210", origin: BASE };
const form = (fields: Record<string, string>, headers: Record<string, string> = SITE) =>
  new Request("http://localhost/api/auth", { method: "POST", headers, body: new URLSearchParams(fields) });
const location = (response: Response) => {
  expect(response.status).toBe(303);
  const url = pathOf(response);
  // A redirect carries a notice, its wait or an error and nothing else: never a token, never an address.
  expect([...url.searchParams.keys()].filter((key) => !["notice", "retry", "error"].includes(key))).toEqual([]);
  expect(url.hash).toBe("");
  return { path: url.pathname, notice: url.searchParams.get("notice"), error: url.searchParams.get("error") };
};
const resetPage = (notice: string) => ({ path: "/reset-password", notice, error: null });
const signIn = async (password: string, email = "user@example.com") => {
  const response = await login(form({ email, password }));
  return { ...location(response), cookie: /^rev_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1] };
};

/** The tokens of every reset link mailed to `to`, oldest first. */
async function mailedTokens(to = "user@example.com"): Promise<string[]> {
  const messages = (await readDevelopmentEmailOutbox(outbox)).filter((message) => message.to === to);
  return messages.map((message) => {
    expect(message.kind).toBe("PASSWORD_RESET");
    const line = message.text.split("\n").find((text) => text.startsWith(`${BASE}/reset-password?token=`));
    return new URL(line!).searchParams.get("token")!;
  });
}

async function askedToken(email = "user@example.com"): Promise<string> {
  expect(location(await ask(form({ email })))).toEqual(resetPage("sent"));
  return (await mailedTokens(email)).at(-1)!;
}

describe("asking for a link", () => {
  it("mails the account's address, and answers every other address the same, mailing nothing", async () => {
    const disabled = await auth.register({ email: "gone@example.com", name: "Gone", password: PASSWORD });
    deps.repos.users.put({ ...deps.repos.users.peek(disabled.id)!, status: "DISABLED" });
    const addresses = ["USER@example.com", "nobody@example.com", "gone@example.com", "", "not an address"];
    for (const email of [...addresses, "a@localhost"]) {
      expect(location(await ask(form({ email })))).toEqual(resetPage("sent"));
    }
    expect(location(await ask(form({})))).toEqual(resetPage("sent"));
    const json = new Request("http://localhost/api/auth", {
      method: "POST",
      headers: SITE,
      body: '{"email":"user@example.com"}',
    });
    expect(location(await ask(json))).toEqual(resetPage("sent"));
    const mail = await readDevelopmentEmailOutbox(outbox);
    expect(mail.map((message) => message.to)).toEqual(["user@example.com"]);
    expect(await mailedTokens()).toHaveLength(1);
  });

  it("answers the same when the email cannot be sent, or anything else fails", async () => {
    env.value = { ...env.value, APP_BASE_URL: undefined };
    expect(location(await ask(form({ email: "user@example.com" })))).toEqual(resetPage("sent"));
    // A link kept, then the outbox refusing the email: an error no unknown address raises.
    const notAFolder = join(outbox, "file");
    writeFileSync(notAFolder, "");
    env.value = { ...env.value, APP_BASE_URL: BASE, EMAIL_OUTBOX_DIR: notAFolder };
    const links = deps.repos.auditLogs.all().filter((entry) => entry.action === "user.password_reset_link_created");
    expect(location(await ask(form({ email: "user@example.com" })))).toEqual(resetPage("sent"));
    expect(
      deps.repos.auditLogs.all().filter((entry) => entry.action === "user.password_reset_link_created"),
    ).toHaveLength(links.length + 1);
    env.value = { ...env.value, EMAIL_OUTBOX_DIR: outbox };
    rmSync(notAFolder);
    env.value = { ...env.value, APP_BASE_URL: BASE };
    vi.spyOn(deps.repos.users, "findByEmail").mockRejectedValueOnce(new Error("database is down"));
    expect(location(await ask(form({ email: "user@example.com" })))).toEqual(resetPage("sent"));
    expect(await readDevelopmentEmailOutbox(outbox)).toEqual([]);
  });
});

describe("choosing a new password", () => {
  it("replaces the password once, ends every session, and sends the person to sign in", async () => {
    const signedIn = await signIn(PASSWORD);
    expect(signedIn.path).toBe("/");
    const token = await askedToken();

    expect(location(await reset(form({ token, password: NEW_PASSWORD })))).toEqual(resetPage("reset"));
    cookie.value = signedIn.cookie;
    expect(await getSignIn()).toBeNull();
    expect(await signIn(PASSWORD)).toMatchObject({ path: "/login", error: "Invalid email or password" });
    expect(await signIn(NEW_PASSWORD)).toMatchObject({ path: "/", error: null });
    expect(location(await reset(form({ token, password: "another-password-1" })))).toEqual(resetPage("invalid"));
    expect(await signIn(NEW_PASSWORD)).toMatchObject({ path: "/" });
  });

  it("answers every link that resets nothing the same way, changing nothing", async () => {
    const token = await askedToken();
    const refused: Record<string, string>[] = [
      { password: NEW_PASSWORD },
      { token: "", password: NEW_PASSWORD },
      { token: "unknown", password: NEW_PASSWORD },
      { token: `${token}x`, password: NEW_PASSWORD },
      { token: "t".repeat(129), password: NEW_PASSWORD },
      { token: "unknown", password: "short" },
    ];
    for (const fields of refused) {
      expect(location(await reset(form(fields)))).toEqual(resetPage("invalid"));
    }
    const body = JSON.stringify({ token });
    const json = new Request("http://localhost/api/auth", { method: "POST", headers: SITE, body });
    expect(location(await reset(json))).toEqual(resetPage("invalid"));
    expect(await signIn(PASSWORD)).toMatchObject({ path: "/" });
    expect(location(await reset(form({ token, password: NEW_PASSWORD })))).toEqual(resetPage("reset"));
  });

  it("refuses a password under 10 characters and leaves the link usable", async () => {
    const token = await askedToken();
    for (const password of ["", "123456789"]) {
      expect(location(await reset(form({ token, password })))).toEqual(resetPage("too-short"));
    }
    expect(location(await reset(form({ token })))).toEqual(resetPage("too-short"));
    expect(await signIn(PASSWORD)).toMatchObject({ path: "/" });
    expect(location(await reset(form({ token, password: "1234567890" })))).toEqual(resetPage("reset"));
  });

  it("says it failed, and changes nothing, when the reset cannot be written", async () => {
    const token = await askedToken();
    vi.spyOn(deps.repos.accountLinks, "useForPasswordReset").mockRejectedValueOnce(new Error("database is down"));
    expect(location(await reset(form({ token, password: NEW_PASSWORD })))).toEqual(resetPage("failed"));
    expect(await signIn(PASSWORD)).toMatchObject({ path: "/" });
    expect(location(await reset(form({ token, password: NEW_PASSWORD })))).toEqual(resetPage("reset"));
  });
});

describe("the next sign-in", () => {
  it("still asks for the MFA code", async () => {
    const mfa = new MfaService({ ...deps, cipher: createMfaSecretCipher(MFA_KEY), random: systemMfaRandom });
    const enrolling = (await auth.login("user@example.com", PASSWORD)).session;
    const { secret } = await mfa.beginSetup(enrolling);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const bits = [...secret].map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
    const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
    await mfa.confirmSetup(enrolling, hotp(key, totpStep(deps.clock.now())));

    expect(location(await reset(form({ token: await askedToken(), password: NEW_PASSWORD })))).toEqual(
      resetPage("reset"),
    );
    const next = await signIn(NEW_PASSWORD);
    expect(next.path).toBe("/login/mfa");
    cookie.value = next.cookie;
    expect((await getSignIn())?.step).toBe("CODE_REQUIRED");
  });

  it("still asks an account that has not verified its address to verify it", async () => {
    const unverified = await auth.register({ email: "new@example.com", name: "New", password: PASSWORD });
    const token = await askedToken("new@example.com");
    expect(location(await reset(form({ token, password: NEW_PASSWORD })))).toEqual(resetPage("reset"));
    expect((await signIn(NEW_PASSWORD, "new@example.com")).path).toBe("/verify-email");
    expect(deps.repos.users.peek(unverified.id)?.emailVerifiedAt).toBeNull();
  });
});

describe("the reset limits (ADR-0172)", () => {
  const SIGN_IN_REFUSED = "Too many sign-in attempts. Try again in 15 minutes.";
  const from = (ip: string, email: string) =>
    new Request("http://localhost/api/auth", {
      method: "POST",
      headers: { ...SITE, "x-forwarded-for": ip },
      body: new URLSearchParams({ email }),
    });
  const limited = (response: Response) => {
    expect(location(response)).toEqual(resetPage("limited"));
    return pathOf(response).searchParams.get("retry");
  };
  const limitWith = (store: ConstructorParameters<typeof WebRateLimits>[0], trusted?: string) => {
    const settings = { ...RATE_LIMIT_DEFAULTS, SESSION_SECRET: "x".repeat(32), FORWARDED_FOR_TRUSTED_ENTRIES: trusted };
    limits.value = new WebRateLimits(store, settings, { warn: () => undefined });
  };
  const down = { hit: () => Promise.reject(new Error("down")), giveBack: async () => {}, forget: async () => {} };

  it("refuses the fourth request for an address within the hour, account or not, mailing nothing", async () => {
    for (const email of ["user@example.com", "nobody@example.com"]) {
      for (let i = 0; i < 3; i += 1) expect(location(await ask(form({ email })))).toEqual(resetPage("sent"));
      expect(limited(await ask(form({ email: ` ${email.toUpperCase()}` })))).toBe("60");
    }
    expect(await mailedTokens()).toHaveLength(3);
    deps.clock.advanceSeconds(3599);
    expect(limited(await ask(form({ email: "user@example.com" })))).toBe("1");
    deps.clock.advanceSeconds(1);
    expect(location(await ask(form({ email: "user@example.com" })))).toEqual(resetPage("sent"));
    expect(await mailedTokens()).toHaveLength(4);
  });

  it("refuses the 21st request from one client address within the hour, whatever the address", async () => {
    limitWith(new InMemoryRateLimitStore(), "1");
    for (let i = 0; i < 20; i += 1) {
      expect(location(await ask(from("203.0.113.7", `person${i}@example.com`)))).toEqual(resetPage("sent"));
    }
    expect(limited(await ask(from("203.0.113.7", "user@example.com")))).toBe("60");
    expect(await mailedTokens()).toEqual([]);
    expect(location(await ask(from("198.51.100.1", "user@example.com")))).toEqual(resetPage("sent"));
    expect(await mailedTokens()).toHaveLength(1);
  });

  it("answers sent, mailing nothing, when the limiter cannot answer", async () => {
    limitWith(down);
    expect(location(await ask(form({ email: "user@example.com" })))).toEqual(resetPage("sent"));
    expect(await readDevelopmentEmailOutbox(outbox)).toEqual([]);
  });

  it("forgets the address's failed sign-ins when the password is reset", async () => {
    for (let i = 0; i < 5; i += 1) await signIn("wrong-password");
    expect(await signIn(PASSWORD)).toMatchObject({ path: "/login", error: SIGN_IN_REFUSED });
    const token = await askedToken();
    expect(location(await reset(form({ token, password: NEW_PASSWORD })))).toEqual(resetPage("reset"));
    expect(await signIn(NEW_PASSWORD)).toMatchObject({ path: "/", error: null });
  });

  it("still says the password was changed when the failed sign-ins cannot be forgotten", async () => {
    const token = await askedToken();
    const store = Object.assign(Object.create(new InMemoryRateLimitStore()) as InMemoryRateLimitStore, {
      forget: () => Promise.reject(new Error("down")),
    });
    limitWith(store);
    expect(location(await reset(form({ token, password: NEW_PASSWORD })))).toEqual(resetPage("reset"));
    expect(location(await reset(form({ token, password: "another-password-1" })))).toEqual(resetPage("invalid"));
  });
});

describe("the origin check (ADR-0174)", () => {
  it.each([
    ["no origin", { host: "localhost:3210" }],
    ["another site", { host: "localhost:3210", origin: "https://evil.example.net" }],
  ])("refuses a post from %s, signed in or not, reading, counting, mailing or changing nothing", async (_, headers) => {
    const token = await askedToken();
    // Signed in before the spies, since signing in looks the address up and counts it.
    const signedIn = (await signIn(PASSWORD)).cookie;
    const store = new InMemoryRateLimitStore();
    const hit = vi.spyOn(store, "hit");
    limits.value = new WebRateLimits(store, { ...RATE_LIMIT_DEFAULTS, SESSION_SECRET: "x".repeat(32) });
    const services = [
      vi.spyOn(deps.repos.users, "findByEmail"),
      vi.spyOn(deps.repos.accountLinks, "useForPasswordReset"),
    ];
    const audited = deps.repos.auditLogs.all().length;
    const routes: [(request: Request) => Promise<Response>, Record<string, string>, string][] = [
      [ask, { email: "user@example.com" }, "A password reset link must be asked for from this site"],
      [reset, { token, password: NEW_PASSWORD }, "A new password must be chosen from this site"],
    ];
    for (const session of [signedIn, undefined]) {
      cookie.value = session;
      for (const [route, fields, message] of routes) {
        const sent = form(fields, headers);
        const response = await route(sent);
        const { error } = (await response.json()) as { error: unknown };
        expect([response.status, error]).toMatchObject([403, { code: "FORBIDDEN", message }]);
        expect(sent.bodyUsed).toBe(false);
      }
    }
    expect(hit).not.toHaveBeenCalled();
    for (const service of services) expect(service).not.toHaveBeenCalled();
    expect([await mailedTokens(), deps.repos.auditLogs.all().length]).toEqual([[token], audited]);
    for (const service of services) service.mockRestore();
    expect(await getSignIn()).toBeNull();
    cookie.value = signedIn;
    expect(await getSignIn()).not.toBeNull();
    cookie.value = undefined;
    // The password is unchanged and the link still resets it.
    expect(await signIn(PASSWORD)).toMatchObject({ path: "/" });
    expect(location(await reset(form({ token, password: NEW_PASSWORD })))).toEqual(resetPage("reset"));
  });
});
