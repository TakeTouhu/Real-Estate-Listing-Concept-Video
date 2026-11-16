import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthService,
  GroupService,
  MfaService,
  OrganizationService,
  PermissionGrantService,
  createMfaSecretCipher,
  systemMfaRandom,
  totpStep,
  type Role,
} from "@app/domain";
import { InMemoryUnitsReader, createTestDeps, markEmailVerified, type TestDeps } from "@app/domain/testing";
import { hotp } from "@app/shared";

/**
 * Route tests for giving a group a permission and taking one back from the
 * groups page (AT-11c, ADR-0148): a same-origin form post, signed in, reaches
 * the group service, which decides and audits; the answer is the groups page
 * with a fixed code. Only the cookie store, the environment, the identity
 * wiring and the subscriptions are stubbed: the session gate and the domain
 * services run for real.
 */
const PASSWORD = "password-123456";
const MFA_KEY = "79".repeat(32);
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

const { POST: grantRoute } = await import(
  "@/app/api/organizations/[organizationId]/groups/[groupId]/permissions/grant/route"
);
const { POST: revokeRoute } = await import(
  "@/app/api/organizations/[organizationId]/groups/[groupId]/permissions/revoke/route"
);
const { grantGroupPermission, revokeGroupPermission } = await import("@/lib/groups");

let deps: TestDeps;
let auth: AuthService;
let groups: GroupService;
let orgId: string;
let ownerId: string;
let ids: Record<string, string>;
let team: string;

beforeEach(async () => {
  deps = createTestDeps();
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  identity.value = { deps, auth, organizations: new OrganizationService(deps) };
  subscriptions.value = new InMemoryUnitsReader();
  env.value = { NODE_ENV: "test", USER_SESSION_TTL_SECONDS: 3600, MFA_SECRET_KEY: MFA_KEY };
  groups = new GroupService(deps);
  ownerId = await register("owner");
  ({ organization: { id: orgId } } = await new OrganizationService(deps).createOrganization(ownerId, {
    name: "Studio Kanda",
  }));
  ids = {};
  sessions.clear();
  for (const role of ["ADMIN", "MANAGER", "CREATOR", "VIEWER"] as const) ids[role] = await member(`team.${role}`, role);
  // A group of members an ADMIN may manage.
  team = (await groups.create(ownerId, orgId, "Team")).id;
  for (const role of ["MANAGER", "CREATOR"]) await groups.addMember(ownerId, orgId, team, ids[role]!);
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

const posting = (
  change: "grant" | "revoke",
  groupId: string,
  fields: Record<string, string> | [string, string][],
  organizationId = orgId,
  headers: Record<string, string> = { origin: SITE },
) =>
  (change === "grant" ? grantRoute : revokeRoute)(
    new Request(`${SITE}/api/organizations/${organizationId}/groups/${groupId}/permissions/${change}`, {
      method: "POST",
      headers: { host: "app.vtavision.test", "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    }),
    { params: Promise.resolve({ organizationId, groupId }) },
  );

const giving = (groupId: string, permission: string, organizationId = orgId) =>
  posting("grant", groupId, { permission }, organizationId);
const takingBack = (groupId: string, permission: string, organizationId = orgId) =>
  posting("revoke", groupId, { permission }, organizationId);

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

const permissionsOf = async (groupId: string, organizationId = orgId) =>
  (await deps.repos.groups.listPermissions(organizationId, groupId)).map(({ permission }) => permission).sort();

const audited = (action: string) => deps.repos.auditLogs.all().filter((entry) => entry.action === action);
const refusals = () => audited("group.change_refused").map(({ metadata }) => metadata["reason"]);

describe("giving a group a permission", () => {
  it("gives it, audits it with the members it reaches, and says so on the groups page", async () => {
    expect(landing(await giving(team, "audit.view"))).toBe("notice=group-permission-granted");
    expect(await permissionsOf(team)).toEqual(["audit.view"]);
    const entries = audited("group.permission_granted");
    expect(entries.map(({ actorUserId, resourceId, metadata }) => ({ actorUserId, resourceId, metadata }))).toEqual([
      { actorUserId: ownerId, resourceId: team, metadata: { permission: "audit.view", memberCount: 2 } },
    ]);
  });

  it("writes and audits nothing for a permission the group gives already", async () => {
    await giving(team, "audit.view");
    const entries = deps.repos.auditLogs.all().length;
    expect(landing(await giving(team, "audit.view"))).toBe("notice=group-permission-granted");
    expect(deps.repos.auditLogs.all()).toHaveLength(entries);
  });

  it("lets an admin give what it holds, and refuses and audits a protected permission", async () => {
    await signIn("team.admin");
    expect(landing(await giving(team, "member.manage"))).toBe("notice=group-permission-granted");
    expect(landing(await giving(team, "billing.manage"))).toBe("error=may-not-grant-group-permission");
    expect(await permissionsOf(team)).toEqual(["member.manage"]);
    expect(refusals()).toEqual(["protected"]);
  });

  it.each([
    ["MANAGER", "audit.view", "lacks_permission_manage"],
    ["OWNER", "disclosure.none", "not_grantable"],
    ["OWNER", "video.share", "not_grantable"],
  ] as const)("refuses a %s giving %s, and audits it", async (actor, permission, reason) => {
    await signIn(actor === "OWNER" ? "owner" : `team.${actor.toLowerCase()}`);
    expect(landing(await giving(team, permission))).toBe("error=may-not-grant-group-permission");
    expect(await permissionsOf(team)).toEqual([]);
    expect(refusals()).toEqual([reason]);
  });

  it("refuses an admin a group with a member whose role it may not manage, and audits it", async () => {
    await groups.addMember(ownerId, orgId, team, ownerId);
    await signIn("team.admin");
    expect(landing(await giving(team, "audit.view"))).toBe("error=may-not-grant-group-permission");
    expect(await permissionsOf(team)).toEqual([]);
    expect(audited("group.change_refused").map(({ metadata }) => metadata)).toEqual([
      expect.objectContaining({ reason: "target_role", targetUserId: ownerId, targetRole: "OWNER" }),
    ]);
  });

  it("lets a manager given permission.manage give a group with no members what it holds, and no other", async () => {
    await new PermissionGrantService(deps).grant(ownerId, orgId, ids.MANAGER!, "permission.manage");
    const empty = (await groups.create(ownerId, orgId, "Empty")).id;
    await signIn("team.manager");
    expect(landing(await giving(empty, "unit.view"))).toBe("notice=group-permission-granted");
    expect(landing(await giving(team, "unit.view"))).toBe("error=may-not-grant-group-permission");
    expect([await permissionsOf(empty), await permissionsOf(team)]).toEqual([["unit.view"], []]);
  });

  it.each([[""], ["audit.views"], ["AUDIT.VIEW"], ["constructor"]])(
    "refuses %o without asking the service",
    async (permission) => {
      const entries = deps.repos.auditLogs.all().length;
      expect(landing(await giving(team, permission))).toBe("error=group-permission");
      expect(deps.repos.auditLogs.all()).toHaveLength(entries);
    },
  );

  it("refuses a form without a permission without asking the service, and gives the first one named", async () => {
    const entries = deps.repos.auditLogs.all().length;
    expect(landing(await posting("grant", team, {}))).toBe("error=group-permission");
    expect(deps.repos.auditLogs.all()).toHaveLength(entries);
    const fields: [string, string][] = [
      ["permission", "audit.view"],
      ["permission", "billing.manage"],
    ];
    expect(landing(await posting("grant", team, fields))).toBe("notice=group-permission-granted");
    expect(await permissionsOf(team)).toEqual(["audit.view"]);
  });

  it("finds no group that is unknown or of another organization, and refuses a non-member unaudited", async () => {
    const outsider = await register("outsider");
    const { organization } = await new OrganizationService(deps).createOrganization(outsider, { name: "Elsewhere" });
    const theirs = (await groups.create(outsider, organization.id, "Theirs")).id;
    expect(landing(await giving("grp_unknown", "audit.view"))).toBe("error=group-gone");
    expect(landing(await giving(theirs, "audit.view"))).toBe("error=group-gone");
    // Through the other organization's address, the owner is no member there at all.
    expect(landing(await giving(theirs, "audit.view", organization.id), organization.id)).toBe(
      "error=may-not-grant-group-permission",
    );
    expect(await permissionsOf(theirs, organization.id)).toEqual([]);
    expect(audited("group.change_refused")).toEqual([]);
  });

  it("refuses unread a group id longer than any group's, auditing nothing", async () => {
    await signIn("team.viewer");
    // An id of the longest length still reaches the service, which audits a VIEWER's refusal.
    expect(landing(await giving("g".repeat(64), "audit.view"))).toBe("error=may-not-grant-group-permission");
    const entries = deps.repos.auditLogs.all().length;
    expect(landing(await giving("g".repeat(65), "audit.view"))).toBe("error=group-gone");
    expect(deps.repos.auditLogs.all()).toHaveLength(entries);
  });

  it("logs a failure by its code alone, and says to check the page", async () => {
    vi.spyOn(deps.repos.groups, "grantPermission").mockRejectedValue(new Error(`lost Team ${team}`));
    const logged: unknown[] = [];
    const outcome = await grantGroupPermission(ownerId, orgId, team, "audit.view", {
      error: (message, fields) => logged.push({ message, fields }),
    });
    expect(outcome).toEqual({ error: "grant-group-permission-failed" });
    expect(logged).toEqual([
      { message: "A permission could not be given to a group", fields: { code: "UNEXPECTED" } },
    ]);
  });
});

describe("taking a permission back from a group", () => {
  beforeEach(async () => {
    await groups.grantPermission(ownerId, orgId, team, "audit.view");
    await groups.grantPermission(ownerId, orgId, team, "billing.manage");
  });

  it("takes it back, audits it, and says so on the groups page", async () => {
    expect(landing(await takingBack(team, "audit.view"))).toBe("notice=group-permission-revoked");
    expect(await permissionsOf(team)).toEqual(["billing.manage"]);
    const entries = audited("group.permission_revoked");
    expect(entries.map(({ actorUserId, resourceId, metadata }) => ({ actorUserId, resourceId, metadata }))).toEqual([
      { actorUserId: ownerId, resourceId: team, metadata: { permission: "audit.view", memberCount: 2 } },
    ]);
  });

  it("says when the group does not give it, or is gone, writing nothing", async () => {
    const entries = deps.repos.auditLogs.all().length;
    expect(landing(await takingBack(team, "audit.export"))).toBe("error=group-permission-not-granted");
    expect(landing(await takingBack("grp_unknown", "audit.view"))).toBe("error=group-gone");
    expect(landing(await takingBack("g".repeat(65), "audit.view"))).toBe("error=group-gone");
    expect(deps.repos.auditLogs.all()).toHaveLength(entries);
  });

  it("refuses unread a group id longer than any group's, auditing nothing", async () => {
    await signIn("team.viewer");
    // An id of the longest length still reaches the service, which audits a VIEWER's refusal.
    expect(landing(await takingBack("g".repeat(64), "audit.view"))).toBe("error=may-not-revoke-group-permission");
    const entries = deps.repos.auditLogs.all().length;
    expect(landing(await takingBack("g".repeat(65), "audit.view"))).toBe("error=group-gone");
    expect(deps.repos.auditLogs.all()).toHaveLength(entries);
  });

  it.each([
    ["ADMIN", "billing.manage", "protected"],
    ["VIEWER", "audit.view", "lacks_permission_manage"],
  ] as const)("refuses a %s taking back %s, and audits it", async (actor, permission, reason) => {
    await signIn(`team.${actor.toLowerCase()}`);
    expect(landing(await takingBack(team, permission))).toBe("error=may-not-revoke-group-permission");
    expect(await permissionsOf(team)).toEqual(["audit.view", "billing.manage"]);
    expect(refusals()).toEqual([reason]);
  });

  it.each([[""], ["audit.views"], ["toString"]])("refuses %o without asking the service", async (permission) => {
    const entries = deps.repos.auditLogs.all().length;
    expect(landing(await takingBack(team, permission))).toBe("error=group-permission");
    expect(deps.repos.auditLogs.all()).toHaveLength(entries);
  });

  it("logs a failure by its code alone, and says to check the page", async () => {
    vi.spyOn(deps.repos.groups, "revokePermission").mockRejectedValue(new Error(`lost Team ${team}`));
    const logged: unknown[] = [];
    const outcome = await revokeGroupPermission(ownerId, orgId, team, "audit.view", {
      error: (message, fields) => logged.push({ message, fields }),
    });
    expect(outcome).toEqual({ error: "revoke-group-permission-failed" });
    expect(logged).toEqual([
      { message: "A permission could not be taken back from a group", fields: { code: "UNEXPECTED" } },
    ]);
  });
});

describe("either form post", () => {
  it.each([
    ["no origin", {}],
    ["another site", { origin: "https://evil.example.net" }],
    ["another origin of the same site", { origin: "https://files.vtavision.test" }],
  ])("is refused from %s before anything is read", async (_what, headers) => {
    await groups.grantPermission(ownerId, orgId, team, "unit.view");
    for (const [change, permission] of [
      ["grant", "audit.view"],
      ["revoke", "unit.view"],
    ] as const) {
      const response = await posting(change, team, { permission }, orgId, headers);
      expect(response.status).toBe(403);
    }
    expect(await permissionsOf(team)).toEqual(["unit.view"]);
    expect(audited("group.change_refused")).toEqual([]);
  });

  it("sends a signed-out visitor to sign in, changing nothing", async () => {
    cookie.value = undefined;
    for (const change of ["grant", "revoke"] as const) {
      const response = await posting(change, team, { permission: "audit.view" });
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    }
    expect(await permissionsOf(team)).toEqual([]);
  });
});
