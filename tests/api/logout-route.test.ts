import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "@app/domain";
import { createTestDeps, markEmailVerified, type TestDeps } from "@app/domain/testing";

/**
 * Route tests for signing out (ADR-0006, ADR-0174): the session ends on the
 * server and its cookie is cleared, and a post from another site, or with no
 * `Origin`, is refused before the cookie is read. Only the cookie store, the
 * environment and the identity wiring are stubbed: the session gate and the
 * domain run for real over in-memory repositories.
 */
const PASSWORD = "password-123456";
const BASE = "http://localhost:3210";

const cookie = vi.hoisted(() => ({ value: undefined as string | undefined, reads: 0 }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));

// `next` is installed for the web app only, so its module is named by its resolved path.
const nextHeaders = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  return createRequire(new URL("../../apps/web/package.json", import.meta.url)).resolve("next/headers");
});

vi.mock(nextHeaders, () => ({
  cookies: () => {
    cookie.reads += 1;
    return Promise.resolve({ get: () => (cookie.value ? { value: cookie.value } : undefined) });
  },
}));
vi.mock("@/lib/env", () => ({ getServerEnv: () => env.value }));
vi.mock("@/lib/identity", () => ({ getIdentityServices: () => identity.value }));

const { getSignIn } = await import("@/lib/auth");
const { POST: logout } = await import("@/app/api/auth/logout/route");

let deps: TestDeps;
let auth: AuthService;

beforeEach(async () => {
  deps = createTestDeps();
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  identity.value = { deps, auth };
  env.value = { NODE_ENV: "test", USER_SESSION_TTL_SECONDS: 3600, APP_BASE_URL: BASE };
  const user = await auth.register({ email: "user@example.com", name: "User", password: PASSWORD });
  markEmailVerified(deps, user.id);
  cookie.value = (await auth.login("user@example.com", PASSWORD)).token;
  cookie.reads = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Posted as the app's pages post, from `APP_BASE_URL`'s origin. */
const SITE = { host: "localhost:3210", origin: BASE };
const post = (headers: Record<string, string> = SITE) =>
  new Request("http://localhost/api/auth/logout", { method: "POST", headers, body: new URLSearchParams() });
const revoked = () => deps.repos.auditLogs.all().filter((entry) => entry.action === "session.revoked");

describe("POST /api/auth/logout", () => {
  it("ends the session on the server, clears its cookie and goes to the sign-in page", async () => {
    expect(await getSignIn()).not.toBeNull();
    const response = await logout(post());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.get("set-cookie")).toMatch(/^rev_session=;/);
    expect(await getSignIn()).toBeNull();
    expect(revoked()).toHaveLength(1);
  });

  it("clears the cookie with no session, or one already ended", async () => {
    for (const token of [undefined, "ended"]) {
      cookie.value = token;
      const response = await logout(post());
      expect([response.status, response.headers.get("location")]).toEqual([303, "/login"]);
      expect(response.headers.get("set-cookie")).toMatch(/^rev_session=;/);
    }
    expect(revoked()).toEqual([]);
  });

  it.each([
    ["no origin", { host: "localhost:3210" }],
    ["another site", { host: "localhost:3210", origin: "https://evil.example.net" }],
    // The host the browser addressed is not enough where `APP_BASE_URL` is set.
    ["another origin of the host", { host: "localhost:3210", origin: "http://localhost:3211" }],
  ])("refuses a post from %s before reading the cookie, keeping the session", async (_, headers) => {
    const ending = vi.spyOn(auth, "logout");
    const token = cookie.value;
    for (const signedIn of [token, undefined]) {
      cookie.value = signedIn;
      const request = post(headers);
      const response = await logout(request);
      const { error } = (await response.json()) as { error: unknown };
      expect([response.status, error]).toMatchObject([
        403,
        { code: "FORBIDDEN", message: "A session must be ended from this site" },
      ]);
      expect([request.bodyUsed, response.headers.get("set-cookie")]).toEqual([false, null]);
    }
    expect([cookie.reads, ending.mock.calls.length, revoked().length]).toEqual([0, 0, 0]);
    cookie.value = token;
    expect((await getSignIn())?.user.email).toBe("user@example.com");
  });
});
