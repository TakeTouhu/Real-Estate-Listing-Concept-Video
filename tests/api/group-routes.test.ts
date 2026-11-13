import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthService,
  MfaService,
  OrganizationService,
  PermissionGrantService,
  createMfaSecretCipher,
  systemMfaRandom,
  totpStep,
  type Role,
} from "@app/domain";
import { createTestDeps, markEmailVerified, type TestDeps } from "@app/domain/testing";
import { AppError, hotp } from "@app/shared";

/**
 * Route tests for creating a group from the groups page (AT-9a, ADR-0141): a
 * same-origin form post, signed in, reaches the group service, which decides
 * and audits; the answer is the groups page with a fixed code, never the name.
 * Only the cookie store, the environment and the identity wiring are stubbed:
 * the session gate and the domain services run for real.
 */
const PASSWORD = "password-123456";
const MFA_KEY = "79".repeat(32);
const SITE = "https://app.vtavision.test";

const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));

// `next` is installed for the web app only, so its module is named by its resolved path.
const nextHeaders = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  return createRequire(new URL("../../apps/web/package.json", import.meta.url)).resolve("next/headers");
});

vi.mock(nextHeaders, () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (name === "rev_session" && cookie.value ? { value: cookie.value } : undefined),
    }),
}));
vi.mock("@/lib/env", () => ({ getServerEnv: () => env.value }));
vi.mock("@/lib/identity", () => ({ getIdentityServices: () => identity.value }));

const { POST: create } = await import("@/app/api/organizations/[organizationId]/groups/route");
const { createGroup } = await import("@/lib/groups");

let deps: TestDeps;
let auth: AuthService;
let orgId: string;
let ownerId: string;

beforeEach(async () => {
  deps = createTestDeps();
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  identity.value = { deps, auth, organizations: new OrganizationService(deps) };
  env.value = { NODE_ENV: "test", USER_SESSION_TTL_SECONDS: 3600, MFA_SECRET_KEY: MFA_KEY };
  ownerId = await register("owner");
  ({ organization: { id: orgId } } = await new OrganizationService(deps).createOrganization(ownerId, {
    name: "Studio Kanda",
  }));
  await signIn("owner");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function register(name: string): Promise<string> {
  const userId = (await auth.register({ email: `${name}@example.com`, name, password: PASSWORD })).id;
  markEmailVerified(deps, userId);
  return userId;
}

async function member(name: string, role: Role): Promise<string> {
  const userId = await register(name);
  await deps.repos.memberships.create({ organizationId: orgId, userId, role });
  return userId;
}

function decodeBase32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...text].map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

/** Sign in as `name`, with MFA set up. */
async function signIn(name: string): Promise<void> {
  const { token, session } = await auth.login(`${name}@example.com`, PASSWORD);
  const mfa = new MfaService({ ...deps, cipher: createMfaSecretCipher(MFA_KEY), random: systemMfaRandom });
  const { secret } = await mfa.beginSetup(session);
  await mfa.confirmSetup(session, hotp(decodeBase32(secret), totpStep(deps.clock.now())));
  cookie.value = token;
}

const creating = (
  fields: Record<string, string>,
  organizationId = orgId,
  headers: Record<string, string> = { origin: SITE },
) =>
  create(
    new Request(`${SITE}/api/organizations/${organizationId}/groups`, {
      method: "POST",
      headers: { host: "app.vtavision.test", "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    }),
    { params: Promise.resolve({ organizationId }) },
  );

/** Where a 303 lands: the groups page with one code, and nothing else in the address. */
function landing(response: Response, organizationId = orgId): string {
  expect(response.status).toBe(303);
  const url = new URL(response.headers.get("location")!);
  expect(url.origin).toBe(SITE);
  expect(url.pathname).toBe(`/organizations/${organizationId}/groups`);
  const entries = [...url.searchParams.entries()];
  expect(entries).toHaveLength(1);
  return entries.map(([key, value]) => `${key}=${value}`).join("");
}

const names = async (organizationId = orgId) =>
  (await deps.repos.groups.listByOrganization(organizationId)).map(({ name }) => name);

const audited = (action: string) => deps.repos.auditLogs.all().filter((entry) => entry.action === action);

describe("creating a group", () => {
  it("creates the group under its trimmed name, and audits it", async () => {
    expect(landing(await creating({ name: "  East office " }))).toBe("notice=group-created");
    expect(await names()).toEqual(["East office"]);
    expect(audited("group.created").map(({ actorUserId, metadata }) => ({ actorUserId, metadata }))).toEqual([
      { actorUserId: ownerId, metadata: { name: "East office" } },
    ]);
  });

  it("lets an admin create one, and a manager granted group.manage", async () => {
    await member("team.admin", "ADMIN");
    const manager = await member("team.manager", "MANAGER");
    await new PermissionGrantService(deps).grant(ownerId, orgId, manager, "group.manage");
    await signIn("team.admin");
    expect(landing(await creating({ name: "East" }))).toBe("notice=group-created");
    await signIn("team.manager");
    expect(landing(await creating({ name: "West" }))).toBe("notice=group-created");
    expect(await names()).toEqual(["East", "West"]);
  });

  it.each(["MANAGER", "CREATOR", "VIEWER", "BILLING"] as const)(
    "refuses a %s, who lacks group.manage, and audits it",
    async (role) => {
      await member(`acting.${role}`, role);
      await signIn(`acting.${role}`);
      expect(landing(await creating({ name: "East" }))).toBe("error=may-not-create-group");
      expect(await names()).toEqual([]);
      expect(audited("group.change_refused").map(({ metadata }) => metadata)).toEqual([
        { operation: "create", reason: "lacks_group_manage", actorRole: role, groupId: null },
      ]);
    },
  );

  it("refuses an organization the poster is no member of, writing nothing there", async () => {
    const outsider = await register("outsider");
    const { organization } = await new OrganizationService(deps).createOrganization(outsider, { name: "Elsewhere" });
    expect(landing(await creating({ name: "East" }, organization.id), organization.id)).toBe(
      "error=may-not-create-group",
    );
    expect(await names(organization.id)).toEqual([]);
    expect(audited("group.change_refused")).toEqual([]);
  });

  it.each([[{}], [{ name: "" }], [{ name: "   " }], [{ name: "x".repeat(101) }], [{ name: "East\u0000office" }]])(
    "creates nothing for %o, and asks for a name",
    async (fields) => {
      expect(landing(await creating(fields))).toBe("error=group-name");
      expect(await names()).toEqual([]);
      expect(audited("group.created")).toEqual([]);
    },
  );

  it("takes a name of 100 characters", async () => {
    expect(landing(await creating({ name: "x".repeat(100) }))).toBe("notice=group-created");
  });

  it("says when another group has the name, creating nothing", async () => {
    await creating({ name: "East" });
    expect(landing(await creating({ name: " East " }))).toBe("error=group-name-taken");
    expect(await names()).toEqual(["East"]);
  });

  it("asks for the permission before the name, so an empty name is still a refusal", async () => {
    await member("acting.viewer", "VIEWER");
    await signIn("acting.viewer");
    expect(landing(await creating({ name: "" }))).toBe("error=may-not-create-group");
    expect(audited("group.change_refused")).toHaveLength(1);
  });

  it("answers a refusal it does not know as a failure, never by a name every object has", async () => {
    vi.spyOn(deps.repos.groups, "create").mockRejectedValue(
      new AppError("VALIDATION_FAILED", "Refused", { details: { reason: "constructor" } }),
    );
    expect(landing(await creating({ name: "East" }))).toBe("error=create-group-failed");
  });

  it("answers a name reason on an error that is no refusal of a name as a failure", async () => {
    vi.spyOn(deps.repos.groups, "create").mockRejectedValue(
      new AppError("INTERNAL_ERROR", "Lost", { details: { reason: "NAME_TAKEN" } }),
    );
    expect(landing(await creating({ name: "East" }))).toBe("error=create-group-failed");
  });

  it("logs a failure by its code alone, never the name, and says to check the list", async () => {
    vi.spyOn(deps.repos.groups, "create").mockRejectedValue(new Error("lost the group Secret project"));
    const logged: unknown[] = [];
    const outcome = await createGroup(ownerId, orgId, { name: "Secret project" }, {
      error: (message, fields) => logged.push({ message, fields }),
    });
    expect(outcome).toEqual({ error: "create-group-failed" });
    expect(logged).toEqual([{ message: "A group could not be created", fields: { code: "UNEXPECTED" } }]);
  });

  it.each([
    ["no origin", {}],
    ["another site", { origin: "https://evil.example.net" }],
    ["another origin of the same site", { origin: "https://files.vtavision.test" }],
  ])("refuses a post from %s before reading anything", async (_what, headers) => {
    const response = await creating({ name: "East" }, orgId, headers);
    expect(response.status).toBe(403);
    expect(await names()).toEqual([]);
  });

  it("sends a signed-out visitor to sign in, creating nothing", async () => {
    cookie.value = undefined;
    const response = await creating({ name: "East" });
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    expect(await names()).toEqual([]);
  });
});
