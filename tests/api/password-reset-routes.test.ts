import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService, MfaService, createMfaSecretCipher, systemMfaRandom, totpStep } from "@app/domain";
import { createTestDeps, markEmailVerified, type TestDeps } from "@app/domain/testing";
import { hotp } from "@app/shared";
import { readDevelopmentEmailOutbox } from "@app/storage";

/**
 * Route tests for password reset (AT-4c, ADR-0133): asking for a link answers
 * the same for every address and every failure, and a link replaces the
 * password once, ends every session and leaves MFA and email verification to
 * the next sign-in. Only the cookie store, the environment and the identity
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

const form = (fields: Record<string, string>) =>
  new Request("http://localhost/api/auth", { method: "POST", body: new URLSearchParams(fields) });
const location = (response: Response) => {
  expect(response.status).toBe(303);
  const url = new URL(response.headers.get("location")!);
  // A redirect carries a notice or an error and nothing else: never a token, never an address.
  expect([...url.searchParams.keys()].filter((key) => key !== "notice" && key !== "error")).toEqual([]);
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
    for (const email of ["USER@example.com", "nobody@example.com", "", "not an address", "user@localhost"]) {
      expect(location(await ask(form({ email })))).toEqual(resetPage("sent"));
    }
    expect(location(await ask(form({})))).toEqual(resetPage("sent"));
    const mail = await readDevelopmentEmailOutbox(outbox);
    expect(mail.map((message) => message.to)).toEqual(["user@example.com"]);
    expect(await mailedTokens()).toHaveLength(1);
  });

  it("answers the same when the email cannot be sent, or anything else fails", async () => {
    env.value = { ...env.value, APP_BASE_URL: undefined };
    expect(location(await ask(form({ email: "user@example.com" })))).toEqual(resetPage("sent"));
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
