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
import { InMemoryUnitsReader, createTestDeps, markEmailVerified, type TestDeps } from "@app/domain/testing";
import { hotp } from "@app/shared";

/**
 * Route tests for giving and taking back a member's individual permissions
 * from their permissions page (AT-11b, ADR-0147): a same-origin form post,
 * signed in, reaches the grant service, which decides and audits; the answer
 * is that page with a fixed code, or the members page when there is no such
 * member. Only the cookie store, the environment, the identity wiring and the
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

const { POST: grantRoute } = await import(
  "@/app/api/organizations/[organizationId]/members/[userId]/permissions/grant/route"
);
const { POST: revokeRoute } = await import(
  "@/app/api/organizations/[organizationId]/members/[userId]/permissions/revoke/route"
);
const { grantMemberPermission, revokeMemberPermission } = await import("@/lib/member-permissions");

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
  for (const role of ["ADMIN", "MANAGER", "CREATOR", "VIEWER"] as const) ids[role] = await member(`team.${role}`, role);
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
  userId: string,
  fields: Record<string, string>,
  organizationId = orgId,
  headers: Record<string, string> = { origin: SITE },
) =>
  (change === "grant" ? grantRoute : revokeRoute)(
    new Request(`${SITE}/api/organizations/${organizationId}/members/${userId}/permissions/${change}`, {
      method: "POST",
      headers: { host: "app.vtavision.test", "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    }),
    { params: Promise.resolve({ organizationId, userId }) },
  );

const giving = (userId: string, permission: string, organizationId = orgId) =>
  posting("grant", userId, { permission }, organizationId);
const takingBack = (userId: string, permission: string, organizationId = orgId) =>
  posting("revoke", userId, { permission }, organizationId);

/**
 * Where a 303 lands: the member's permissions page with one code, or, for
 * `members`, the members page; nothing else in the address.
 */
function landing(response: Response, userId: string | "members", organizationId = orgId): string {
  expect(response.status).toBe(303);
  const url = new URL(response.headers.get("location")!);
  expect(url.origin).toBe(SITE);
  const members = `/organizations/${organizationId}/members`;
  expect(url.pathname).toBe(userId === "members" ? members : `${members}/${userId}/permissions`);
  const entries = [...url.searchParams.entries()];
  expect(entries).toHaveLength(1);
  return entries.map(([key, value]) => `${key}=${value}`).join("");
}

const grantsOf = async (userId: string, organizationId = orgId) =>
  (await deps.repos.permissionGrants.listForMember(organizationId, userId)).map(({ permission }) => permission);

const audited = (action: string) => deps.repos.auditLogs.all().filter((entry) => entry.action === action);

describe("giving a member a permission", () => {
  it("gives it, audits it with the member's role, and says so on their page", async () => {
    expect(landing(await giving(ids.CREATOR!, "member.view"), ids.CREATOR!)).toBe("notice=granted");
    expect(await grantsOf(ids.CREATOR!)).toEqual(["member.view"]);
    expect(audited("permission.granted").map(({ actorUserId, metadata }) => ({ actorUserId, metadata }))).toEqual([
      {
        actorUserId: ownerId,
        metadata: { targetUserId: ids.CREATOR, targetRole: "CREATOR", permission: "member.view" },
      },
    ]);
  });

  it("writes and audits nothing for a permission given already", async () => {
    await giving(ids.CREATOR!, "member.view");
    const entries = deps.repos.auditLogs.all().length;
    expect(landing(await giving(ids.CREATOR!, "member.view"), ids.CREATOR!)).toBe("notice=granted");
    expect(await grantsOf(ids.CREATOR!)).toEqual(["member.view"]);
    expect(deps.repos.auditLogs.all()).toHaveLength(entries);
  });

  it("lets an admin give what it holds, and refuses and audits a protected permission", async () => {
    await signIn("team.admin");
    expect(landing(await giving(ids.MANAGER!, "member.manage"), ids.MANAGER!)).toBe("notice=granted");
    expect(landing(await giving(ids.MANAGER!, "billing.manage"), ids.MANAGER!)).toBe("error=may-not-grant");
    expect(await grantsOf(ids.MANAGER!)).toEqual(["member.manage"]);
    expect(audited("permission.grant_refused").map(({ metadata }) => metadata["reason"])).toEqual(["protected"]);
  });

  it.each([
    ["MANAGER", "CREATOR", "audit.view", "lacks_permission_manage"],
    ["ADMIN", "OWNER", "billing.manage", "target_role"],
    ["OWNER", "VIEWER", "property.create", "recipient_ceiling"],
    ["OWNER", "CREATOR", "video.share", "not_grantable"],
  ] as const)("refuses a %s giving a %s %s, and audits it", async (actor, target, permission, reason) => {
    await signIn(actor === "OWNER" ? "owner" : `team.${actor.toLowerCase()}`);
    const targetId = target === "OWNER" ? ownerId : ids[target]!;
    expect(landing(await giving(targetId, permission), targetId)).toBe("error=may-not-grant");
    expect(await grantsOf(targetId)).toEqual([]);
    expect(audited("permission.grant_refused").map(({ metadata }) => metadata["reason"])).toEqual([reason]);
  });

  it.each([[""], ["member.views"], ["MEMBER.VIEW"], ["constructor"], ["disclosure.none"]])(
    "refuses %o without asking the service",
    async (permission) => {
      const entries = deps.repos.auditLogs.all().length;
      expect(landing(await giving(ids.CREATOR!, permission), ids.CREATOR!)).toBe("error=permission");
      expect(landing(await posting("grant", ids.CREATOR!, {}), ids.CREATOR!)).toBe("error=permission");
      expect(await grantsOf(ids.CREATOR!)).toEqual([]);
      expect(deps.repos.auditLogs.all()).toHaveLength(entries);
    },
  );

  it("finds no member who is unknown, an outsider, or of another organization", async () => {
    const outsider = await register("outsider");
    expect(landing(await giving("usr_unknown", "audit.view"), "members")).toBe("error=not-a-member");
    expect(landing(await giving(outsider, "audit.view"), "members")).toBe("error=not-a-member");
    const { organization } = await new OrganizationService(deps).createOrganization(outsider, { name: "Elsewhere" });
    const theirs = await member("their.creator", "CREATOR", organization.id);
    expect(landing(await giving(theirs, "audit.view"), "members")).toBe("error=not-a-member");
    // Through the other organization's address, the owner is no member there at all.
    expect(landing(await giving(theirs, "audit.view", organization.id), theirs, organization.id)).toBe(
      "error=may-not-grant",
    );
    expect(await grantsOf(theirs, organization.id)).toEqual([]);
  });

  it("refuses unread an id longer than any account's, auditing nothing", async () => {
    await signIn("team.viewer");
    // An id of the longest length still reaches the service, which audits a VIEWER's refusal.
    expect(landing(await giving("u".repeat(64), "audit.view"), "u".repeat(64))).toBe("error=may-not-grant");
    const entries = deps.repos.auditLogs.all().length;
    expect(landing(await giving("u".repeat(65), "audit.view"), "members")).toBe("error=not-a-member");
    expect(deps.repos.auditLogs.all()).toHaveLength(entries);
  });

  it("logs a failure by its code alone, and says to check the page", async () => {
    vi.spyOn(deps.repos.permissionGrants, "insertIfAbsent").mockRejectedValue(
      new Error(`lost team.creator@example.com ${ids.CREATOR}`),
    );
    const logged: unknown[] = [];
    const outcome = await grantMemberPermission(ownerId, orgId, ids.CREATOR!, "audit.view", {
      error: (message, fields) => logged.push({ message, fields }),
    });
    expect(outcome).toEqual({ error: "grant-failed" });
    expect(logged).toEqual([{ message: "A permission could not be given", fields: { code: "UNEXPECTED" } }]);
  });
});

describe("taking back a member's individual permission", () => {
  beforeEach(async () => {
    const grants = new PermissionGrantService(deps);
    await grants.grant(ownerId, orgId, ids.MANAGER!, "audit.view");
    await grants.grant(ownerId, orgId, ids.MANAGER!, "disclosure.none");
    await grants.grant(ownerId, orgId, ids.ADMIN!, "billing.manage");
  });

  it("takes it back, audits it, and says so on their page", async () => {
    expect(landing(await takingBack(ids.MANAGER!, "audit.view"), ids.MANAGER!)).toBe("notice=revoked");
    expect(await grantsOf(ids.MANAGER!)).toEqual(["disclosure.none"]);
    expect(audited("permission.revoked").map(({ actorUserId, metadata }) => ({ actorUserId, metadata }))).toEqual([
      {
        actorUserId: ownerId,
        metadata: { targetUserId: ids.MANAGER, targetRole: "MANAGER", permission: "audit.view" },
      },
    ]);
  });

  it("takes back disclosure.none, which it never gives", async () => {
    expect(landing(await takingBack(ids.MANAGER!, "disclosure.none"), ids.MANAGER!)).toBe("notice=revoked");
    expect(await grantsOf(ids.MANAGER!)).toEqual(["audit.view"]);
  });

  it("says when the member holds no such grant any more, writing nothing", async () => {
    const entries = deps.repos.auditLogs.all().length;
    expect(landing(await takingBack(ids.MANAGER!, "audit.export"), ids.MANAGER!)).toBe("error=not-granted");
    expect(landing(await takingBack("usr_unknown", "audit.view"), "usr_unknown")).toBe("error=not-granted");
    expect(deps.repos.auditLogs.all()).toHaveLength(entries);
  });

  it.each([
    ["ADMIN", "ADMIN", "billing.manage", "target_role"],
    ["ADMIN", "MANAGER", "disclosure.none", "protected"],
    ["VIEWER", "MANAGER", "audit.view", "lacks_permission_manage"],
  ] as const)("refuses a %s taking back from a %s %s, and audits it", async (actor, target, permission, reason) => {
    await signIn(`team.${actor.toLowerCase()}`);
    const before = await grantsOf(ids[target]!);
    expect(landing(await takingBack(ids[target]!, permission), ids[target]!)).toBe("error=may-not-revoke");
    expect(await grantsOf(ids[target]!)).toEqual(before);
    expect(audited("permission.grant_refused").map(({ metadata }) => metadata["reason"])).toEqual([reason]);
  });

  it.each([[""], ["audit.views"], ["toString"]])("refuses %o without asking the service", async (permission) => {
    const entries = deps.repos.auditLogs.all().length;
    expect(landing(await takingBack(ids.MANAGER!, permission), ids.MANAGER!)).toBe("error=permission");
    expect(deps.repos.auditLogs.all()).toHaveLength(entries);
  });

  it("refuses unread an id longer than any account's", async () => {
    const entries = deps.repos.auditLogs.all().length;
    expect(landing(await takingBack("u".repeat(65), "audit.view"), "members")).toBe("error=not-a-member");
    expect(deps.repos.auditLogs.all()).toHaveLength(entries);
  });

  it("logs a failure by its code alone, and says to check the page", async () => {
    vi.spyOn(deps.repos.permissionGrants, "remove").mockRejectedValue(new Error("lost team.manager@example.com"));
    const logged: unknown[] = [];
    const outcome = await revokeMemberPermission(ownerId, orgId, ids.MANAGER!, "audit.view", {
      error: (message, fields) => logged.push({ message, fields }),
    });
    expect(outcome).toEqual({ error: "revoke-failed" });
    expect(logged).toEqual([{ message: "A permission could not be taken back", fields: { code: "UNEXPECTED" } }]);
  });
});

describe("either form post", () => {
  it.each([
    ["no origin", {}],
    ["another site", { origin: "https://evil.example.net" }],
    ["another origin of the same site", { origin: "https://files.vtavision.test" }],
  ])("is refused from %s before anything is read", async (_what, headers) => {
    for (const change of ["grant", "revoke"] as const) {
      const response = await posting(change, ids.CREATOR!, { permission: "audit.view" }, orgId, headers);
      expect(response.status).toBe(403);
    }
    expect(await grantsOf(ids.CREATOR!)).toEqual([]);
    expect(audited("permission.grant_refused")).toEqual([]);
  });

  it("sends a signed-out visitor to sign in, changing nothing", async () => {
    cookie.value = undefined;
    for (const change of ["grant", "revoke"] as const) {
      const response = await posting(change, ids.CREATOR!, { permission: "audit.view" });
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    }
    expect(await grantsOf(ids.CREATOR!)).toEqual([]);
  });
});
