import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthService,
  GroupService,
  MfaService,
  OrganizationService,
  PermissionGrantService,
  PropertyService,
  createMfaSecretCipher,
  systemMfaRandom,
  totpStep,
  type Role,
} from "@app/domain";
import {
  InMemoryMediaAssetRepository,
  InMemoryPropertyRepository,
  createTestDeps,
  markEmailVerified,
  type TestDeps,
} from "@app/domain/testing";
import { AppError, hotp } from "@app/shared";
import { pathOf } from "./redirect-location";

/**
 * Route tests for creating a group from the groups page (AT-9a, ADR-0141),
 * renaming and deleting one (AT-9b, ADR-0142), and adding and removing its
 * members (AT-9c, ADR-0143): a same-origin form post, signed
 * in, reaches the group service, which decides and audits; the answer is the
 * groups page with a fixed code, never a name.
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
const { POST: rename } = await import("@/app/api/organizations/[organizationId]/groups/[groupId]/rename/route");
const { POST: remove } = await import("@/app/api/organizations/[organizationId]/groups/[groupId]/delete/route");
const { POST: add } = await import("@/app/api/organizations/[organizationId]/groups/[groupId]/members/route");
const { POST: leave } = await import(
  "@/app/api/organizations/[organizationId]/groups/[groupId]/members/[userId]/remove/route"
);
const { GROUP_ID_MAX_LENGTH, addGroupMember, createGroup, deleteGroup, removeGroupMember, renameGroup } =
  await import("@/lib/groups");

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

type HeaderFields = Record<string, string>;

/** A post of `fields` to one group's change. */
const changing = (
  route: typeof rename,
  change: "rename" | "delete" | "members",
  groupId: string,
  fields: Record<string, string>,
  organizationId = orgId,
  headers: HeaderFields = { origin: SITE },
) =>
  route(
    new Request(`${SITE}/api/organizations/${organizationId}/groups/${encodeURIComponent(groupId)}/${change}`, {
      method: "POST",
      headers: { host: "app.vtavision.test", "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    }),
    { params: Promise.resolve({ organizationId, groupId }) },
  );

const renaming = (groupId: string, fields: Record<string, string>, organizationId = orgId, headers?: HeaderFields) =>
  changing(rename, "rename", groupId, fields, organizationId, headers);

const deleting = (groupId: string, organizationId = orgId, headers?: HeaderFields) =>
  changing(remove, "delete", groupId, {}, organizationId, headers);

const adding = (groupId: string, userId: string, organizationId = orgId, headers?: HeaderFields) =>
  changing(add, "members", groupId, { userId }, organizationId, headers);

/** A post that removes `userId` from a group. */
const removing = (groupId: string, userId: string, organizationId = orgId, headers: HeaderFields = { origin: SITE }) =>
  leave(
    new Request(
      `${SITE}/api/organizations/${organizationId}/groups/${encodeURIComponent(groupId)}` +
        `/members/${encodeURIComponent(userId)}/remove`,
      { method: "POST", headers: { host: "app.vtavision.test", ...headers } },
    ),
    { params: Promise.resolve({ organizationId, groupId, userId }) },
  );

/** Who is in a group. */
const inGroup = async (groupId: string, organizationId = orgId) =>
  (await deps.repos.groups.listMembers(organizationId, groupId)).map(({ userId }) => userId);

/** A group of the organization, made by its owner; returns its id. */
const newGroup = async (name: string, organizationId = orgId, by = ownerId) =>
  (await new GroupService(deps).create(by, organizationId, name)).id;

/** Where a 303 lands: the groups page with one code, and nothing else in the address. */
function landing(response: Response, organizationId = orgId): string {
  expect(response.status).toBe(303);
  const url = pathOf(response);
  expect(url.pathname).toBe(`/organizations/${organizationId}/groups`);
  const entries = [...url.searchParams.entries()];
  expect(entries).toHaveLength(1);
  return entries.map(([key, value]) => `${key}=${value}`).join("");
}

const names = async (organizationId = orgId) =>
  (await deps.repos.groups.listByOrganization(organizationId)).map(({ name }) => name);

const audited = (action: string) => deps.repos.auditLogs.all().filter((entry) => entry.action === action);

/** Who an audit entry names, what it is about, and what it records. */
const entryOf = ({ actorUserId, resourceId, metadata }: ReturnType<typeof audited>[number]) => ({
  actorUserId,
  resourceId,
  metadata,
});

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

  it("answers a stale reason, which no creation gives, as a failure", async () => {
    vi.spyOn(deps.repos.groups, "create").mockRejectedValue(
      new AppError("VALIDATION_FAILED", "Changed", { details: { reason: "STALE" } }),
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
    expect(response.headers.get("location")).toBe("/login");
    expect(await names()).toEqual([]);
  });
});

describe("renaming a group", () => {
  it("renames the group still named as shown, under the trimmed name, and audits it", async () => {
    const east = await newGroup("East");
    expect(landing(await renaming(east, { name: "  East office ", from: "East" }))).toBe("notice=group-renamed");
    expect(await names()).toEqual(["East office"]);
    expect(audited("group.renamed").map(entryOf)).toEqual([
      { actorUserId: ownerId, resourceId: east, metadata: { name: "East office", previousName: "East" } },
    ]);
  });

  it("saves the name it has, writing nothing", async () => {
    const east = await newGroup("East");
    expect(landing(await renaming(east, { name: " East ", from: "East" }))).toBe("notice=group-renamed");
    expect(audited("group.renamed")).toEqual([]);
  });

  it("lets an admin rename one, and a manager granted group.manage", async () => {
    const east = await newGroup("East");
    await member("team.admin", "ADMIN");
    const manager = await member("team.manager", "MANAGER");
    await new PermissionGrantService(deps).grant(ownerId, orgId, manager, "group.manage");
    await signIn("team.admin");
    expect(landing(await renaming(east, { name: "North", from: "East" }))).toBe("notice=group-renamed");
    await signIn("team.manager");
    expect(landing(await renaming(east, { name: "South", from: "North" }))).toBe("notice=group-renamed");
    expect(await names()).toEqual(["South"]);
  });

  it.each(["MANAGER", "CREATOR", "VIEWER", "BILLING"] as const)(
    "refuses a %s, who lacks group.manage, and audits it",
    async (role) => {
      const east = await newGroup("East");
      await member(`acting.${role}`, role);
      await signIn(`acting.${role}`);
      expect(landing(await renaming(east, { name: "", from: "Elsewhere" }))).toBe("error=may-not-rename-group");
      expect(await names()).toEqual(["East"]);
      expect(audited("group.change_refused").map(({ metadata }) => metadata)).toEqual([
        { operation: "rename", reason: "lacks_group_manage", actorRole: role, groupId: east },
      ]);
    },
  );

  it.each([[{ name: "" }], [{ name: "   " }], [{ name: "x".repeat(101) }], [{ name: "East\u0000office" }], [{}]])(
    "renames nothing for %o, and asks for a name",
    async (fields) => {
      const east = await newGroup("East");
      expect(landing(await renaming(east, { ...fields, from: "East" }))).toBe("error=group-name");
      expect(await names()).toEqual(["East"]);
    },
  );

  it("asks for a name before the group or the name it showed", async () => {
    const east = await newGroup("East");
    expect(landing(await renaming(east, { name: "", from: "Old East" }))).toBe("error=group-name");
    expect(landing(await renaming("grp_missing", { name: "", from: "East" }))).toBe("error=group-name");
  });

  it("says when another group has the name, renaming nothing", async () => {
    await newGroup("East");
    const west = await newGroup("West");
    expect(landing(await renaming(west, { name: " East", from: "West" }))).toBe("error=group-name-taken");
    expect(await names()).toEqual(["East", "West"]);
  });

  it.each([["renamed meanwhile", { from: "Old East" }], ["without the name shown", {}]])(
    "renames nothing for a form %s, and says the group changed",
    async (_what, shown) => {
      const east = await newGroup("East");
      expect(landing(await renaming(east, { name: "North", ...shown }))).toBe("error=group-changed");
      expect(await names()).toEqual(["East"]);
      expect(audited("group.renamed")).toEqual([]);
    },
  );

  it("says the group changed when another rename commits first", async () => {
    const east = await newGroup("East");
    vi.spyOn(deps.repos.groups, "rename").mockResolvedValue({ outcome: "STALE" });
    expect(landing(await renaming(east, { name: "North", from: "East" }))).toBe("error=group-changed");
  });

  it("asks a form without the name shown for the permission first, so its refusal is audited", async () => {
    const east = await newGroup("East");
    await member("acting.viewer", "VIEWER");
    await signIn("acting.viewer");
    expect(landing(await renaming(east, { name: "North" }))).toBe("error=may-not-rename-group");
    expect(audited("group.change_refused")).toHaveLength(1);
  });

  it("finds no group of another organization, nor a missing one, renaming nothing", async () => {
    const outsider = await register("outsider");
    const { organization } = await new OrganizationService(deps).createOrganization(outsider, { name: "Elsewhere" });
    const theirs = await newGroup("Theirs", organization.id, outsider);
    expect(landing(await renaming(theirs, { name: "Mine", from: "Theirs" }))).toBe("error=group-gone");
    expect(landing(await renaming("grp_missing", { name: "Mine", from: "Theirs" }))).toBe("error=group-gone");
    expect(await names(organization.id)).toEqual(["Theirs"]);
  });

  it("refuses an organization the poster is no member of, writing nothing there", async () => {
    const outsider = await register("outsider");
    const { organization } = await new OrganizationService(deps).createOrganization(outsider, { name: "Elsewhere" });
    const theirs = await newGroup("Theirs", organization.id, outsider);
    const answer = landing(await renaming(theirs, { name: "Mine", from: "Theirs" }, organization.id), organization.id);
    expect(answer).toBe("error=may-not-rename-group");
    expect(await names(organization.id)).toEqual(["Theirs"]);
    expect(audited("group.change_refused")).toEqual([]);
  });

  it("refuses an id longer than any group's unread, so it never reaches the audit log", async () => {
    await member("acting.viewer", "VIEWER");
    await signIn("acting.viewer");
    const longest = "g".repeat(GROUP_ID_MAX_LENGTH);
    expect(landing(await renaming(`${longest}g`, { name: "North", from: "East" }))).toBe("error=group-gone");
    expect(landing(await renaming(longest, { name: "North", from: "East" }))).toBe("error=may-not-rename-group");
    expect(audited("group.change_refused").map(({ resourceId }) => resourceId)).toEqual([longest]);
  });

  it("asks nothing for an empty id, so it never reaches the audit log", async () => {
    const viewer = await member("acting.viewer", "VIEWER");
    expect(await renameGroup(viewer, orgId, "", { name: "North", from: "East" })).toEqual({ error: "group-gone" });
    expect(await deleteGroup(viewer, orgId, "")).toEqual({ error: "group-gone" });
    expect(audited("group.change_refused")).toEqual([]);
  });

  it("answers a refusal it does not know, or a reason on another error, as a failure", async () => {
    const east = await newGroup("East");
    const spy = vi.spyOn(deps.repos.groups, "rename");
    spy.mockRejectedValueOnce(new AppError("VALIDATION_FAILED", "Refused", { details: { reason: "constructor" } }));
    expect(landing(await renaming(east, { name: "North", from: "East" }))).toBe("error=rename-group-failed");
    spy.mockRejectedValueOnce(new AppError("INTERNAL_ERROR", "Lost", { details: { reason: "STALE" } }));
    expect(landing(await renaming(east, { name: "North", from: "East" }))).toBe("error=rename-group-failed");
  });

  it("logs a failure by its code alone, never a name, and says to check the list", async () => {
    const east = await newGroup("East");
    vi.spyOn(deps.repos.groups, "rename").mockRejectedValue(new Error("lost the group Secret project"));
    const logged: unknown[] = [];
    const outcome = await renameGroup(ownerId, orgId, east, { name: "Secret project", from: "East" }, {
      error: (message, fields) => logged.push({ message, fields }),
    });
    expect(outcome).toEqual({ error: "rename-group-failed" });
    expect(logged).toEqual([{ message: "A group could not be renamed", fields: { code: "UNEXPECTED" } }]);
  });

  it.each([
    ["no origin", {}],
    ["another site", { origin: "https://evil.example.net" }],
  ])("refuses a post from %s before reading anything", async (_what, headers) => {
    const east = await newGroup("East");
    const response = await renaming(east, { name: "North", from: "East" }, orgId, headers);
    expect(response.status).toBe(403);
    expect(await names()).toEqual(["East"]);
  });

  it("sends a signed-out visitor to sign in, renaming nothing", async () => {
    const east = await newGroup("East");
    cookie.value = undefined;
    const response = await renaming(east, { name: "North", from: "East" });
    expect(response.headers.get("location")).toBe("/login");
    expect(await names()).toEqual(["East"]);
  });
});

describe("deleting a group", () => {
  it("deletes the group, keeping its members in the organization, and audits it", async () => {
    const east = await newGroup("East");
    const viewer = await member("team.viewer", "VIEWER");
    await new GroupService(deps).addMember(ownerId, orgId, east, viewer);
    expect(landing(await deleting(east))).toBe("notice=group-deleted");
    expect(await names()).toEqual([]);
    expect((await deps.repos.memberships.find(orgId, viewer))?.role).toBe("VIEWER");
    expect(audited("group.deleted").map(entryOf)).toEqual([
      {
        actorUserId: ownerId,
        resourceId: east,
        metadata: { name: "East", actorRole: "OWNER", removedMemberCount: 1, ungroupedPropertyCount: 0 },
      },
    ]);
  });

  it("leaves the group's Properties with no group, counting them", async () => {
    const east = await newGroup("East");
    const properties = new InMemoryPropertyRepository(deps.clock, deps.repos);
    const assets = new InMemoryMediaAssetRepository(deps.clock);
    const service = new PropertyService({ identity: deps, properties, assets, clock: deps.clock, ids: deps.ids });
    const property = await service.create(ownerId, {
      organizationId: orgId,
      name: "Harbor View",
      propertyType: "APARTMENT",
      rightsConfirmed: true,
      groupId: east,
    });
    expect(landing(await deleting(east))).toBe("notice=group-deleted");
    expect((await properties.findById(orgId, property.id))?.groupId).toBeNull();
    expect(audited("group.deleted")[0]?.metadata).toMatchObject({ ungroupedPropertyCount: 1 });
  });

  it("lets an admin delete one", async () => {
    const east = await newGroup("East");
    await member("team.admin", "ADMIN");
    await signIn("team.admin");
    expect(landing(await deleting(east))).toBe("notice=group-deleted");
    expect(await names()).toEqual([]);
  });

  it("refuses a manager granted group.manage, which never reaches deletion, and audits it", async () => {
    const east = await newGroup("East");
    const manager = await member("team.manager", "MANAGER");
    await new PermissionGrantService(deps).grant(ownerId, orgId, manager, "group.manage");
    await signIn("team.manager");
    expect(landing(await deleting(east))).toBe("error=may-not-delete-group");
    expect(await names()).toEqual(["East"]);
    expect(audited("group.change_refused").map(({ metadata }) => metadata)).toEqual([
      { operation: "delete", reason: "protected_delete", actorRole: "MANAGER", groupId: east },
    ]);
  });

  it.each(["MANAGER", "CREATOR", "VIEWER", "BILLING"] as const)("refuses a %s, lacking group.manage", async (role) => {
    const east = await newGroup("East");
    await member(`acting.${role}`, role);
    await signIn(`acting.${role}`);
    expect(landing(await deleting(east))).toBe("error=may-not-delete-group");
    expect(await names()).toEqual(["East"]);
    expect(audited("group.change_refused").map(({ metadata }) => metadata.reason)).toEqual(["lacks_group_manage"]);
  });

  it("refuses an admin a group whose permission it may not take from a member, deleting nothing", async () => {
    const east = await newGroup("East");
    const groups = new GroupService(deps);
    await groups.addMember(ownerId, orgId, east, ownerId);
    await groups.grantPermission(ownerId, orgId, east, "property.view");
    await member("team.admin", "ADMIN");
    await signIn("team.admin");
    expect(landing(await deleting(east))).toBe("error=may-not-delete-group");
    expect(await names()).toEqual(["East"]);
  });

  it("finds no group of another organization, nor one deleted already", async () => {
    const outsider = await register("outsider");
    const { organization } = await new OrganizationService(deps).createOrganization(outsider, { name: "Elsewhere" });
    const theirs = await newGroup("Theirs", organization.id, outsider);
    expect(landing(await deleting(theirs))).toBe("error=group-gone");
    expect(await names(organization.id)).toEqual(["Theirs"]);
    const east = await newGroup("East");
    await deleting(east);
    expect(landing(await deleting(east))).toBe("error=group-gone");
    expect(audited("group.deleted")).toHaveLength(1);
  });

  it("refuses an organization the poster is no member of, deleting nothing there", async () => {
    const outsider = await register("outsider");
    const { organization } = await new OrganizationService(deps).createOrganization(outsider, { name: "Elsewhere" });
    const theirs = await newGroup("Theirs", organization.id, outsider);
    expect(landing(await deleting(theirs, organization.id), organization.id)).toBe("error=may-not-delete-group");
    expect(await names(organization.id)).toEqual(["Theirs"]);
    expect(audited("group.change_refused")).toEqual([]);
  });

  it("refuses an id longer than any group's unread, so it never reaches the audit log", async () => {
    await member("acting.viewer", "VIEWER");
    await signIn("acting.viewer");
    expect(landing(await deleting("g".repeat(GROUP_ID_MAX_LENGTH + 1)))).toBe("error=group-gone");
    expect(audited("group.change_refused")).toEqual([]);
  });

  it("logs a failure by its code alone, and says to check the list", async () => {
    const east = await newGroup("Secret project");
    vi.spyOn(deps.repos.groups, "delete").mockRejectedValue(new Error("lost the group Secret project"));
    const logged: unknown[] = [];
    const outcome = await deleteGroup(ownerId, orgId, east, {
      error: (message, fields) => logged.push({ message, fields }),
    });
    expect(outcome).toEqual({ error: "delete-group-failed" });
    expect(logged).toEqual([{ message: "A group could not be deleted", fields: { code: "UNEXPECTED" } }]);
  });

  it.each([
    ["no origin", {}],
    ["another site", { origin: "https://evil.example.net" }],
  ])("refuses a post from %s before reading anything", async (_what, headers) => {
    const east = await newGroup("East");
    expect((await deleting(east, orgId, headers)).status).toBe(403);
    expect(await names()).toEqual(["East"]);
  });

  it("sends a signed-out visitor to sign in, deleting nothing", async () => {
    const east = await newGroup("East");
    cookie.value = undefined;
    const response = await deleting(east);
    expect(response.headers.get("location")).toBe("/login");
    expect(await names()).toEqual(["East"]);
  });
});

describe("adding a group's member", () => {
  it("adds a member of the organization, and audits it with their role", async () => {
    const east = await newGroup("East");
    const viewer = await member("team.viewer", "VIEWER");
    expect(landing(await adding(east, viewer))).toBe("notice=group-member-added");
    expect(await inGroup(east)).toEqual([viewer]);
    expect(audited("group.member_added").map(entryOf)).toEqual([
      { actorUserId: ownerId, resourceId: east, metadata: { targetUserId: viewer, targetRole: "VIEWER" } },
    ]);
  });

  it("says a member already in the group is in it, writing nothing", async () => {
    const east = await newGroup("East");
    const viewer = await member("team.viewer", "VIEWER");
    await adding(east, viewer);
    expect(landing(await adding(east, viewer))).toBe("notice=group-member-added");
    expect(audited("group.member_added")).toHaveLength(1);
  });

  it("lets an owner add itself, and an admin a manager, creator or viewer", async () => {
    const east = await newGroup("East");
    expect(landing(await adding(east, ownerId))).toBe("notice=group-member-added");
    const added = [];
    for (const role of ["MANAGER", "CREATOR", "VIEWER"] as const) added.push(await member(`team.${role}`, role));
    await member("team.admin", "ADMIN");
    await signIn("team.admin");
    for (const userId of added) expect(landing(await adding(east, userId))).toBe("notice=group-member-added");
    expect((await inGroup(east)).sort()).toEqual([ownerId, ...added].sort());
  });

  it("refuses an admin a member whose role it may not assign, itself included, and audits it", async () => {
    const east = await newGroup("East");
    const admin = await member("team.admin", "ADMIN");
    const billing = await member("team.billing", "BILLING");
    await signIn("team.admin");
    for (const userId of [ownerId, admin, billing]) {
      expect(landing(await adding(east, userId))).toBe("error=may-not-add-group-member");
    }
    expect(await inGroup(east)).toEqual([]);
    expect(audited("group.change_refused").map(({ metadata }) => [metadata.reason, metadata.targetRole])).toEqual([
      ["target_role", "OWNER"],
      ["target_role", "ADMIN"],
      ["target_role", "BILLING"],
    ]);
  });

  it("refuses a manager granted group.manage, whom the ceiling lets add no one", async () => {
    const east = await newGroup("East");
    const manager = await member("team.manager", "MANAGER");
    const viewer = await member("team.viewer", "VIEWER");
    await new PermissionGrantService(deps).grant(ownerId, orgId, manager, "group.manage");
    await signIn("team.manager");
    expect(landing(await adding(east, viewer))).toBe("error=may-not-add-group-member");
    expect(audited("group.change_refused").map(({ metadata }) => metadata.reason)).toEqual(["target_role"]);
  });

  it.each(["MANAGER", "CREATOR", "VIEWER", "BILLING"] as const)(
    "refuses a %s, lacking group.manage, and audits it",
    async (role) => {
      const east = await newGroup("East");
      const viewer = await member("team.viewer", "VIEWER");
      await member(`acting.${role}`, role);
      await signIn(`acting.${role}`);
      expect(landing(await adding(east, viewer))).toBe("error=may-not-add-group-member");
      expect(audited("group.change_refused").map(({ metadata }) => metadata.reason)).toEqual(["lacks_group_manage"]);
    },
  );

  it("refuses an admin a group carrying a permission it may not give, adding no one", async () => {
    const east = await newGroup("East");
    await new GroupService(deps).grantPermission(ownerId, orgId, east, "billing.manage");
    const viewer = await member("team.viewer", "VIEWER");
    await member("team.admin", "ADMIN");
    await signIn("team.admin");
    expect(landing(await adding(east, viewer))).toBe("error=may-not-add-group-member");
    expect(await inGroup(east)).toEqual([]);
    expect(audited("group.change_refused").map(({ metadata }) => metadata.permission)).toEqual(["billing.manage"]);
  });

  it("finds no group of another organization, nor a missing one", async () => {
    const outsider = await register("outsider");
    const { organization } = await new OrganizationService(deps).createOrganization(outsider, { name: "Elsewhere" });
    const theirs = await newGroup("Theirs", organization.id, outsider);
    expect(landing(await adding(theirs, ownerId))).toBe("error=group-gone");
    expect(landing(await adding("grp_missing", ownerId))).toBe("error=group-gone");
    expect(await inGroup(theirs, organization.id)).toEqual([]);
  });

  it("finds no one who is not a member of this organization", async () => {
    const east = await newGroup("East");
    const outsider = await register("outsider");
    expect(landing(await adding(east, outsider))).toBe("error=group-member-gone");
    expect(await inGroup(east)).toEqual([]);
  });

  it("refuses an organization the poster is no member of, writing nothing there", async () => {
    const outsider = await register("outsider");
    const { organization } = await new OrganizationService(deps).createOrganization(outsider, { name: "Elsewhere" });
    const theirs = await newGroup("Theirs", organization.id, outsider);
    expect(landing(await adding(theirs, ownerId, organization.id), organization.id)).toBe(
      "error=may-not-add-group-member",
    );
    expect(await inGroup(theirs, organization.id)).toEqual([]);
    expect(audited("group.change_refused")).toEqual([]);
  });

  it("says the group or member changed when the addition finds either gone as it writes", async () => {
    const east = await newGroup("East");
    vi.spyOn(deps.repos.groups, "addMember").mockResolvedValue({ outcome: "STALE" });
    expect(landing(await adding(east, ownerId))).toBe("error=group-members-changed");
  });

  it("refuses ids longer than any unread, so they never reach the audit log", async () => {
    await member("acting.viewer", "VIEWER");
    await signIn("acting.viewer");
    const east = await newGroup("East");
    const longest = "u".repeat(64);
    expect(landing(await adding(east, `${longest}u`))).toBe("error=group-member-gone");
    expect(landing(await adding("g".repeat(GROUP_ID_MAX_LENGTH + 1), ownerId))).toBe("error=group-gone");
    expect(audited("group.change_refused")).toEqual([]);
    expect(landing(await adding(east, longest))).toBe("error=may-not-add-group-member");
    expect(audited("group.change_refused").map(({ metadata }) => metadata.targetUserId)).toEqual([longest]);
  });

  it("asks an empty member for the permission first, so its refusal is audited", async () => {
    const east = await newGroup("East");
    expect(landing(await adding(east, ""))).toBe("error=group-member-gone");
    await member("acting.viewer", "VIEWER");
    await signIn("acting.viewer");
    expect(landing(await adding(east, ""))).toBe("error=may-not-add-group-member");
    expect(audited("group.change_refused")).toHaveLength(1);
  });

  it("answers a reason it does not know, or a reason on another error, as a failure", async () => {
    const east = await newGroup("East");
    const spy = vi.spyOn(deps.repos.groups, "addMember");
    spy.mockRejectedValueOnce(new AppError("NOT_FOUND", "Gone", { details: { reason: "constructor" } }));
    expect(landing(await adding(east, ownerId))).toBe("error=add-group-member-failed");
    spy.mockRejectedValueOnce(new AppError("INTERNAL_ERROR", "Lost", { details: { reason: "GROUP" } }));
    expect(landing(await adding(east, ownerId))).toBe("error=add-group-member-failed");
  });

  it("logs a failure by its code alone, and says to check the list", async () => {
    const east = await newGroup("East");
    vi.spyOn(deps.repos.groups, "addMember").mockRejectedValue(new Error("lost owner@example.com"));
    const logged: unknown[] = [];
    const outcome = await addGroupMember(ownerId, orgId, east, { userId: ownerId }, {
      error: (message, fields) => logged.push({ message, fields }),
    });
    expect(outcome).toEqual({ error: "add-group-member-failed" });
    expect(logged).toEqual([{ message: "A member could not be added to a group", fields: { code: "UNEXPECTED" } }]);
  });

  it.each([
    ["no origin", {}],
    ["another site", { origin: "https://evil.example.net" }],
  ])("refuses a post from %s before reading anything", async (_what, headers) => {
    const east = await newGroup("East");
    expect((await adding(east, ownerId, orgId, headers)).status).toBe(403);
    expect(await inGroup(east)).toEqual([]);
  });

  it("sends a signed-out visitor to sign in, adding no one", async () => {
    const east = await newGroup("East");
    cookie.value = undefined;
    const response = await adding(east, ownerId);
    expect(response.headers.get("location")).toBe("/login");
    expect(await inGroup(east)).toEqual([]);
  });
});

describe("removing a group's member", () => {
  /** A group named East holding `userIds`, added by the owner; returns its id. */
  const eastWith = async (...userIds: string[]) => {
    const east = await newGroup("East");
    for (const userId of userIds) await new GroupService(deps).addMember(ownerId, orgId, east, userId);
    return east;
  };

  it("removes the member from the group, keeping them in the organization, and audits it", async () => {
    const viewer = await member("team.viewer", "VIEWER");
    const east = await eastWith(viewer);
    expect(landing(await removing(east, viewer))).toBe("notice=group-member-removed");
    expect(await inGroup(east)).toEqual([]);
    expect((await deps.repos.memberships.find(orgId, viewer))?.role).toBe("VIEWER");
    expect(audited("group.member_removed").map(entryOf)).toEqual([
      { actorUserId: ownerId, resourceId: east, metadata: { targetUserId: viewer, targetRole: "VIEWER" } },
    ]);
  });

  it("lets an owner remove itself, and an admin a manager, creator or viewer", async () => {
    const others = [];
    for (const role of ["MANAGER", "CREATOR", "VIEWER"] as const) others.push(await member(`team.${role}`, role));
    const east = await eastWith(ownerId, ...others);
    expect(landing(await removing(east, ownerId))).toBe("notice=group-member-removed");
    await member("team.admin", "ADMIN");
    await signIn("team.admin");
    for (const userId of others) expect(landing(await removing(east, userId))).toBe("notice=group-member-removed");
    expect(await inGroup(east)).toEqual([]);
  });

  it("refuses an admin a member whose role it may not assign, itself included, and audits it", async () => {
    const admin = await member("team.admin", "ADMIN");
    const east = await eastWith(ownerId, admin);
    await signIn("team.admin");
    for (const userId of [ownerId, admin]) {
      expect(landing(await removing(east, userId))).toBe("error=may-not-remove-group-member");
    }
    expect((await inGroup(east)).sort()).toEqual([ownerId, admin].sort());
    expect(audited("group.change_refused").map(({ metadata }) => metadata.reason)).toEqual([
      "target_role",
      "target_role",
    ]);
  });

  it.each(["MANAGER", "CREATOR", "VIEWER", "BILLING"] as const)("refuses a %s, lacking group.manage", async (role) => {
    const viewer = await member("team.viewer", "VIEWER");
    const east = await eastWith(viewer);
    await member(`acting.${role}`, role);
    await signIn(`acting.${role}`);
    expect(landing(await removing(east, viewer))).toBe("error=may-not-remove-group-member");
    expect(await inGroup(east)).toEqual([viewer]);
    expect(audited("group.change_refused").map(({ metadata }) => metadata.reason)).toEqual(["lacks_group_manage"]);
  });

  it("refuses a manager granted group.manage, whom the ceiling lets remove no one", async () => {
    const manager = await member("team.manager", "MANAGER");
    const viewer = await member("team.viewer", "VIEWER");
    const east = await eastWith(viewer);
    await new PermissionGrantService(deps).grant(ownerId, orgId, manager, "group.manage");
    await signIn("team.manager");
    expect(landing(await removing(east, viewer))).toBe("error=may-not-remove-group-member");
    expect(await inGroup(east)).toEqual([viewer]);
    expect(audited("group.change_refused").map(({ metadata }) => metadata.reason)).toEqual(["target_role"]);
  });

  it("refuses an admin a member of a group carrying a permission it may not take", async () => {
    const viewer = await member("team.viewer", "VIEWER");
    const east = await eastWith(viewer);
    await new GroupService(deps).grantPermission(ownerId, orgId, east, "billing.manage");
    await member("team.admin", "ADMIN");
    await signIn("team.admin");
    expect(landing(await removing(east, viewer))).toBe("error=may-not-remove-group-member");
    expect(await inGroup(east)).toEqual([viewer]);
  });

  it("says a member is not in the group, and that someone is no member of the organization", async () => {
    const viewer = await member("team.viewer", "VIEWER");
    const east = await eastWith();
    expect(landing(await removing(east, viewer))).toBe("error=not-in-group");
    expect(landing(await removing(east, await register("outsider")))).toBe("error=group-member-gone");
    expect(audited("group.member_removed")).toEqual([]);
  });

  it("finds no group of another organization, nor a missing one", async () => {
    const outsider = await register("outsider");
    const { organization } = await new OrganizationService(deps).createOrganization(outsider, { name: "Elsewhere" });
    const theirs = await newGroup("Theirs", organization.id, outsider);
    await new GroupService(deps).addMember(outsider, organization.id, theirs, outsider);
    expect(landing(await removing(theirs, ownerId))).toBe("error=group-gone");
    expect(landing(await removing("grp_missing", ownerId))).toBe("error=group-gone");
    expect(await inGroup(theirs, organization.id)).toEqual([outsider]);
  });

  it("refuses an organization the poster is no member of, writing nothing there", async () => {
    const outsider = await register("outsider");
    const { organization } = await new OrganizationService(deps).createOrganization(outsider, { name: "Elsewhere" });
    const theirs = await newGroup("Theirs", organization.id, outsider);
    await new GroupService(deps).addMember(outsider, organization.id, theirs, outsider);
    expect(landing(await removing(theirs, outsider, organization.id), organization.id)).toBe(
      "error=may-not-remove-group-member",
    );
    expect(await inGroup(theirs, organization.id)).toEqual([outsider]);
    expect(audited("group.change_refused")).toEqual([]);
  });

  it("refuses ids longer than any unread, so they never reach the audit log", async () => {
    await member("acting.viewer", "VIEWER");
    await signIn("acting.viewer");
    const east = await eastWith();
    const longest = "u".repeat(64);
    expect(landing(await removing(east, `${longest}u`))).toBe("error=group-member-gone");
    expect(landing(await removing("g".repeat(GROUP_ID_MAX_LENGTH + 1), ownerId))).toBe("error=group-gone");
    expect(await removeGroupMember(ownerId, orgId, "", ownerId)).toEqual({ error: "group-gone" });
    expect(audited("group.change_refused")).toEqual([]);
    expect(landing(await removing(east, longest))).toBe("error=may-not-remove-group-member");
    expect(audited("group.change_refused").map(({ metadata }) => metadata.targetUserId)).toEqual([longest]);
  });

  it("answers a reason it does not know as a failure", async () => {
    const east = await eastWith(ownerId);
    const gone = new AppError("NOT_FOUND", "Gone", { details: { reason: "toString" } });
    vi.spyOn(deps.repos.groups, "removeMember").mockRejectedValueOnce(gone);
    expect(landing(await removing(east, ownerId))).toBe("error=remove-group-member-failed");
  });

  it("logs a failure by its code alone, and says to check the list", async () => {
    const east = await eastWith(ownerId);
    vi.spyOn(deps.repos.groups, "removeMember").mockRejectedValue(new Error("lost owner@example.com"));
    const logged: unknown[] = [];
    const outcome = await removeGroupMember(ownerId, orgId, east, ownerId, {
      error: (message, fields) => logged.push({ message, fields }),
    });
    expect(outcome).toEqual({ error: "remove-group-member-failed" });
    expect(logged).toEqual([
      { message: "A member could not be removed from a group", fields: { code: "UNEXPECTED" } },
    ]);
  });

  it.each([
    ["no origin", {}],
    ["another site", { origin: "https://evil.example.net" }],
  ])("refuses a post from %s before reading anything", async (_what, headers) => {
    const east = await eastWith(ownerId);
    expect((await removing(east, ownerId, orgId, headers)).status).toBe(403);
    expect(await inGroup(east)).toEqual([ownerId]);
  });

  it("sends a signed-out visitor to sign in, removing no one", async () => {
    const east = await eastWith(ownerId);
    cookie.value = undefined;
    const response = await removing(east, ownerId);
    expect(response.headers.get("location")).toBe("/login");
    expect(await inGroup(east)).toEqual([ownerId]);
  });
});
