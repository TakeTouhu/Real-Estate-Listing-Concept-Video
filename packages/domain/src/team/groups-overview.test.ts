import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../identity/auth-service";
import { GroupService } from "../identity/group-service";
import { OrganizationService } from "../identity/organization-service";
import { PermissionGrantService } from "../identity/permission-grant-service";
import type { Role } from "../identity/roles";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { GroupsOverviewService } from "./groups-overview";

/**
 * The groups page's reading (AT-9a, ADR-0141): `group.view` to see it; the
 * groups by name, each with its members by role and then the longest-standing
 * first; what the viewer may do (create and rename with `group.manage`, delete
 * only as an `OWNER` or `ADMIN` holding it); and nothing written.
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

async function group(name: string, members: readonly (Role | "outsider")[] = [], organizationId = orgId) {
  const created = await groups.create(ids.OWNER, organizationId, name);
  for (const who of members) await groups.addMember(ids.OWNER, organizationId, created.id, ids[who]);
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
      members: [{ userId: ids.ADMIN, name: "admin san", email: "admin@example.com", role: "ADMIN" }],
    });
  });

  it("orders members of one role by when they joined", async () => {
    const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
    const later: string[] = [];
    for (const name of ["zed", "amy"]) {
      deps.clock.set(iso(name === "zed" ? "2026-11-08T00:00:00.000Z" : "2026-11-09T00:00:00.000Z"));
      const userId = (await auth.register({ email: `${name}@example.com`, name, password: "password-123456" })).id;
      await deps.repos.memberships.create({ organizationId: orgId, userId, role: "VIEWER" });
      later.push(userId);
    }
    const created = await group("Viewers", ["VIEWER"]);
    for (const userId of [...later].reverse()) await groups.addMember(ids.OWNER, orgId, created.id, userId);
    const [listed] = (await service.overview(ids.OWNER, orgId)).groups;
    expect(listed?.members.map(({ userId }) => userId)).toEqual([ids.VIEWER, ...later]);
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
    expect(await service.overview(ids[who], orgId)).toMatchObject({ mayManage, mayDelete });
  });

  it("lets a MANAGER granted group.manage create and rename, but never delete", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.MANAGER, "group.manage");
    expect(await service.overview(ids.MANAGER, orgId)).toMatchObject({ mayManage: true, mayDelete: false });
  });

  it("writes nothing", async () => {
    await group("Team", ["ADMIN"]);
    const before = (await deps.repos.auditLogs.listByOrganization(orgId)).length;
    await service.overview(ids.OWNER, orgId);
    await expect(service.overview(ids.CREATOR, orgId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await deps.repos.auditLogs.listByOrganization(orgId)).toHaveLength(before);
  });
});
