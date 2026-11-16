import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../identity/auth-service";
import { GroupService } from "../identity/group-service";
import { OrganizationService } from "../identity/organization-service";
import { PermissionGrantService } from "../identity/permission-grant-service";
import {
  GROUP_GRANTABLE_PERMISSIONS,
  PERMISSIONS,
  PROTECTED_PERMISSIONS,
  hasPermission,
  type Permission,
  type Role,
} from "../identity/roles";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { GroupsOverviewService } from "./groups-overview";

/**
 * The groups page's reading (AT-9a, ADR-0141): `group.view` to see it; the
 * groups by name, each with its members by role and then the longest-standing
 * first, and the permissions it gives them (AT-11c, ADR-0148); what the viewer
 * may do (create and rename with `group.manage`, delete only as an `OWNER` or
 * `ADMIN` holding it, add and remove a member whose role it may assign, AT-9c,
 * ADR-0143, give and take back a group's permissions with `permission.manage`,
 * each within the grant ceiling, as the group service then decides); and
 * nothing written.
 */

const iso = (value: string) => new Date(value);

let deps: TestDeps;
let groups: GroupService;
let service: GroupsOverviewService;
let orgId: string;
let otherOrgId: string;
let ids: Record<Role | "outsider", string>;

beforeEach(async () => {
  deps = createTestDeps();
  deps.clock.set(iso("2026-11-01T00:00:00.000Z"));
  groups = new GroupService(deps);
  service = new GroupsOverviewService(deps);
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const register = async (name: string) =>
    (await auth.register({ email: `${name}@example.com`, name: `${name} san`, password: "password-123456" })).id;
  const owner = await register("owner");
  const organizations = new OrganizationService(deps);
  ({ organization: { id: orgId } } = await organizations.createOrganization(owner, { name: "Org" }));
  ({ organization: { id: otherOrgId } } = await organizations.createOrganization(owner, { name: "Other" }));
  ids = { OWNER: owner } as Record<Role | "outsider", string>;
  // Joined in an order unlike the roles', a day apart.
  for (const [day, role] of (["VIEWER", "BILLING", "MANAGER", "ADMIN", "CREATOR"] as const).entries()) {
    deps.clock.set(iso(`2026-11-0${day + 2}T00:00:00.000Z`));
    ids[role] = await register(role.toLowerCase());
    await deps.repos.memberships.create({ organizationId: orgId, userId: ids[role], role });
  }
  ids.outsider = await register("outsider");
  deps.clock.set(iso("2026-11-10T00:00:00.000Z"));
});

async function group(
  name: string,
  members: readonly (Role | "outsider")[] = [],
  organizationId = orgId,
  permissions: readonly Permission[] = [],
) {
  const created = await groups.create(ids.OWNER, organizationId, name);
  for (const who of members) await groups.addMember(ids.OWNER, organizationId, created.id, ids[who]);
  for (const permission of permissions) await groups.grantPermission(ids.OWNER, organizationId, created.id, permission);
  return created;
}

describe("the groups overview", () => {
  it.each(["CREATOR", "VIEWER", "BILLING", "outsider"] as const)(
    "refuses a %s, who lacks group.view",
    async (who) => {
      await expect(service.overview(ids[who], orgId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it("lets an individual group.view grant through, as authorization does everywhere", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.CREATOR, "group.view");
    await expect(service.overview(ids.CREATOR, orgId)).resolves.toMatchObject({ groups: [] });
  });

  it("shows members' addresses only to a viewer who also holds member.view", async () => {
    await group("East", ["ADMIN"]);
    const grants = new PermissionGrantService(deps);
    await grants.grant(ids.OWNER, orgId, ids.CREATOR, "group.view");
    const [listed] = (await service.overview(ids.CREATOR, orgId)).groups;
    expect(listed?.members).toEqual([
      { userId: ids.ADMIN, name: "admin san", email: null, role: "ADMIN", mayRemove: false },
    ]);
    await grants.grant(ids.OWNER, orgId, ids.CREATOR, "member.view");
    const [again] = (await service.overview(ids.CREATOR, orgId)).groups;
    expect(again?.members[0]?.email).toBe("admin@example.com");
  });

  it("reads the grouped members in one listing, and only the accounts it shows, each once", async () => {
    await group("East", ["ADMIN"]);
    await group("West", ["ADMIN", "CREATOR"]);
    await group("North");
    const perGroup = vi.spyOn(deps.repos.groups, "listMembers");
    const accounts = vi.spyOn(deps.repos.users, "findById");
    const read = () => accounts.mock.calls.map(([userId]) => userId).sort();
    // A viewer who may add no one reads the grouped members' accounts alone.
    await service.overview(ids.MANAGER, orgId);
    expect(perGroup).not.toHaveBeenCalled();
    expect(read()).toEqual([ids.ADMIN, ids.CREATOR].sort());
    // An ADMIN also reads those it may add to a group.
    accounts.mockClear();
    await service.overview(ids.ADMIN, orgId);
    expect(read()).toEqual([ids.ADMIN, ids.CREATOR, ids.MANAGER, ids.VIEWER].sort());
  });

  it("lists the groups by name, each member by role and then the longest-standing first", async () => {
    await group("West", ["CREATOR", "VIEWER", "MANAGER", "OWNER"]);
    await group("East", ["ADMIN"]);
    await group("Empty");
    const { groups: listed } = await service.overview(ids.MANAGER, orgId);
    expect(listed.map(({ name }) => name)).toEqual(["East", "Empty", "West"]);
    expect(listed[1]?.members).toEqual([]);
    expect(listed[2]?.members.map(({ role }) => role)).toEqual(["OWNER", "MANAGER", "CREATOR", "VIEWER"]);
    expect(listed[0]).toEqual({
      id: expect.any(String),
      name: "East",
      members: [{ userId: ids.ADMIN, name: "admin san", email: "admin@example.com", role: "ADMIN", mayRemove: false }],
      addable: [],
      permissions: [],
      givable: [],
      revocable: [],
      mayDelete: false,
    });
  });

  it("offers an OWNER every member not in a group, itself included, and lets it remove anyone", async () => {
    await group("West", ["ADMIN", "CREATOR"]);
    const [listed] = (await service.overview(ids.OWNER, orgId)).groups;
    expect(listed?.members.map(({ role, mayRemove }) => [role, mayRemove])).toEqual([
      ["ADMIN", true],
      ["CREATOR", true],
    ]);
    expect(listed?.addable.map(({ role }) => role)).toEqual(["OWNER", "MANAGER", "VIEWER", "BILLING"]);
    const owner = { userId: ids.OWNER, name: "owner san", email: "owner@example.com", role: "OWNER" };
    expect(listed?.addable[0]).toEqual(owner);
  });

  it("offers an ADMIN only MANAGER, CREATOR and VIEWER members, never itself", async () => {
    await group("West", ["OWNER", "ADMIN", "CREATOR"]);
    const [listed] = (await service.overview(ids.ADMIN, orgId)).groups;
    expect(listed?.members.map(({ role, mayRemove }) => [role, mayRemove])).toEqual([
      ["OWNER", false],
      ["ADMIN", false],
      ["CREATOR", true],
    ]);
    expect(listed?.addable.map(({ role }) => role)).toEqual(["MANAGER", "VIEWER"]);
  });

  it("never offers an ADMIN a member it may not change because they are in another group", async () => {
    await group("West", ["OWNER", "ADMIN", "CREATOR"]);
    await group("East");
    const [east] = (await service.overview(ids.ADMIN, orgId)).groups;
    expect(east?.addable.map(({ role }) => role)).toEqual(["MANAGER", "CREATOR", "VIEWER"]);
  });

  it("offers a MANAGER granted group.manage no member to add or remove, as the ceiling gives it none", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.MANAGER, "group.manage");
    await group("West", ["CREATOR"]);
    const [listed] = (await service.overview(ids.MANAGER, orgId)).groups;
    expect(listed?.members.map(({ mayRemove }) => mayRemove)).toEqual([false]);
    expect(listed?.addable).toEqual([]);
  });

  it("orders members of one role by when they joined, not by their ids", async () => {
    const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
    const register = async (name: string) =>
      (await auth.register({ email: `${name}@example.com`, name, password: "password-123456" })).id;
    // Amy's account is older, so its id sorts first, but Zed joined first.
    const amy = await register("amy");
    const zed = await register("zed");
    for (const [userId, day] of [[zed, "08"], [amy, "09"]] as const) {
      deps.clock.set(iso(`2026-11-${day}T00:00:00.000Z`));
      await deps.repos.memberships.create({ organizationId: orgId, userId, role: "VIEWER" });
    }
    const created = await group("Viewers", ["VIEWER"]);
    for (const userId of [amy, zed]) await groups.addMember(ids.OWNER, orgId, created.id, userId);
    const [listed] = (await service.overview(ids.OWNER, orgId)).groups;
    expect(listed?.members.map(({ userId }) => userId)).toEqual([ids.VIEWER, zed, amy]);
  });

  it("shows only this organization's groups", async () => {
    await group("Here", ["OWNER"]);
    await group("There", ["OWNER"], otherOrgId);
    expect((await service.overview(ids.OWNER, orgId)).groups.map(({ name }) => name)).toEqual(["Here"]);
  });

  it("leaves out a member whose account is gone between the reads", async () => {
    await group("Team", ["ADMIN", "CREATOR"]);
    const findById = deps.repos.users.findById.bind(deps.repos.users);
    vi.spyOn(deps.repos.users, "findById").mockImplementation((userId) =>
      userId === ids.CREATOR ? Promise.resolve(null) : findById(userId),
    );
    const [listed] = (await service.overview(ids.OWNER, orgId)).groups;
    expect(listed?.members.map(({ role }) => role)).toEqual(["ADMIN"]);
  });

  it("leaves out a group member who left the organization between the reads", async () => {
    await group("Team", ["ADMIN", "CREATOR"]);
    const listByOrganization = deps.repos.memberships.listByOrganization.bind(deps.repos.memberships);
    vi.spyOn(deps.repos.memberships, "listByOrganization").mockImplementation(async (organizationId) =>
      (await listByOrganization(organizationId)).filter(({ userId }) => userId !== ids.CREATOR),
    );
    const [listed] = (await service.overview(ids.OWNER, orgId)).groups;
    expect(listed?.members.map(({ role }) => role)).toEqual(["ADMIN"]);
  });

  it.each([
    ["OWNER", true, true],
    ["ADMIN", true, true],
    ["MANAGER", false, false],
  ] as const)("tells a %s whether it may manage (%s) and delete (%s) groups", async (who, mayManage, mayDelete) => {
    await group("Team", ["CREATOR"]);
    const overview = await service.overview(ids[who], orgId);
    expect([overview.mayManage, overview.groups[0]?.mayDelete]).toEqual([mayManage, mayDelete]);
  });

  it("lets a MANAGER granted group.manage create and rename, but never delete", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.MANAGER, "group.manage");
    await group("Empty");
    const overview = await service.overview(ids.MANAGER, orgId);
    expect([overview.mayManage, overview.groups[0]?.mayDelete]).toEqual([true, false]);
  });

  it("writes nothing", async () => {
    await group("Team", ["ADMIN"]);
    const before = (await deps.repos.auditLogs.listByOrganization(orgId)).length;
    await service.overview(ids.OWNER, orgId);
    await expect(service.overview(ids.CREATOR, orgId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await deps.repos.auditLogs.listByOrganization(orgId)).toHaveLength(before);
  });
});

describe("a group's permissions on the overview (AT-11c, ADR-0148)", () => {
  const notIn = (taken: readonly Permission[]) => (permission: Permission) => !taken.includes(permission);

  it("shows each group's permissions in vocabulary order to a holder of group.view, read in one listing", async () => {
    const east = await group("East", ["CREATOR"], orgId, ["video.download", "unit.view"]);
    const west = await group("West");
    const perGroup = vi.spyOn(deps.repos.groups, "listPermissions");
    const listing = vi.spyOn(deps.repos.groups, "listPermissionsOfGroups");
    const { groups: listed } = await service.overview(ids.MANAGER, orgId);
    expect(listed.map(({ name, permissions }) => [name, permissions])).toEqual([
      ["East", ["video.download", "unit.view"]],
      ["West", []],
    ]);
    expect(perGroup).not.toHaveBeenCalled();
    expect(listing.mock.calls).toEqual([[orgId, [east.id, west.id]]]);
    // A MANAGER holds no permission.manage, so it may give or take back nothing.
    expect(listed.map(({ givable, revocable }) => [givable, revocable])).toEqual([
      [[], []],
      [[], []],
    ]);
  });

  it("offers an OWNER every permission a group may carry and does not give, whoever is in it", async () => {
    await group("Mixed", ["ADMIN", "BILLING"], orgId, ["billing.manage", "unit.view"]);
    const [listed] = (await service.overview(ids.OWNER, orgId)).groups;
    expect(listed?.givable).toEqual(GROUP_GRANTABLE_PERMISSIONS.filter(notIn(["billing.manage", "unit.view"])));
    expect(listed?.givable).not.toContain("disclosure.none");
    expect(listed?.revocable).toEqual(["unit.view", "billing.manage"]);
    expect(listed?.mayDelete).toBe(true);
  });

  it("offers an ADMIN only what it holds and is not protected, on a group of members it may manage", async () => {
    await group("Team", ["MANAGER", "CREATOR"], orgId, ["audit.view"]);
    await group("Mixed", ["OWNER", "CREATOR"], orgId, ["audit.view"]);
    const [mixed, team] = (await service.overview(ids.ADMIN, orgId)).groups;
    const held = PERMISSIONS.filter((permission) => hasPermission("ADMIN", permission));
    expect(team?.givable).toEqual(held.filter(notIn([...PROTECTED_PERMISSIONS, "audit.view"])));
    expect(team?.revocable).toEqual(["audit.view"]);
    // An OWNER in the group is out of an ADMIN's reach, so nothing it gives may change.
    expect([mixed?.givable, mixed?.revocable, mixed?.mayDelete]).toEqual([[], [], false]);
  });

  it("lets an ADMIN delete, add to or remove from a group only if it may give or take all it gives", async () => {
    await group("Billing", ["CREATOR"], orgId, ["billing.manage"]);
    await group("Owners", ["OWNER"]);
    let [billing, owners] = (await service.overview(ids.ADMIN, orgId)).groups;
    // Protected: only an OWNER gives or takes billing.manage, by any route.
    expect([billing?.mayDelete, billing?.addable, billing?.members[0]?.mayRemove]).toEqual([false, [], false]);
    // A group giving nothing takes nothing from its OWNER when deleted.
    expect(owners?.mayDelete).toBe(true);
    await groups.grantPermission(ids.OWNER, orgId, owners!.id, "unit.view");
    [billing, owners] = (await service.overview(ids.ADMIN, orgId)).groups;
    expect(owners?.mayDelete).toBe(false);
    expect(owners?.addable.map(({ role }) => role)).toEqual(["MANAGER", "CREATOR", "VIEWER"]);
  });

  it("offers a MANAGER granted permission.manage only a group with no members, and only what it holds", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.MANAGER, "permission.manage");
    await group("Empty", [], orgId, ["unit.view"]);
    await group("Team", ["VIEWER"]);
    const [empty, team] = (await service.overview(ids.MANAGER, orgId)).groups;
    const held = PERMISSIONS.filter((permission) => hasPermission("MANAGER", permission));
    expect(empty?.givable).toEqual(held.filter(notIn(["unit.view"])));
    expect(empty?.revocable).toEqual(["unit.view"]);
    expect([team?.givable, team?.mayDelete]).toEqual([[], false]);
  });

  /**
   * For every viewer, group and permission or member, what the overview says
   * may be given, taken back, added, removed or deleted is what the group
   * service then does.
   */
  it.each(["OWNER", "ADMIN", "MANAGER", "BILLING"] as const)(
    "says what the group service allows a %s, on every group",
    async (viewer) => {
      const grants = new PermissionGrantService(deps);
      for (const permission of ["permission.manage", "group.manage"] as const) {
        await grants.grant(ids.OWNER, orgId, ids.MANAGER, permission);
      }
      for (const permission of ["group.view", "permission.manage"] as const) {
        await grants.grant(ids.OWNER, orgId, ids.BILLING, permission);
      }
      await group("Empty");
      await group("Team", ["MANAGER", "CREATOR", "VIEWER"], orgId, ["audit.view", "unit.view"]);
      await group("Mixed", ["OWNER", "ADMIN", "CREATOR"], orgId, ["video.download"]);
      await group("Billing", ["CREATOR"], orgId, ["billing.manage"]);
      await group("Plain", ["ADMIN", "BILLING"]);
      const succeeds = (change: Promise<unknown>) =>
        change.then(
          () => true,
          () => false,
        );
      const listed = (await service.overview(ids[viewer], orgId)).groups;
      const everyone = (["OWNER", "ADMIN", "MANAGER", "CREATOR", "VIEWER", "BILLING"] as const).map((r) => ids[r]);
      for (const shown of listed) {
        for (const permission of PERMISSIONS.filter(notIn(shown.permissions))) {
          const change = groups.grantPermission(ids[viewer], orgId, shown.id, permission);
          const given = await change.then(({ granted }) => granted, () => false);
          const offered = shown.givable.includes(permission);
          expect([shown.name, permission, given]).toEqual([shown.name, permission, offered]);
          if (given) await groups.revokePermission(ids.OWNER, orgId, shown.id, permission);
        }
        for (const permission of shown.permissions) {
          const taken = await succeeds(groups.revokePermission(ids[viewer], orgId, shown.id, permission));
          const offered = shown.revocable.includes(permission);
          expect([shown.name, permission, taken]).toEqual([shown.name, permission, offered]);
          if (taken) await groups.grantPermission(ids.OWNER, orgId, shown.id, permission);
        }
        for (const userId of everyone) {
          const member = shown.members.find((m) => m.userId === userId);
          if (member) {
            const removed = await succeeds(groups.removeMember(ids[viewer], orgId, shown.id, userId));
            expect([shown.name, member.role, removed]).toEqual([shown.name, member.role, member.mayRemove]);
            if (removed) await groups.addMember(ids.OWNER, orgId, shown.id, userId);
          } else {
            const added = await succeeds(groups.addMember(ids[viewer], orgId, shown.id, userId));
            const offered = shown.addable.some((m) => m.userId === userId);
            expect([shown.name, userId, added]).toEqual([shown.name, userId, offered]);
            if (added) await groups.removeMember(ids.OWNER, orgId, shown.id, userId);
          }
        }
      }
      // Last, as a deletion cannot be undone; no viewer's own permissions come from these groups.
      for (const shown of listed) {
        const deleted = await succeeds(groups.delete(ids[viewer], orgId, shown.id));
        expect([shown.name, deleted]).toEqual([shown.name, shown.mayDelete]);
      }
    },
  );
});
