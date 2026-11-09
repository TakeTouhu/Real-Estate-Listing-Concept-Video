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
import { createTestDeps, type TestDeps } from "@app/domain/testing";
import { hotp } from "@app/shared";
import { readDevelopmentEmailOutbox } from "@app/storage";

/**
 * Route tests for email verification (AT-3b, ADR-0129): sign-up mails a link
 * and waits on the verify page, opening the link verifies the address without
 * a sign-in, the link is sent again on request, and a sign-in that has not
 * verified its address reaches no other route. Only the cookie store, the
 * environment and the identity wiring are stubbed: the session gate, the
 * domain services and the development outbox run for real.
 */
const PASSWORD = "password-123456";
const MFA_KEY = "55".repeat(32);
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

const form = (fields: Record<string, string>) =>
  new Request("http://localhost/api/auth", { method: "POST", body: new URLSearchParams(fields) });
const location = (response: Response) => {
  const url = new URL(response.headers.get("location")!);
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
    expect((await mfaSetup()).status).toBe(401);
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
