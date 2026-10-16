import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService, OrganizationService, totpStep } from "@app/domain";
import { createTestDeps, type TestDeps } from "@app/domain/testing";
import { hotp } from "@app/shared";

/**
 * Route tests for the two-step sign-in and the MFA routes (ADR-0065, MFA-2).
 * Only the cookie store, the environment and the identity wiring are stubbed:
 * the session gate in `lib/auth.ts`, `lib/mfa.ts` and the domain services all
 * run for real over in-memory repositories.
 */
const PASSWORD = "password-123456";
const MFA_KEY = "33".repeat(32);

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

const { getCurrentUser } = await import("@/lib/auth");
const { qrCodeDataUrl } = await import("@/lib/mfa");
const { POST: login } = await import("@/app/api/auth/login/route");
const { POST: enterCode } = await import("@/app/api/auth/mfa/route");
const { POST: setup } = await import("@/app/api/mfa/setup/route");
const { POST: confirm } = await import("@/app/api/mfa/setup/confirm/route");
const { POST: newRecoveryCodes } = await import("@/app/api/mfa/recovery-codes/route");
const { POST: disable } = await import("@/app/api/mfa/disable/route");

let deps: TestDeps;
let auth: AuthService;

beforeEach(async () => {
  deps = createTestDeps();
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  identity.value = { deps, auth };
  env.value = { NODE_ENV: "test", USER_SESSION_TTL_SECONDS: 3600, MFA_SECRET_KEY: MFA_KEY };
  cookie.value = undefined;
  await auth.register({ email: "member@example.com", name: "Member", password: PASSWORD });
  // An OWNER must use MFA, so cannot turn it off (ADR-0052 Decision 18).
  const owner = await auth.register({ email: "owner@example.com", name: "Owner", password: PASSWORD });
  await new OrganizationService(deps).createOrganization(owner.id, { name: "Studio" });
});

function decodeBase32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of text) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

const codeFor = (secret: string, offset = 0) => hotp(decodeBase32(secret), totpStep(deps.clock.now()) + offset);
const json = (body: unknown) =>
  new Request("http://localhost/api/mfa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const form = (fields: Record<string, string>) =>
  new Request("http://localhost/api/auth", { method: "POST", body: new URLSearchParams(fields) });
const location = (response: Response) => {
  const url = new URL(response.headers.get("location")!);
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
    expect((await confirm(new Request("http://localhost/api/mfa", { method: "POST", body: "{" }))).status).toBe(422);

    env.value = { ...env.value, MFA_SECRET_KEY: undefined };
    const unconfigured = await setup();
    expect(unconfigured.status).toBe(500);
    expect(((await unconfigured.json()) as { error: { code: string } }).error.code).toBe("CONFIGURATION_ERROR");
  });
});
