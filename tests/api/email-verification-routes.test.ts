import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthService,
  MfaService,
  OrganizationService,
  createMfaSecretCipher,
  systemMfaRandom,
  totpStep,
} from "@app/domain";
import { InMemoryRateLimitStore, createTestDeps, type TestDeps } from "@app/domain/testing";
import { AppError, RATE_LIMIT_DEFAULTS, hotp } from "@app/shared";
import { readDevelopmentEmailOutbox } from "@app/storage";
import { pathOf } from "./redirect-location";

/**
 * Route tests for email verification (AT-3b, ADR-0129): sign-up mails a link
 * and waits on the verify page, opening the link verifies the address without
 * a sign-in, the link is sent again on request, and a sign-in that has not
 * verified its address reaches no other route. Its emails are limited per
 * address (ADR-0172). Only the cookie store, the
 * environment and the identity wiring are stubbed: the session gate, the
 * domain services and the development outbox run for real.
 */
const PASSWORD = "password-123456";
const MFA_KEY = "55".repeat(32);
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

const { getCurrentUser, getSignIn } = await import("@/lib/auth");
const { POST: register } = await import("@/app/api/auth/register/route");
const { POST: login } = await import("@/app/api/auth/login/route");
const { POST: enterCode } = await import("@/app/api/auth/mfa/route");
const { POST: verify } = await import("@/app/api/auth/verify-email/route");
const { POST: resend } = await import("@/app/api/auth/verify-email/resend/route");
const { POST: createOrganization } = await import("@/app/api/organizations/route");
const { POST: mfaSetup } = await import("@/app/api/mfa/setup/route");

let deps: TestDeps;
let auth: AuthService;
let outbox: string;

beforeEach(() => {
  deps = createTestDeps();
  const settings = { ...RATE_LIMIT_DEFAULTS, SESSION_SECRET: "x".repeat(32) };
  limits.value = new WebRateLimits(new InMemoryRateLimitStore(), settings);
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  identity.value = { deps, auth, organizations: new OrganizationService(deps) };
  outbox = mkdtempSync(join(tmpdir(), "vtavision-outbox-routes-"));
  env.value = {
    NODE_ENV: "test",
    USER_SESSION_TTL_SECONDS: 3600,
    MFA_SECRET_KEY: MFA_KEY,
    EMAIL_OUTBOX_DIR: outbox,
    APP_BASE_URL: BASE,
  };
  cookie.value = undefined;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  rmSync(outbox, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Posted as the app's pages post, from `APP_BASE_URL`'s origin (ADR-0174). */
const SITE = { host: "localhost:3210", origin: BASE };
const form = (fields: Record<string, string>, headers: Record<string, string> = SITE) =>
  new Request("http://localhost/api/auth", { method: "POST", headers, body: new URLSearchParams(fields) });
const location = (response: Response) => {
  const url = pathOf(response);
  // A redirect carries a notice, its wait or an error and nothing else: never a token, never a fragment.
  expect([...url.searchParams.keys()].filter((key) => !["notice", "retry", "error"].includes(key))).toEqual([]);
  expect(url.hash).toBe("");
  return { path: url.pathname, notice: url.searchParams.get("notice"), error: url.searchParams.get("error") };
};
const sessionCookie = (response: Response) =>
  /^rev_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
const signUp = (email = "new@example.com") => register(form({ name: "New", email, password: PASSWORD }));
const userId = async (email = "new@example.com") => (await deps.repos.users.findByEmail(email))!.id;

/** The tokens of every link mailed to `to`, oldest first. */
async function mailedTokens(to = "new@example.com"): Promise<string[]> {
  const messages = (await readDevelopmentEmailOutbox(outbox)).filter((message) => message.to === to);
  return messages.map((message) => {
    const line = message.text.split("\n").find((text) => text.startsWith(`${BASE}/verify-email?token=`));
    return new URL(line!).searchParams.get("token")!;
  });
}

describe("signing up", () => {
  it("signs the person in, mails them a link and leaves them on the verify page, reaching nothing else", async () => {
    const response = await signUp();
    expect(response.status).toBe(303);
    expect(location(response)).toEqual({ path: "/verify-email", notice: null, error: null });
    cookie.value = sessionCookie(response);
    expect(cookie.value).toBeDefined();
    expect(await mailedTokens()).toHaveLength(1);

    expect((await getSignIn())?.step).toBe("EMAIL_VERIFICATION_REQUIRED");
    expect(await getCurrentUser()).toBeNull();
    expect(location(await createOrganization(form({ name: "Studio" }))).path).toBe("/login");
    expect((await mfaSetup(form({}))).status).toBe(401);
    expect(await deps.repos.memberships.listByUser(await userId())).toEqual([]);
  });

  it("keeps the account and says so on the verify page when the email cannot be sent", async () => {
    env.value = { ...env.value, EMAIL_OUTBOX_DIR: undefined };
    const response = await signUp();
    expect(location(response)).toEqual({ path: "/verify-email", notice: "not-sent", error: null });
    expect(sessionCookie(response)).toBeDefined();
    expect(await readDevelopmentEmailOutbox(outbox)).toEqual([]);
    expect(location(await login(form({ email: "new@example.com", password: PASSWORD }))).path).toBe("/verify-email");
  });

  it("refuses an address no email can be sent to, with no account, sign-in or email", async () => {
    const response = await signUp("new@localhost");
    expect(location(response)).toEqual({
      path: "/login",
      notice: null,
      error: "Enter an email address that can receive email",
    });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await deps.repos.users.findByEmail("new@localhost")).toBeNull();
    expect(await readDevelopmentEmailOutbox(outbox)).toEqual([]);
  });
});

describe("opening a link", () => {
  it("verifies the address with no sign-in, lets the sign-in in, and says verified when opened again", async () => {
    cookie.value = sessionCookie(await signUp());
    const [token] = await mailedTokens();
    const signedUp = cookie.value;

    cookie.value = undefined;
    expect(location(await verify(form({ token: token! })))).toEqual({
      path: "/verify-email",
      notice: "verified",
      error: null,
    });
    cookie.value = signedUp;
    expect((await getCurrentUser())?.user.email).toBe("new@example.com");
    expect(location(await verify(form({ token: token! }))).notice).toBe("verified");
    expect(location(await login(form({ email: "new@example.com", password: PASSWORD }))).path).toBe("/");
  });

  it("answers every link that verifies nothing the same way, verifying nothing", async () => {
    cookie.value = sessionCookie(await signUp());
    const [token] = await mailedTokens();
    const refused: Record<string, string>[] = [
      {},
      { token: "" },
      { token: "unknown" },
      { token: `${token}x` },
      { token: "t".repeat(129) },
    ];
    for (const fields of refused) {
      expect(location(await verify(form(fields)))).toEqual({ path: "/verify-email", notice: "invalid", error: null });
    }
    expect((await getSignIn())?.step).toBe("EMAIL_VERIFICATION_REQUIRED");
  });

  it("asks a sign-in that owes an MFA code for the code first, then for the address", async () => {
    const id = (await auth.register({ email: "mfa@example.com", name: "M", password: PASSWORD })).id;
    const mfa = new MfaService({ ...deps, cipher: createMfaSecretCipher(MFA_KEY), random: systemMfaRandom });
    const enrolling = (await auth.login("mfa@example.com", PASSWORD)).session;
    const { secret } = await mfa.beginSetup(enrolling);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const bits = [...secret].map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
    const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
    const codeAt = (offset: number) => hotp(key, totpStep(deps.clock.now()) + offset);
    await mfa.confirmSetup(enrolling, codeAt(0));

    const response = await login(form({ email: "mfa@example.com", password: PASSWORD }));
    expect(location(response).path).toBe("/login/mfa");
    cookie.value = sessionCookie(response);
    expect(location(await resend(form({})))).toMatchObject({ path: "/login/mfa" });
    expect(location(await enterCode(form({ code: codeAt(1) }))).path).toBe("/");
    expect((await getSignIn())?.step).toBe("EMAIL_VERIFICATION_REQUIRED");
    expect(location(await resend(form({})))).toEqual({ path: "/verify-email", notice: "sent", error: null });
    expect(await mailedTokens("mfa@example.com")).toHaveLength(1);
    expect(deps.repos.users.peek(id)?.emailVerifiedAt).toBeNull();
  });
});

describe("sending the link again", () => {
  it("mails a new link, and the earlier one still works", async () => {
    cookie.value = sessionCookie(await signUp());
    expect(location(await resend(form({})))).toEqual({ path: "/verify-email", notice: "sent", error: null });
    const tokens = await mailedTokens();
    expect(tokens).toHaveLength(2);
    expect(new Set(tokens).size).toBe(2);
    expect(location(await verify(form({ token: tokens[0]! }))).notice).toBe("verified");
  });

  it("says when it could not be sent", async () => {
    cookie.value = sessionCookie(await signUp());
    env.value = { ...env.value, APP_BASE_URL: undefined };
    expect(location(await resend(form({})))).toEqual({ path: "/verify-email", notice: "not-sent", error: null });
    expect(await mailedTokens()).toHaveLength(1);
  });

  it("goes in, mailing nothing, when the address was verified after the sign-in was read", async () => {
    cookie.value = sessionCookie(await signUp());
    const id = await userId();
    const findById = deps.repos.users.findById.bind(deps.repos.users);
    let reads = 0;
    vi.spyOn(deps.repos.users, "findById").mockImplementation(async (wanted) => {
      const user = await findById(wanted);
      reads += 1;
      return user && wanted === id && reads > 1 ? { ...user, emailVerifiedAt: deps.clock.now() } : user;
    });
    expect(location(await resend(form({}))).path).toBe("/");
    expect(reads).toBe(2);
    expect(await mailedTokens()).toHaveLength(1);
  });

  it("sends no sign-in to the sign-in page and a verified one in, mailing nothing", async () => {
    expect(location(await resend(form({}))).path).toBe("/login");
    cookie.value = sessionCookie(await signUp());
    const [token] = await mailedTokens();
    await verify(form({ token: token! }));
    expect(location(await resend(form({}))).path).toBe("/");
    expect(await mailedTokens()).toHaveLength(1);
  });
});

describe("the verification email limit (ADR-0172)", () => {
  const retry = (response: Response) => pathOf(response).searchParams.get("retry");
  const limitWith = (store: ConstructorParameters<typeof WebRateLimits>[0]) => {
    const settings = { ...RATE_LIMIT_DEFAULTS, SESSION_SECRET: "x".repeat(32) };
    limits.value = new WebRateLimits(store, settings, { warn: () => undefined });
  };
  const down = { hit: () => Promise.reject(new Error("down")), giveBack: async () => {}, forget: async () => {} };

  it("counts sign-up's email, and refuses the fourth within the hour with its wait, mailing nothing", async () => {
    cookie.value = sessionCookie(await signUp());
    for (let i = 0; i < 2; i += 1) expect(location(await resend(form({}))).notice).toBe("sent");
    deps.clock.advanceSeconds(60);
    const refused = await resend(form({}));
    expect(location(refused)).toEqual({ path: "/verify-email", notice: "limited", error: null });
    expect(retry(refused)).toBe("59");
    expect(await mailedTokens()).toHaveLength(3);
    deps.clock.advanceSeconds(3540);
    // The window has ended, and so has the sign-in.
    cookie.value = sessionCookie(await login(form({ email: "new@example.com", password: PASSWORD })));
    expect(location(await resend(form({}))).notice).toBe("sent");
  });

  it("keeps the account and the sign-in, mailing nothing, when sign-up's email is refused", async () => {
    const limiter = limits.value as InstanceType<typeof WebRateLimits>;
    for (let i = 0; i < 3; i += 1) await limiter.verificationEmail("new@example.com", deps.clock.now());
    const response = await signUp(" NEW@example.com");
    expect(location(response)).toEqual({ path: "/verify-email", notice: "limited", error: null });
    expect(retry(response)).toBe("60");
    expect(sessionCookie(response)).toBeDefined();
    expect(await readDevelopmentEmailOutbox(outbox)).toEqual([]);
  });

  it("answers not-sent, mailing nothing, when the limiter cannot answer, and sign-up keeps the account", async () => {
    limitWith(down);
    const response = await signUp();
    expect(location(response)).toEqual({ path: "/verify-email", notice: "not-sent", error: null });
    cookie.value = sessionCookie(response);
    expect(cookie.value).toBeDefined();
    expect(location(await resend(form({})))).toEqual({ path: "/verify-email", notice: "not-sent", error: null });
    expect(await readDevelopmentEmailOutbox(outbox)).toEqual([]);
  });
});

describe("the sign-up limit (ADR-0173)", () => {
  const REFUSED = "Too many sign-ups. Try again in 60 minutes.";
  const limitWith = (store: ConstructorParameters<typeof WebRateLimits>[0], trusted?: string) => {
    const settings = {
      ...RATE_LIMIT_DEFAULTS,
      RATE_LIMIT_SIGN_UP_PER_IP: "2/3600",
      SESSION_SECRET: "x".repeat(32),
      FORWARDED_FOR_TRUSTED_ENTRIES: trusted,
    };
    limits.value = new WebRateLimits(store, settings, { warn: () => undefined });
  };
  const from = (ip: string, email: string) =>
    new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { ...SITE, "x-forwarded-for": ip },
      body: new URLSearchParams({ name: "New", email, password: PASSWORD }),
    });
  const failing = (error: Error) => ({
    hit: () => Promise.reject(error),
    giveBack: async () => {},
    forget: async () => {},
  });

  it("counts every sign-up per client address, and refuses the next before the form is read", async () => {
    limitWith(new InMemoryRateLimitStore(), "1");
    expect(location(await register(from("203.0.113.7", "first@example.com"))).path).toBe("/verify-email");
    // A sign-up that fails is counted too: nothing gives a hit back.
    expect(location(await register(from("203.0.113.7", "first@example.com"))).error).toBe(
      "Email is already registered",
    );
    const request = from("203.0.113.7", "third@example.com");
    const read = vi.spyOn(request, "formData");
    const refused = await register(request);
    expect(location(refused)).toEqual({ path: "/login", notice: null, error: REFUSED });
    expect(read).not.toHaveBeenCalled();
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(await deps.repos.users.findByEmail("third@example.com")).toBeNull();
    expect(await mailedTokens("third@example.com")).toEqual([]);
    // Another client address is counted on its own, and the window's end lets the first one through.
    expect(location(await register(from("198.51.100.1", "fourth@example.com"))).path).toBe("/verify-email");
    deps.clock.advanceSeconds(3600);
    expect(location(await register(from("203.0.113.7", "third@example.com"))).path).toBe("/verify-email");
  });

  it("counts nothing when the request has no client address", async () => {
    limitWith(new InMemoryRateLimitStore());
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
      expect(location(await register(from("203.0.113.7", email))).path).toBe("/verify-email");
    }
  });

  it("refuses with its own answer, never the limiter's text, making no account, when the limiter fails", async () => {
    const internal = new AppError("INTERNAL_ERROR", "The rate-limit hit returned no row");
    for (const error of [new Error("down"), internal]) {
      limitWith(failing(error), "1");
      const refused = await register(from("203.0.113.7", "new@example.com"));
      expect(location(refused)).toEqual({ path: "/login", notice: null, error: "Registration failed" });
      expect(refused.headers.get("set-cookie")).toBeNull();
    }
    expect(await deps.repos.users.findByEmail("new@example.com")).toBeNull();
    expect(await readDevelopmentEmailOutbox(outbox)).toEqual([]);
  });

  it("logs one line for a limiter that cannot answer sign-up, naming its route (ADR-0177)", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    limitWith(failing(new Error("down")), "1");
    const refused = await register(from("203.0.113.7", "typed-canary@example.com"));
    expect(location(refused).error).toBe("Registration failed");
    const failures = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(failures.map((line) => [line.component, line.route, line.errorName, line.code])).toEqual([
      ["request", "POST /api/auth/register", "Error", "UNEXPECTED"],
    ]);
    expect(lines.join("\n")).not.toContain("typed-canary");
    expect(lines.join("\n")).not.toContain("203.0.113.7");
  });
});

describe("the origin check (ADR-0174)", () => {
  it.each([
    ["no origin", { host: "localhost:3210" }],
    ["another site", { host: "localhost:3210", origin: "https://evil.example.net" }],
  ])("refuses a post from %s before reading, counting, mailing or writing anything", async (_, headers) => {
    const signedUp = sessionCookie(await signUp());
    const [token] = await mailedTokens();
    const store = new InMemoryRateLimitStore();
    const hit = vi.spyOn(store, "hit");
    limits.value = new WebRateLimits(store, { ...RATE_LIMIT_DEFAULTS, SESSION_SECRET: "x".repeat(32) });
    const { organizations } = identity.value as { organizations: OrganizationService };
    const services = [
      vi.spyOn(auth, "register"),
      vi.spyOn(auth, "login"),
      vi.spyOn(organizations, "createOrganization"),
    ];
    const audited = deps.repos.auditLogs.all().length;
    const routes: [(request: Request) => Promise<Response>, Record<string, string>, string][] = [
      [register, { name: "Other", email: "other@example.com", password: PASSWORD }, "An account must be created"],
      [login, { email: "new@example.com", password: PASSWORD }, "A sign-in must be started"],
      [enterCode, { code: "000000" }, "A sign-in code must be entered"],
      [verify, { token: token! }, "An email address must be verified"],
      [resend, {}, "A verification link must be asked for"],
      [createOrganization, { name: "Studio" }, "An organization must be created"],
    ];
    for (const signedIn of [signedUp, undefined]) {
      cookie.value = signedIn;
      for (const [route, fields, refusal] of routes) {
        const sent = form(fields, headers);
        const response = await route(sent);
        const { error } = (await response.json()) as { error: unknown };
        const message = `${refusal} from this site`;
        expect([response.status, error]).toMatchObject([403, { code: "FORBIDDEN", message }]);
        expect([sent.bodyUsed, response.headers.get("set-cookie")]).toEqual([false, null]);
      }
    }
    expect(hit).not.toHaveBeenCalled();
    for (const service of services) expect(service).not.toHaveBeenCalled();
    expect([await mailedTokens(), deps.repos.auditLogs.all().length]).toEqual([[token], audited]);
    expect(deps.repos.users.peek(await userId())?.emailVerifiedAt).toBeNull();
    expect(await deps.repos.memberships.listByUser(await userId())).toEqual([]);
    cookie.value = signedUp;
    expect((await getSignIn())?.step).toBe("EMAIL_VERIFICATION_REQUIRED");
  });
});
