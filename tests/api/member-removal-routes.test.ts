import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthService,
  MfaService,
  OrganizationService,
  createMfaSecretCipher,
  systemMfaRandom,
  totpStep,
  type Role,
} from "@app/domain";
import { InMemoryUnitsReader, createTestDeps, markEmailVerified, type TestDeps } from "@app/domain/testing";
import { hotp } from "@app/shared";

/**
 * Route tests for removing a member from the members page (AT-8b, ADR-0140):
 * a same-origin form post, signed in, reaches the membership service, which
 * decides and audits; the answer is the members page with a fixed code. Only
 * the cookie store, the environment, the identity wiring and the
 * subscriptions are stubbed: the session gate and the domain services run for
 * real.
 */
const PASSWORD = "password-123456";
const MFA_KEY = "78".repeat(32);
const SITE = "https://app.vtavision.test";

const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));
const subscriptions = vi.hoisted(() => ({ value: null as unknown }));

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
vi.mock("@app/database", () => ({
  createSubscriptionRepository: () => subscriptions.value,
  getPrismaClient: () => ({}),
}));

const { POST: remove } = await import("@/app/api/organizations/[organizationId]/members/[userId]/remove/route");
const { removeOrganizationMember } = await import("@/lib/members");

let deps: TestDeps;
let auth: AuthService;
let orgId: string;
let ownerId: string;
let ids: Record<string, string>;

beforeEach(async () => {
  deps = createTestDeps();
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  identity.value = { deps, auth, organizations: new OrganizationService(deps) };
  subscriptions.value = new InMemoryUnitsReader();
  env.value = { NODE_ENV: "test", USER_SESSION_TTL_SECONDS: 3600, MFA_SECRET_KEY: MFA_KEY };
  ownerId = await register("owner");
  ({ organization: { id: orgId } } = await new OrganizationService(deps).createOrganization(ownerId, {
    name: "Studio Kanda",
  }));
  ids = {};
  sessions.clear();
  for (const role of ["ADMIN", "CREATOR", "VIEWER"] as const) ids[role] = await member(`team.${role}`, role);
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

async function member(name: string, role: Role, organizationId = orgId): Promise<string> {
  const userId = await register(name);
  await deps.repos.memberships.create({ organizationId, userId, role });
  return userId;
}

function decodeBase32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...text].map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

const sessions = new Map<string, string>();

/** Sign in as `name`, with MFA set up; again, the same session. */
async function signIn(name: string): Promise<void> {
  const signedIn = sessions.get(name);
  if (signedIn !== undefined) {
    cookie.value = signedIn;
    return;
  }
  const { token, session } = await auth.login(`${name}@example.com`, PASSWORD);
  sessions.set(name, token);
  const mfa = new MfaService({ ...deps, cipher: createMfaSecretCipher(MFA_KEY), random: systemMfaRandom });
  const { secret } = await mfa.beginSetup(session);
  await mfa.confirmSetup(session, hotp(decodeBase32(secret), totpStep(deps.clock.now())));
  cookie.value = token;
}

const removing = (
  userId: string,
  fields: Record<string, string>,
  organizationId = orgId,
  headers: Record<string, string> = { origin: SITE },
) =>
  remove(
    new Request(`${SITE}/api/organizations/${organizationId}/members/${userId}/remove`, {
      method: "POST",
      headers: { host: "app.vtavision.test", "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    }),
    { params: Promise.resolve({ organizationId, userId }) },
  );

/** Where a 303 lands: the members page with one code, and nothing else in the address. */
function landing(response: Response, organizationId = orgId): string {
  expect(response.status).toBe(303);
  const url = new URL(response.headers.get("location")!);
  expect(url.origin).toBe(SITE);
  expect(url.pathname).toBe(`/organizations/${organizationId}/members`);
  const entries = [...url.searchParams.entries()];
  expect(entries).toHaveLength(1);
  return entries.map(([key, value]) => `${key}=${value}`).join("");
}

const roleOf = async (userId: string, organizationId = orgId) =>
  (await deps.repos.memberships.find(organizationId, userId))?.role;

const audited = (action: string) => deps.repos.auditLogs.all().filter((entry) => entry.action === action);

describe("removing a member", () => {
  it("removes the member, and audits it with the Properties it leaves unassigned", async () => {
    expect(landing(await removing(ids.CREATOR!, { from: "CREATOR" }))).toBe("notice=member-removed");
    expect(await roleOf(ids.CREATOR!)).toBeUndefined();
    const entries = audited("member.removed").map(({ actorUserId, resourceId, metadata }) => ({
      actorUserId,
      resourceId,
      metadata,
    }));
    expect(entries).toEqual([
      { actorUserId: ownerId, resourceId: `${orgId}:${ids.CREATOR}`, metadata: { unassignedPropertyCount: 0 } },
    ]);
  });

  it("lets an admin remove a member below its ceiling, and an owner remove another owner", async () => {
    const coOwner = await member("co.owner", "OWNER");
    await signIn("team.admin");
    expect(landing(await removing(ids.VIEWER!, { from: "VIEWER" }))).toBe("notice=member-removed");
    await signIn("owner");
    expect(landing(await removing(coOwner, { from: "OWNER" }))).toBe("notice=member-removed");
    expect([await roleOf(ids.VIEWER!), await roleOf(coOwner)]).toEqual([undefined, undefined]);
  });

  it.each([
    ["ADMIN", "OWNER"],
    ["ADMIN", "ADMIN"],
    ["ADMIN", "BILLING"],
    ["MANAGER", "VIEWER"],
  ] as const)("refuses a %s removing a %s, and audits it", async (actor, target) => {
    await member(`acting.${actor}`, actor);
    await signIn(`acting.${actor}`);
    const targetId = target === "OWNER" ? ownerId : (ids[target] ?? (await member(`team.${target}`, target)));
    expect(landing(await removing(targetId, { from: target }))).toBe("error=may-not-remove");
    expect(await roleOf(targetId)).toBe(target);
    expect(audited("member.role_change_refused").map(({ metadata }) => metadata["operation"])).toEqual([
      "remove_member",
    ]);
  });

  it("finds no member who is unknown, an outsider, or of another organization", async () => {
    const outsider = await register("outsider");
    expect(landing(await removing("usr_unknown", { from: "CREATOR" }))).toBe("error=not-a-member");
    expect(landing(await removing(outsider, { from: "CREATOR" }))).toBe("error=not-a-member");
    const { organization } = await new OrganizationService(deps).createOrganization(outsider, { name: "Elsewhere" });
    const theirs = await member("their.creator", "CREATOR", organization.id);
    expect(landing(await removing(theirs, { from: "CREATOR" }))).toBe("error=not-a-member");
    // Through the other organization's address, the owner is no member there at all.
    expect(landing(await removing(theirs, { from: "CREATOR" }, organization.id), organization.id)).toBe(
      "error=may-not-remove",
    );
    expect(await roleOf(theirs, organization.id)).toBe("CREATOR");
  });

  it("removes no member whose role is not the one the page showed", async () => {
    // The page showed a Viewer; the member is a Creator now.
    expect(landing(await removing(ids.CREATOR!, { from: "VIEWER" }))).toBe("error=removal-member-changed");
    expect(await roleOf(ids.CREATOR!)).toBe("CREATOR");
    expect(audited("member.removed")).toEqual([]);
  });

  it.each([[{}], [{ from: "" }], [{ from: "creator" }], [{ from: "constructor" }]])(
    "removes nothing for %o, which does not say the role it showed",
    async (fields) => {
      const entries = deps.repos.auditLogs.all().length;
      expect(landing(await removing(ids.CREATOR!, fields))).toBe("error=removal-member-changed");
      expect(await roleOf(ids.CREATOR!)).toBe("CREATOR");
      expect(deps.repos.auditLogs.all()).toHaveLength(entries);
    },
  );

  it("asks the service nothing for a form without the role it showed, whoever posts it", async () => {
    await member("acting.viewer", "VIEWER");
    await signIn("acting.viewer");
    const entries = deps.repos.auditLogs.all().length;
    expect(landing(await removing(ids.CREATOR!, { from: "" }))).toBe("error=removal-member-changed");
    expect(deps.repos.auditLogs.all()).toHaveLength(entries);
  });

  it("asks the ceiling before the role shown, so a wrong one is still audited", async () => {
    await signIn("team.admin");
    expect(landing(await removing(ownerId, { from: "VIEWER" }))).toBe("error=may-not-remove");
    expect(audited("member.role_change_refused")).toHaveLength(1);
  });

  it("refuses unread an id longer than any account's, auditing nothing", async () => {
    await member("acting.viewer", "VIEWER");
    await signIn("acting.viewer");
    // An id of the longest length still reaches the service, which audits a VIEWER's refusal.
    expect(landing(await removing("u".repeat(64), { from: "VIEWER" }))).toBe("error=may-not-remove");
    const entries = deps.repos.auditLogs.all().length;
    expect(landing(await removing("u".repeat(65), { from: "VIEWER" }))).toBe("error=not-a-member");
    expect(deps.repos.auditLogs.all()).toHaveLength(entries);
  });

  it("never removes the last owner", async () => {
    expect(landing(await removing(ownerId, { from: "OWNER" }))).toBe("error=last-owner");
    expect(await roleOf(ownerId)).toBe("OWNER");
  });

  it("leaves an owner's own removal to the service, which allows it while another owner remains", async () => {
    // The page never offers it (ADR-0140); a crafted post is decided as any other.
    const coOwner = await member("co.owner", "OWNER");
    expect(landing(await removing(ownerId, { from: "OWNER" }))).toBe("notice=member-removed");
    expect([await roleOf(ownerId), await roleOf(coOwner)]).toEqual([undefined, "OWNER"]);
  });

  it("says when the member changed after the ceiling was asked", async () => {
    vi.spyOn(deps.repos.memberships, "remove").mockResolvedValue("STALE");
    expect(landing(await removing(ids.CREATOR!, { from: "CREATOR" }))).toBe("error=removal-member-changed");
  });

  it("answers a refusal it does not know as a failure, never by a name every object has", async () => {
    vi.spyOn(deps.repos.memberships, "remove").mockResolvedValue("constructor" as "STALE");
    expect(landing(await removing(ids.CREATOR!, { from: "CREATOR" }))).toBe("error=removal-failed");
  });

  it("logs a failure by its code alone, and says to check the list", async () => {
    vi.spyOn(deps.repos.memberships, "remove").mockRejectedValue(
      new Error(`lost team.creator@example.com ${ids.CREATOR}`),
    );
    const logged: unknown[] = [];
    const outcome = await removeOrganizationMember(ownerId, orgId, ids.CREATOR!, { from: "CREATOR" }, {
      error: (message, fields) => logged.push({ message, fields }),
    });
    expect(outcome).toEqual({ error: "removal-failed" });
    expect(logged).toEqual([{ message: "A member could not be removed", fields: { code: "UNEXPECTED" } }]);
    expect(await roleOf(ids.CREATOR!)).toBe("CREATOR");
  });

  it.each([
    ["no origin", {}],
    ["another site", { origin: "https://evil.example.net" }],
    ["another origin of the same site", { origin: "https://files.vtavision.test" }],
  ])("refuses a post from %s before reading anything", async (_what, headers) => {
    const response = await removing(ids.VIEWER!, { from: "VIEWER" }, orgId, headers);
    expect(response.status).toBe(403);
    expect(await roleOf(ids.VIEWER!)).toBe("VIEWER");
  });

  it("sends a signed-out visitor to sign in, removing nothing", async () => {
    cookie.value = undefined;
    const response = await removing(ids.VIEWER!, { from: "VIEWER" });
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    expect(await roleOf(ids.VIEWER!)).toBe("VIEWER");
  });
});
