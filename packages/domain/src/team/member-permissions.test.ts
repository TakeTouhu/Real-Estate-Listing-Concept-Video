import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../identity/auth-service";
import { GroupService } from "../identity/group-service";
import { OrganizationService } from "../identity/organization-service";
import { PermissionGrantService } from "../identity/permission-grant-service";
import { GRANTABLE_PERMISSIONS, type Permission, type Role } from "../identity/roles";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { MemberPermissionsService, type MemberPermission } from "./member-permissions";

/**
 * A member's permissions page's reading (AT-11a, ADR-0146): `member.view` to
 * see it; every permission a member can hold, whether it is in effect, and
 * whether its role, an individual grant or its groups give it; the groups'
 * names only for a viewer holding `group.view`; and nothing written.
 */

let deps: TestDeps;
let service: MemberPermissionsService;
let groups: GroupService;
let orgId: string;
let ids: Record<Role | "outsider", string>;

beforeEach(async () => {
  deps = createTestDeps();
  service = new MemberPermissionsService(deps);
  groups = new GroupService(deps);
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const register = async (name: string) =>
    (await auth.register({ email: `${name}@example.com`, name: `${name} san`, password: "password-123456" })).id;
  const owner = await register("owner");
  ({ organization: { id: orgId } } = await new OrganizationService(deps).createOrganization(owner, { name: "Org" }));
  ids = { OWNER: owner } as Record<Role | "outsider", string>;
  for (const role of ["ADMIN", "MANAGER", "CREATOR", "VIEWER", "BILLING"] as const) {
    ids[role] = await register(role.toLowerCase());
    await deps.repos.memberships.create({ organizationId: orgId, userId: ids[role], role });
  }
  ids.outsider = await register("outsider");
});

/** A group named `name` carrying `permissions`, with `members` in it. */
async function group(name: string, permissions: readonly Permission[], ...members: string[]): Promise<string> {
  const { id } = await groups.create(ids.OWNER, orgId, name);
  for (const permission of permissions) await groups.grantPermission(ids.OWNER, orgId, id, permission);
  for (const userId of members) await groups.addMember(ids.OWNER, orgId, id, userId);
  return id;
}

/** The row of `permission` in what `viewer` sees of `member`. */
async function row(viewer: Role, member: Role, permission: Permission): Promise<MemberPermission | undefined> {
  return (await service.view(ids[viewer], orgId, ids[member])).permissions.find((p) => p.permission === permission);
}

const none = { fromRole: false, granted: false, groupCount: 0, groupNames: [] };

describe("a member's permissions", () => {
  it("names the member and lists every permission a member can hold, in vocabulary order", async () => {
    const view = await service.view(ids.OWNER, orgId, ids.ADMIN);
    expect(view.member).toEqual({
      userId: ids.ADMIN,
      name: "admin san",
      email: "admin@example.com",
      role: "ADMIN",
      you: false,
    });
    expect(view.scope).toBe("ORGANIZATION");
    expect(view.permissions.map(({ permission }) => permission)).toEqual(GRANTABLE_PERMISSIONS);
    expect(view.permissions.map(({ permission }) => permission)).not.toContain("video.share");
    expect(view.permissions.find((p) => p.permission === "permission.manage")).toEqual({
      permission: "permission.manage",
      effective: true,
      ...none,
      fromRole: true,
    });
    expect(view.permissions.find((p) => p.permission === "billing.manage")).toEqual({
      permission: "billing.manage",
      effective: false,
      ...none,
    });
  });

  it("marks the viewer's own row, and gives each role's fixed scope", async () => {
    expect((await service.view(ids.OWNER, orgId, ids.OWNER)).member.you).toBe(true);
    expect((await service.view(ids.OWNER, orgId, ids.MANAGER)).scope).toBe("GROUP");
    expect((await service.view(ids.OWNER, orgId, ids.CREATOR)).scope).toBe("OWN");
  });

  it("adds up the role, an individual grant and each group, naming the groups by name", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.CREATOR, "member.view");
    await group("West", ["member.view"], ids.CREATOR);
    await group("East", ["member.view", "group.view"], ids.CREATOR);
    await group("North", ["member.view", "audit.view"], ids.VIEWER);
    expect(await row("OWNER", "CREATOR", "member.view")).toEqual({
      permission: "member.view",
      effective: true,
      fromRole: false,
      granted: true,
      groupCount: 2,
      groupNames: ["East", "West"],
    });
    expect(await row("OWNER", "CREATOR", "group.view")).toMatchObject({ effective: true, groupNames: ["East"] });
    expect(await row("OWNER", "CREATOR", "property.view")).toEqual({
      permission: "property.view",
      effective: true,
      ...none,
      fromRole: true,
    });
    const audit = await row("OWNER", "CREATOR", "audit.view");
    expect(audit).toEqual({ permission: "audit.view", effective: false, ...none });
  });

  it("shows property.create a group gives a VIEWER, which is never in effect for one", async () => {
    await group("East", ["property.create"], ids.VIEWER, ids.CREATOR);
    expect(await row("OWNER", "VIEWER", "property.create")).toEqual({
      permission: "property.create",
      effective: false,
      fromRole: false,
      granted: false,
      groupCount: 1,
      groupNames: ["East"],
    });
    expect(await row("OWNER", "CREATOR", "property.create")).toMatchObject({ effective: true, fromRole: true });
  });

  it("counts the groups without naming them for a viewer without group.view", async () => {
    await group("East", ["audit.view"], ids.MANAGER);
    await group("West", ["audit.view"], ids.MANAGER);
    expect(await row("BILLING", "MANAGER", "audit.view")).toMatchObject({
      effective: true,
      groupCount: 2,
      groupNames: null,
    });
    expect(await row("BILLING", "MANAGER", "video.view")).toMatchObject({ groupCount: 0, groupNames: null });
    expect(await row("MANAGER", "MANAGER", "audit.view")).toMatchObject({ groupNames: ["East", "West"] });
  });

  it("writes nothing", async () => {
    await group("East", ["audit.view"], ids.MANAGER);
    const before = deps.repos.auditLogs.all().length;
    await service.view(ids.MANAGER, orgId, ids.MANAGER);
    expect(deps.repos.auditLogs.all()).toHaveLength(before);
  });
});

describe("who sees a member's permissions", () => {
  it.each(["CREATOR", "VIEWER"] as const)("refuses a %s, who holds no member.view", async (role) => {
    await expect(service.view(ids[role], orgId, ids[role])).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lets a member given member.view see them", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.VIEWER, "member.view");
    expect((await service.view(ids.VIEWER, orgId, ids.OWNER)).member.role).toBe("OWNER");
  });

  it("refuses someone outside the organization before reading the member", async () => {
    const find = vi.spyOn(deps.repos.memberships, "find");
    await expect(service.view(ids.outsider, orgId, ids.OWNER)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(find.mock.calls.map(([, userId]) => userId)).toEqual([ids.outsider]);
  });

  it("answers NOT_FOUND for someone who is no member, or whose account is gone", async () => {
    await expect(service.view(ids.OWNER, orgId, ids.outsider)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Membership not found",
    });
    vi.spyOn(deps.repos.users, "findById").mockResolvedValueOnce(null);
    await expect(service.view(ids.OWNER, orgId, ids.ADMIN)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
