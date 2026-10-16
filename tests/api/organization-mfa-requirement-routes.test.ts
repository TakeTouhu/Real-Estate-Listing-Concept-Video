import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthService,
  MfaService,
  OrganizationService,
  createMfaSecretCipher,
  systemMfaRandom,
  totpStep,
  type Role,
} from "@app/domain";
import { createTestDeps, type TestDeps } from "@app/domain/testing";
import { hotp } from "@app/shared";

/**
 * Route tests for an organization's "require MFA of every member" (MFA-4,
 * ADR-0065 Decision 18). Only the cookie store, the environment and the
 * identity wiring are stubbed: the session gate and the domain run for real
 * over in-memory repositories.
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
const { POST: login } = await import("@/app/api/auth/login/route");
const { POST: setRequirement } = await import("@/app/api/organizations/[organizationId]/mfa-requirement/route");

let deps: TestDeps;
let auth: AuthService;
let orgId: string;
const emails: Record<"owner" | "admin" | "manager" | "outsider", string> = {
  owner: "owner@example.com",
  admin: "admin@example.com",
  manager: "manager@example.com",
  outsider: "outsider@example.com",
};

beforeEach(async () => {
  deps = createTestDeps();
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const organizations = new OrganizationService(deps);
  identity.value = { deps, auth, organizations };
  env.value = { NODE_ENV: "test", USER_SESSION_TTL_SECONDS: 3600, MFA_SECRET_KEY: MFA_KEY };
  cookie.value = undefined;
  const ids: Record<string, string> = {};
  for (const [name, email] of Object.entries(emails)) {
    ids[name] = (await auth.register({ email, name, password: PASSWORD })).id;
  }
  ({ organization: { id: orgId } } = await organizations.createOrganization(ids.owner!, { name: "Studio" }));
  const roles: [string, Role][] = [
    [ids.admin!, "ADMIN"],
    [ids.manager!, "MANAGER"],
  ];
  for (const [userId, role] of roles) await deps.repos.memberships.create({ organizationId: orgId, userId, role });
});

function decodeBase32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of text) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

/** Sign in; an `OWNER` or `ADMIN` must use MFA, so sets it up on the way. */
async function signIn(who: keyof typeof emails): Promise<void> {
  const { token, session } = await auth.login(emails[who], PASSWORD);
  if (who === "owner" || who === "admin") {
    const mfa = new MfaService({ ...deps, cipher: createMfaSecretCipher(MFA_KEY), random: systemMfaRandom });
    const { secret } = await mfa.beginSetup(session);
    await mfa.confirmSetup(session, hotp(decodeBase32(secret), totpStep(deps.clock.now())));
  }
  cookie.value = token;
}

const post = (fields: Record<string, string>, organizationId = orgId) =>
  setRequirement(
    new Request(`http://localhost/api/organizations/${organizationId}/mfa-requirement`, {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    { params: Promise.resolve({ organizationId }) },
  );
const location = (response: Response) => {
  const url = new URL(response.headers.get("location")!);
  return { path: url.pathname, error: url.searchParams.get("error") };
};
const required = async () => (await deps.repos.organizations.findById(orgId))?.mfaRequired;

describe("POST /api/organizations/:organizationId/mfa-requirement", () => {
  it.each(["owner", "admin"] as const)("lets the %s turn it on and off, back to the dashboard", async (who) => {
    await signIn(who);
    const on = await post({ required: "true" });
    expect(on.status).toBe(303);
    expect(location(on)).toEqual({ path: "/", error: null });
    expect(await required()).toBe(true);
    const off = await post({ required: "false" });
    expect(location(off)).toEqual({ path: "/", error: null });
    expect(await required()).toBe(false);
  });

  it("refuses a MANAGER with the domain's message, changing nothing", async () => {
    await signIn("manager");
    const response = await post({ required: "true" });
    expect(response.status).toBe(303);
    expect(location(response)).toEqual({ path: "/", error: "Role MANAGER may not change whether MFA is required" });
    expect(await required()).toBe(false);
  });

  it("refuses a non-member", async () => {
    await signIn("outsider");
    expect(location(await post({ required: "true" })).error).toBe("You do not have access to this organization");
    expect(await required()).toBe(false);
  });

  it.each<Record<string, string>>([{}, { required: "" }, { required: "yes" }, { required: "TRUE" }])(
    "refuses a value that is not true or false: %j",
    async (fields) => {
      await signIn("owner");
      const response = await post(fields);
      expect(location(response)).toEqual({ path: "/", error: "Choose whether to require MFA" });
      expect(await required()).toBe(false);
    },
  );

  it("sends a request with no sign-in, or one that has not passed MFA, to /login", async () => {
    const anonymous = await post({ required: "true" });
    expect(anonymous.status).toBe(303);
    expect(location(anonymous)).toEqual({ path: "/login", error: null });

    cookie.value = (await auth.login(emails.owner, PASSWORD)).token;
    expect(location(await post({ required: "true" })).path).toBe("/login");
    expect(await required()).toBe(false);
  });

  it("answers an unknown organization as one the user cannot reach", async () => {
    await signIn("owner");
    expect(location(await post({ required: "true" }, "org_missing")).error).toBe("You do not have access to this organization");
  });

  it("sends every member without MFA to set it up from their next request, and no longer once it is off", async () => {
    cookie.value = (await auth.login(emails.manager, PASSWORD)).token;
    expect(await getCurrentUser()).not.toBeNull();
    const managerToken = cookie.value;

    await signIn("admin");
    await post({ required: "true" });
    cookie.value = managerToken;
    expect(await getCurrentUser()).toBeNull();
    const again = await login(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        body: new URLSearchParams({ email: emails.manager, password: PASSWORD }),
      }),
    );
    expect(location(again).path).toBe("/security");

    await signIn("owner");
    await post({ required: "false" });
    cookie.value = managerToken;
    expect(await getCurrentUser()).not.toBeNull();
  });

  it("does not echo an unexpected error", async () => {
    await signIn("owner");
    vi.spyOn(deps.repos.organizations, "setMfaRequired").mockRejectedValueOnce(new Error("connection reset: secret detail"));
    expect(location(await post({ required: "true" })).error).toBe("Could not change the MFA requirement");
  });
});
