import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService, MfaService, OrganizationService, totpStep } from "@app/domain";
import { InMemoryRateLimitStore, createTestDeps, markEmailVerified, type TestDeps } from "@app/domain/testing";
import { AppError, RATE_LIMIT_DEFAULTS, hotp } from "@app/shared";
import { pathOf } from "./redirect-location";

/**
 * Route tests for the two-step sign-in, MFA set-up when it is required, and the
 * MFA routes (ADR-0065, MFA-2 and MFA-3).
 * Only the cookie store, the environment and the identity wiring are stubbed:
 * the session gate in `lib/auth.ts`, `lib/mfa.ts` and the domain services all
 * run for real over in-memory repositories.
 */
const PASSWORD = "password-123456";
const MFA_KEY = "33".repeat(32);

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
// The sign-in limits run for real, on an in-memory store made afresh for each test (ADR-0171).
vi.mock("@/lib/rate-limit", async (original) => ({
  ...(await original<typeof import("@/lib/rate-limit")>()),
  getRateLimiter: () => limits.value,
}));
const { WebRateLimits } = await import("@/lib/rate-limit");

const { getCurrentUser, getSignIn } = await import("@/lib/auth");
const { qrCodeDataUrl } = await import("@/lib/mfa");
const { POST: login } = await import("@/app/api/auth/login/route");
const { POST: enterCode } = await import("@/app/api/auth/mfa/route");
const { POST: startSetup } = await import("@/app/api/mfa/setup/route");
const { POST: confirm } = await import("@/app/api/mfa/setup/confirm/route");
const { POST: replaceRecoveryCodes } = await import("@/app/api/mfa/recovery-codes/route");
const { POST: disable } = await import("@/app/api/mfa/disable/route");

let deps: TestDeps;
let auth: AuthService;

beforeEach(async () => {
  deps = createTestDeps();
  const settings = { ...RATE_LIMIT_DEFAULTS, SESSION_SECRET: "x".repeat(32) };
  limits.value = new WebRateLimits(new InMemoryRateLimitStore(), settings);
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  identity.value = { deps, auth };
  env.value = { NODE_ENV: "test", USER_SESSION_TTL_SECONDS: 3600, MFA_SECRET_KEY: MFA_KEY };
  cookie.value = undefined;
  const member = await auth.register({ email: "member@example.com", name: "Member", password: PASSWORD });
  markEmailVerified(deps, member.id);
  // An OWNER must use MFA, so cannot turn it off (ADR-0052 Decision 18).
  const owner = await auth.register({ email: "owner@example.com", name: "Owner", password: PASSWORD });
  markEmailVerified(deps, owner.id);
  await new OrganizationService(deps).createOrganization(owner.id, { name: "Studio" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function decodeBase32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of text) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

const codeFor = (secret: string, offset = 0) => hotp(decodeBase32(secret), totpStep(deps.clock.now()) + offset);
/** Posted as the app's pages post: with no `APP_BASE_URL` here, the host is compared (ADR-0174). */
const SITE = { host: "localhost", origin: "http://localhost" };
const json = (body: unknown, headers: Record<string, string> = SITE) =>
  new Request("http://localhost/api/mfa", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const form = (fields: Record<string, string>, headers: Record<string, string> = SITE) =>
  new Request("http://localhost/api/auth", { method: "POST", headers, body: new URLSearchParams(fields) });
const setup = () => startSetup(new Request("http://localhost/api/mfa", { method: "POST", headers: SITE }));
const newRecoveryCodes = () =>
  replaceRecoveryCodes(new Request("http://localhost/api/mfa", { method: "POST", headers: SITE }));
const location = (response: Response) => {
  const url = pathOf(response);
  return { path: url.pathname, error: url.searchParams.get("error") };
};

async function signIn(email = "member@example.com"): Promise<void> {
  cookie.value = (await auth.login(email, PASSWORD)).token;
}

/** Turn MFA on through the routes; the sign-in doing it stays signed in. */
async function enroll(email = "member@example.com"): Promise<{ secret: string; recoveryCodes: string[] }> {
  await signIn(email);
  const { secret } = (await (await setup()).json()) as { secret: string };
  const confirmed = await confirm(json({ code: codeFor(secret) }));
  expect(confirmed.status).toBe(200);
  const { recoveryCodes } = (await confirmed.json()) as { recoveryCodes: string[] };
  return { secret, recoveryCodes };
}

describe("signing in with the password", () => {
  it("signs in a user without MFA, and sends a user with MFA on to the code step", async () => {
    const plain = await login(form({ email: "member@example.com", password: PASSWORD }));
    expect(plain.status).toBe(303);
    expect(location(plain).path).toBe("/");
    expect(plain.headers.get("set-cookie")).toMatch(/^rev_session=/);

    await enroll();
    const withMfa = await login(form({ email: "member@example.com", password: PASSWORD }));
    expect(location(withMfa).path).toBe("/login/mfa");
    expect(withMfa.headers.get("set-cookie")).toMatch(/^rev_session=/);
  });

  it("keeps a sign-in that owes a code out of every route and page", async () => {
    const { secret } = await enroll();
    expect(await getCurrentUser()).not.toBeNull();

    await signIn();
    expect(await getCurrentUser()).toBeNull();
    for (const response of [await setup(), await newRecoveryCodes(), await disable(json({ code: codeFor(secret, 1) }))]) {
      expect(response.status).toBe(401);
    }
    expect(await deps.repos.mfa.findFactor((await deps.repos.users.findByEmail("member@example.com"))!.id)).not.toBeNull();
  });
});

describe("set-up when MFA is required (ADR-0065 Decisions 15 and 16)", () => {
  it("sends someone who must use MFA, and has not set it up, from the password to set-up", async () => {
    const response = await login(form({ email: "owner@example.com", password: PASSWORD }));
    expect(location(response)).toEqual({ path: "/security", error: null });
    expect(response.headers.get("set-cookie")).toMatch(/^rev_session=/);
    cookie.value = /^rev_session=([^;]+)/.exec(response.headers.get("set-cookie")!)![1];
    expect(await getCurrentUser()).toBeNull();

    const { secret } = (await (await setup()).json()) as { secret: string };
    const confirmed = await confirm(json({ code: codeFor(secret) }));
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.get("cache-control")).toBe("no-store");
    expect((await getCurrentUser())?.user.email).toBe("owner@example.com");

    expect(location(await login(form({ email: "owner@example.com", password: PASSWORD }))).path).toBe("/login/mfa");
  });

  it("keeps a sign-in that must set MFA up out of every route but set-up", async () => {
    await signIn("owner@example.com");
    for (const response of [await newRecoveryCodes(), await disable(json({ code: "000000" }))]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(location(await enterCode(form({ code: "000000" })))).toEqual({ path: "/security", error: null });
    expect((await setup()).status).toBe(200);
    expect(await getCurrentUser()).toBeNull();
  });

  it("applies a new requirement from the next request", async () => {
    await signIn();
    expect(await getCurrentUser()).not.toBeNull();
    const member = (await deps.repos.users.findByEmail("member@example.com"))!;
    await new OrganizationService(deps).createOrganization(member.id, { name: "Own studio" });
    expect(await getCurrentUser()).toBeNull();
    expect((await setup()).status).toBe(200);
  });

  it("lets no one who must use MFA in without the MFA key", async () => {
    env.value = { ...env.value, MFA_SECRET_KEY: undefined };
    expect(location(await login(form({ email: "owner@example.com", password: PASSWORD }))).path).toBe("/security");
    await signIn("owner@example.com");
    const unconfigured = await setup();
    expect(unconfigured.status).toBe(500);
    expect(((await unconfigured.json()) as { error: { code: string } }).error.code).toBe("CONFIGURATION_ERROR");
    expect(await getCurrentUser()).toBeNull();
  });
});

describe("the code step", () => {
  it("passes with an authenticator code or a recovery code, once each", async () => {
    const { secret, recoveryCodes } = await enroll();

    await signIn();
    const passed = await enterCode(form({ code: codeFor(secret, 1) }));
    expect(location(passed)).toEqual({ path: "/", error: null });
    expect((await getCurrentUser())?.user.email).toBe("member@example.com");

    await signIn();
    expect(location(await enterCode(form({ code: recoveryCodes[0]!.toLowerCase() }))).path).toBe("/");
    expect(await getCurrentUser()).not.toBeNull();

    await signIn();
    expect(location(await enterCode(form({ code: recoveryCodes[0]! })))).toEqual({
      path: "/login/mfa",
      error: "That code is not valid. Attempts left: 4",
    });
    expect(await getCurrentUser()).toBeNull();
  });

  it("ends the sign-in at the fifth wrong code and clears its cookie", async () => {
    await enroll();
    await signIn();
    for (let left = 4; left > 0; left -= 1) {
      expect(location(await enterCode(form({ code: "000000" }))).error).toBe(`That code is not valid. Attempts left: ${left}`);
    }
    const locked = await enterCode(form({ code: "000000" }));
    expect(location(locked)).toEqual({ path: "/login", error: "Too many wrong codes; sign in again" });
    expect(locked.headers.get("set-cookie")).toMatch(/^rev_session=;/);
    expect(await getCurrentUser()).toBeNull();
    expect(location(await enterCode(form({ code: "000000" }))).path).toBe("/login");
  });

  it("sends a sign-in that needs no code home, and one without a cookie to the password", async () => {
    await signIn();
    expect(location(await enterCode(form({ code: "000000" })))).toEqual({ path: "/", error: null });
    cookie.value = undefined;
    expect(location(await enterCode(form({ code: "000000" })))).toEqual({ path: "/login", error: "Sign in again" });
  });

  it("checks no code without the MFA key, so the sign-in cannot finish", async () => {
    const { secret } = await enroll();
    await signIn();
    env.value = { ...env.value, MFA_SECRET_KEY: undefined };
    expect(location(await enterCode(form({ code: codeFor(secret, 1) })))).toEqual({
      path: "/login/mfa",
      error: "MFA is not available right now",
    });
    expect(await getCurrentUser()).toBeNull();
  });
});

describe("the MFA routes", () => {
  it("starts set-up with the key and a QR code of the authenticator URI, never cached", async () => {
    await signIn();
    const response = await setup();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { secret: string; qrCode: string };
    expect(Object.keys(body).sort()).toEqual(["qrCode", "secret"]);
    const uri = `otpauth://totp/VTaVision:member%40example.com?secret=${body.secret}&issuer=VTaVision&algorithm=SHA1&digits=6&period=30`;
    expect(body.qrCode).toBe(await qrCodeDataUrl(uri));
    expect(Buffer.from(body.qrCode.split(",")[1]!, "base64").toString()).toMatch(/^<svg/);
  });

  it("turns MFA on with the first code and shows ten recovery codes once, never cached", async () => {
    await signIn();
    const { secret } = (await (await setup()).json()) as { secret: string };
    const wrong = await confirm(json({ code: "000000" }));
    expect(wrong.status).toBe(422);
    expect(((await wrong.json()) as { error: { message: string } }).error.message).toBe("That code is not valid");

    const response = await confirm(json({ code: codeFor(secret) }));
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { recoveryCodes } = (await response.json()) as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);
    expect((await newRecoveryCodes()).headers.get("cache-control")).toBe("no-store");
  });

  it("replaces the recovery codes", async () => {
    const { recoveryCodes } = await enroll();
    const response = await newRecoveryCodes();
    expect(response.status).toBe(200);
    const fresh = ((await response.json()) as { recoveryCodes: string[] }).recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh.filter((code) => recoveryCodes.includes(code))).toEqual([]);
  });

  it("turns MFA off with a current code, but never for someone who must use it", async () => {
    const member = await enroll();
    expect((await disable(json({ code: codeFor(member.secret, 1) }))).status).toBe(204);
    await signIn();
    expect(await getCurrentUser()).not.toBeNull();

    const owner = await enroll("owner@example.com");
    const refused = await disable(json({ code: codeFor(owner.secret, 1) }));
    expect(refused.status).toBe(403);
    expect(refused.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses without a sign-in, a code, or the MFA key", async () => {
    const anonymous = await setup();
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");

    await signIn();
    expect((await confirm(json({}))).status).toBe(422);
    const malformed = new Request("http://localhost/api/mfa", { method: "POST", headers: SITE, body: "{" });
    expect((await confirm(malformed)).status).toBe(422);

    env.value = { ...env.value, MFA_SECRET_KEY: undefined };
    const unconfigured = await setup();
    expect(unconfigured.status).toBe(500);
    expect(((await unconfigured.json()) as { error: { code: string } }).error.code).toBe("CONFIGURATION_ERROR");
  });
});

describe("the sign-in limits (ADR-0171)", () => {
  const SIGN_IN_REFUSED = "Too many sign-in attempts. Try again in 15 minutes.";
  const CODES_REFUSED = "Too many wrong codes. Try again in 15 minutes.";
  const from = (ip: string, fields: Record<string, string>) =>
    new Request("http://localhost/api/auth", {
      method: "POST",
      headers: { ...SITE, "x-forwarded-for": ip },
      body: new URLSearchParams(fields),
    });
  const limitWith = (store: ConstructorParameters<typeof WebRateLimits>[0], trusted?: string) => {
    const settings = { ...RATE_LIMIT_DEFAULTS, SESSION_SECRET: "x".repeat(32), FORWARDED_FOR_TRUSTED_ENTRIES: trusted };
    limits.value = new WebRateLimits(store, settings, { warn: () => undefined });
  };
  const down = { hit: () => Promise.reject(new Error("down")), giveBack: async () => {}, forget: async () => {} };
  /** The in-memory store, but one of its calls fails. */
  const failing = (fails: "forget" | "giveBack") =>
    Object.assign(Object.create(new InMemoryRateLimitStore()) as InMemoryRateLimitStore, {
      [fails]: () => Promise.reject(new Error("down")),
    });

  it("refuses the sixth sign-in for an address after five wrong passwords, account or not", async () => {
    for (const email of ["member@example.com", "nobody@example.com"]) {
      for (let i = 0; i < 5; i += 1) {
        const wrong = await login(form({ email, password: "wrong-password" }));
        expect(location(wrong).error).toBe("Invalid email or password");
      }
      const refused = await login(form({ email: ` ${email.toUpperCase()}`, password: PASSWORD }));
      expect(location(refused)).toEqual({ path: "/login", error: SIGN_IN_REFUSED });
      expect(refused.headers.get("set-cookie")).toBeNull();
    }
    // The wait ends, and the right password signs in.
    deps.clock.advanceSeconds(900);
    expect(location(await login(form({ email: "member@example.com", password: PASSWORD }))).path).toBe("/");
  });

  it("forgets the address when the password is right, even when a code comes next", async () => {
    await enroll();
    for (let round = 0; round < 2; round += 1) {
      for (let i = 0; i < 4; i += 1) await login(form({ email: "member@example.com", password: "wrong-password" }));
      expect(location(await login(form({ email: "member@example.com", password: PASSWORD }))).path).toBe("/login/mfa");
    }
  });

  it("counts the client address the setting names, and gives its hit back when the password is right", async () => {
    limitWith(new InMemoryRateLimitStore(), "1");
    const wrong = (i: number) => from("203.0.113.7", { email: `guess${i}@example.com`, password: "wrong-password" });
    for (let i = 0; i < 4; i += 1) expect(location(await login(wrong(i))).error).toBe("Invalid email or password");
    const right = await login(from("203.0.113.7", { email: "member@example.com", password: PASSWORD }));
    expect(location(right).path).toBe("/");
    expect(location(await login(wrong(4))).error).toBe("Invalid email or password");
    expect(location(await login(wrong(5))).error).toBe(SIGN_IN_REFUSED);
    // Another client address is counted on its own.
    expect(location(await login(from("198.51.100.1", { email: "a@example.com", password: "x" }))).error).toBe(
      "Invalid email or password",
    );
  });

  it("refuses through each route's own answer when the limiter cannot answer", async () => {
    const { secret } = await enroll();
    await signIn();
    limitWith(down);
    const refused = await login(form({ email: "member@example.com", password: PASSWORD }));
    expect(location(refused)).toEqual({ path: "/login", error: "Sign in failed" });
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(location(await enterCode(form({ code: codeFor(secret, 1) })))).toEqual({
      path: "/login/mfa",
      error: "Sign in failed",
    });
    expect(await getCurrentUser()).toBeNull();
  });

  it("logs one line for each refusal, naming its route and nothing typed, when the limiter cannot answer", async () => {
    const { secret } = await enroll();
    await signIn();
    limitWith(down);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    const typed = { email: "typed-canary@example.com", password: "typed-canary-password" };
    expect(location(await login(form(typed))).error).toBe("Sign in failed");
    const typedCode = codeFor(secret, 1);
    expect(location(await enterCode(form({ code: typedCode }))).error).toBe("Sign in failed");
    const failures = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(failures.map((line) => [line.component, line.route, line.errorName, line.code, line.causeName])).toEqual([
      ["request", "POST /api/auth/login", "RateLimiterUnavailable", "UNEXPECTED", "Error"],
      ["request", "POST /api/auth/mfa", "RateLimiterUnavailable", "UNEXPECTED", "Error"],
    ]);
    expect(lines.join("\n")).not.toMatch(new RegExp(`typed-canary|${typedCode}`));
  });

  it("answers its own failure, never the limiter's text, when the limiter fails with an AppError", async () => {
    const internal = () => Promise.reject(new AppError("INTERNAL_ERROR", "The rate-limit hit returned no row"));
    for (const store of [{ ...down, hit: internal }, Object.assign(failing("forget"), { forget: internal })]) {
      limitWith(store, "1");
      const refused = await login(from("203.0.113.7", { email: "member@example.com", password: PASSWORD }));
      expect(location(refused)).toEqual({ path: "/login", error: "Sign in failed" });
      expect(refused.headers.get("set-cookie")).toBeNull();
    }
    // The code step too: the hit fails before the code is checked, then the accepted code cannot be forgotten.
    const { secret } = await enroll();
    for (const store of [{ ...down, hit: internal }, Object.assign(failing("forget"), { forget: internal })]) {
      await signIn();
      limitWith(store);
      const answer = await enterCode(form({ code: codeFor(secret, 1) }));
      expect(location(answer)).toEqual({ path: "/login/mfa", error: "Sign in failed" });
    }
  });

  it("refuses a right password when the address cannot be forgotten or the client's hit given back", async () => {
    for (const fails of ["forget", "giveBack"] as const) {
      limitWith(failing(fails), "1");
      const refused = await login(from("203.0.113.7", { email: "member@example.com", password: PASSWORD }));
      expect(location(refused)).toEqual({ path: "/login", error: "Sign in failed" });
      expect(refused.headers.get("set-cookie")).toBeNull();
    }
  });

  it("keeps an accepted code accepted when the user's wrong codes cannot be forgotten", async () => {
    const { secret } = await enroll();
    await signIn();
    limitWith(failing("forget"));
    // The code was checked and its sign-in passed; only the count stays (ADR-0171 Decision 8).
    expect(location(await enterCode(form({ code: codeFor(secret, 1) })))).toEqual({
      path: "/login/mfa",
      error: "Sign in failed",
    });
    expect(await getCurrentUser()).not.toBeNull();
  });

  it("refuses the sixth wrong code across sign-ins, keeping the sign-in and its own count", async () => {
    const { secret } = await enroll();
    await signIn();
    for (let left = 4; left > 0; left -= 1) await enterCode(form({ code: "000000" }));
    await signIn();
    expect(location(await enterCode(form({ code: "000000" }))).error).toBe("That code is not valid. Attempts left: 4");
    const refused = await enterCode(form({ code: codeFor(secret, 1) }));
    expect(location(refused)).toEqual({ path: "/login/mfa", error: CODES_REFUSED });
    expect(refused.headers.get("set-cookie")).toBeNull();
    deps.clock.advanceSeconds(900);
    // The refused code was never checked: this sign-in has had one wrong code.
    expect(location(await enterCode(form({ code: "000000" }))).error).toBe("That code is not valid. Attempts left: 3");
    expect(location(await enterCode(form({ code: codeFor(secret, 1) }))).path).toBe("/");
  });

  it("forgets the user's wrong codes when a code is accepted", async () => {
    const { secret, recoveryCodes } = await enroll();
    for (const code of [codeFor(secret, 1), recoveryCodes[0]!]) {
      await signIn();
      for (let i = 0; i < 4; i += 1) await enterCode(form({ code: "000000" }));
      await signIn();
      expect(location(await enterCode(form({ code }))).path).toBe("/");
    }
    await signIn();
    expect(location(await enterCode(form({ code: "000000" }))).error).toBe("That code is not valid. Attempts left: 4");
  });
});

describe("the origin check (ADR-0174)", () => {
  it.each([
    ["no origin", { host: "localhost" }],
    ["another site", { host: "localhost", origin: "https://evil.example.net" }],
  ])("refuses a post from %s before reading, counting or changing anything, signed in or not", async (_, headers) => {
    const { secret } = await enroll();
    const signedIn = cookie.value;
    await signIn();
    const owesCode = cookie.value;
    const store = new InMemoryRateLimitStore();
    const hit = vi.spyOn(store, "hit");
    limits.value = new WebRateLimits(store, { ...RATE_LIMIT_DEFAULTS, SESSION_SECRET: "x".repeat(32) });
    const methods = ["beginSetup", "confirmSetup", "regenerateRecoveryCodes", "disable", "verify"] as const;
    const services = [vi.spyOn(auth, "login"), ...methods.map((method) => vi.spyOn(MfaService.prototype, method))];
    const audited = deps.repos.auditLogs.all().length;
    const MFA = "MFA must be changed from this site";
    const code = { code: codeFor(secret, 1) };
    const password = { email: "member@example.com", password: PASSWORD };
    const routes: [(request: Request) => Promise<Response>, () => Request, string][] = [
      [login, () => form(password, headers), "A sign-in must be started from this site"],
      [enterCode, () => form(code, headers), "A sign-in code must be entered from this site"],
      [startSetup, () => json({}, headers), MFA],
      [confirm, () => json(code, headers), MFA],
      [replaceRecoveryCodes, () => json({}, headers), MFA],
      [disable, () => json(code, headers), MFA],
    ];
    for (const token of [signedIn, owesCode, undefined]) {
      cookie.value = token;
      for (const [route, request, message] of routes) {
        const sent = request();
        const response = await route(sent);
        const { error } = (await response.json()) as { error: unknown };
        expect([response.status, error]).toMatchObject([403, { code: "FORBIDDEN", message }]);
        expect([sent.bodyUsed, response.headers.get("set-cookie")]).toEqual([false, null]);
        if (message === MFA) expect(response.headers.get("cache-control")).toBe("no-store");
      }
    }
    // Nothing was counted, so a refused sign-in uses none of the address's or the client's attempts.
    expect(hit).not.toHaveBeenCalled();
    for (const service of services) expect(service).not.toHaveBeenCalled();
    expect(deps.repos.auditLogs.all()).toHaveLength(audited);
    cookie.value = owesCode;
    expect((await getSignIn())?.step).toBe("CODE_REQUIRED");
    cookie.value = signedIn;
    expect((await getCurrentUser())?.user.email).toBe("member@example.com");
  });
});
