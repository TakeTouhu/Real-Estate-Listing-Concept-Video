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
/** What an `OWNER` may do with a permission a member holds no individual grant of, but one: give it. */
const givable = { mayGrant: true, mayRevoke: false };
/** What an `OWNER` may do with an individual grant a member holds: take it back. */
const revocable = { mayGrant: false, mayRevoke: true };

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
      ...givable,
    });
    expect(view.permissions.find((p) => p.permission === "billing.manage")).toEqual({
      permission: "billing.manage",
      effective: false,
      ...none,
      ...givable,
    });
  });

  it("marks the viewer's own row, and gives each role's fixed scope", async () => {
    expect((await service.view(ids.OWNER, orgId, ids.OWNER)).member.you).toBe(true);
    expect((await service.view(ids.OWNER, orgId, ids.MANAGER)).scope).toBe("GROUP");
    expect((await service.view(ids.OWNER, orgId, ids.CREATOR)).scope).toBe("OWN");
  });

  it("adds up the role, an individual grant and each group, naming the groups by name", async () => {
    const grants = new PermissionGrantService(deps);
    await grants.grant(ids.OWNER, orgId, ids.CREATOR, "member.view");
    await grants.grant(ids.OWNER, orgId, ids.CREATOR, "billing.view");
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
      ...revocable,
    });
    expect(await row("OWNER", "CREATOR", "group.view")).toMatchObject({ effective: true, groupNames: ["East"] });
    expect(await row("OWNER", "CREATOR", "billing.view")).toEqual({
      permission: "billing.view",
      effective: true,
      ...none,
      granted: true,
      ...revocable,
    });
    expect(await row("OWNER", "CREATOR", "property.view")).toEqual({
      permission: "property.view",
      effective: true,
      ...none,
      fromRole: true,
      ...givable,
    });
    const audit = await row("OWNER", "CREATOR", "audit.view");
    expect(audit).toEqual({ permission: "audit.view", effective: false, ...none, ...givable });
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
      // Never granted to a VIEWER (ADR-0058).
      mayGrant: false,
      mayRevoke: false,
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
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.BILLING, "group.view");
    expect(await row("BILLING", "MANAGER", "audit.view")).toMatchObject({ groupNames: ["East", "West"] });
  });

  it("counts nothing a group of another organization gives the same person", async () => {
    const other = (await new OrganizationService(deps).createOrganization(ids.outsider, { name: "Other" }))
      .organization.id;
    await deps.repos.memberships.create({ organizationId: other, userId: ids.CREATOR, role: "CREATOR" });
    const elsewhere = new GroupService(deps);
    const { id } = await elsewhere.create(ids.outsider, other, "Elsewhere");
    await elsewhere.grantPermission(ids.outsider, other, id, "member.view");
    await elsewhere.addMember(ids.outsider, other, id, ids.CREATOR);
    const here = await row("OWNER", "CREATOR", "member.view");
    expect(here).toEqual({ permission: "member.view", effective: false, ...none, ...givable });
    expect((await service.view(ids.outsider, other, ids.CREATOR)).permissions).toContainEqual(
      expect.objectContaining({ permission: "member.view", effective: true, groupNames: ["Elsewhere"] }),
    );
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

describe("which individual grants the viewer may give or take back (AT-11b, ADR-0147)", () => {
  it("lets an ADMIN give only what it holds, to MANAGER, CREATOR and VIEWER members, nothing protected", async () => {
    expect(await row("ADMIN", "MANAGER", "member.manage")).toMatchObject(givable);
    expect(await row("ADMIN", "VIEWER", "audit.export")).toMatchObject(givable);
    for (const permission of ["permission.manage", "billing.manage", "disclosure.none"] as const) {
      expect(await row("ADMIN", "CREATOR", permission)).toMatchObject({ mayGrant: false, mayRevoke: false });
    }
    for (const member of ["OWNER", "ADMIN", "BILLING"] as const) {
      expect(await row("ADMIN", member, "audit.view")).toMatchObject({ mayGrant: false, mayRevoke: false });
    }
  });

  it("lets no one without permission.manage, nor a MANAGER given it, give or take back anything", async () => {
    const grants = new PermissionGrantService(deps);
    await grants.grant(ids.OWNER, orgId, ids.CREATOR, "audit.view");
    await grants.grant(ids.OWNER, orgId, ids.MANAGER, "permission.manage");
    for (const viewer of ["BILLING", "MANAGER"] as const) {
      const { permissions } = await service.view(ids[viewer], orgId, ids.CREATOR);
      expect(permissions.filter(({ mayGrant, mayRevoke }) => mayGrant || mayRevoke)).toEqual([]);
    }
  });

  it("never offers property.create to a VIEWER, yet takes back a grant of it made before a role change", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.CREATOR, "property.create");
    await deps.repos.memberships.changeRole(orgId, ids.CREATOR, "CREATOR", "VIEWER", {
      organizationId: orgId,
      actorUserId: ids.OWNER,
      action: "member.role_changed",
      resourceType: "membership",
      resourceId: ids.CREATOR,
      metadata: {},
    });
    expect(await row("OWNER", "CREATOR", "property.create")).toMatchObject({ effective: false, ...revocable });
    expect(await row("OWNER", "VIEWER", "property.create")).toMatchObject({ mayGrant: false, mayRevoke: false });
  });

  /**
   * For every viewer and member, whether the page says a grant may be given
   * or taken back is what the grant service then does with it.
   */
  it.each(["OWNER", "ADMIN", "MANAGER", "BILLING"] as const)(
    "says what the grant service allows a %s, for every member and permission",
    async (viewer) => {
      const grants = new PermissionGrantService(deps);
      await grants.grant(ids.OWNER, orgId, ids.MANAGER, "permission.manage");
      const succeeds = (change: Promise<unknown>) =>
        change.then(
          () => true,
          () => false,
        );
      for (const member of ["OWNER", "ADMIN", "MANAGER", "CREATOR", "VIEWER", "BILLING"] as const) {
        const giving = (await service.view(ids[viewer], orgId, ids[member])).permissions;
        for (const { permission, mayGrant, granted } of giving) {
          if (granted) continue;
          const given = await succeeds(grants.grant(ids[viewer], orgId, ids[member], permission));
          expect([permission, given]).toEqual([permission, mayGrant]);
          if (given) await grants.revoke(ids.OWNER, orgId, ids[member], permission);
        }
        // Every individual grant an OWNER may make, then what the viewer may take back of them.
        for (const { permission } of giving) await succeeds(grants.grant(ids.OWNER, orgId, ids[member], permission));
        const taking = (await service.view(ids[viewer], orgId, ids[member])).permissions;
        for (const { permission, mayRevoke, granted } of taking.filter((p) => p.granted)) {
          const taken = await succeeds(grants.revoke(ids[viewer], orgId, ids[member], permission));
          expect([permission, taken, granted]).toEqual([permission, mayRevoke, true]);
          if (taken) await grants.grant(ids.OWNER, orgId, ids[member], permission);
        }
        expect(taking.filter((p) => !p.granted).every(({ mayRevoke }) => !mayRevoke)).toBe(true);
      }
    },
  );
});
