import { beforeEach, describe, expect, it } from "vitest";
import type { CustomerPlanKey } from "../pricing/customer-plan-catalog";
import { AuthService } from "../identity/auth-service";
import { GroupService } from "../identity/group-service";
import { OrganizationService } from "../identity/organization-service";
import { PermissionGrantService } from "../identity/permission-grant-service";
import type { Role } from "../identity/roles";
import type { Invitation, InvitationStatus } from "../identity/types";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { InMemoryUnitsReader } from "../testing/in-memory-units";
import { MembersOverviewService } from "./members-overview";
import { holdsSeat, includedSeats, includedSeatsFrom } from "./seats";

/**
 * The members page's reading (AT-5, ADR-0134): `member.view` to see it; the
 * members by role with their accounts; only pending invitations that have not
 * expired; seats from the plan's included users, taken by members and those
 * invitations; and nothing written. Which roles the viewer may invite with
 * (AT-6b, ADR-0136). Every instant is written out literally.
 */

const iso = (value: string) => new Date(value);
const NOW = iso("2026-11-10T12:00:00.000Z");

let deps: TestDeps;
let reader: InMemoryUnitsReader;
let service: MembersOverviewService;
let orgId: string;
let ids: Record<Role | "outsider", string>;

beforeEach(async () => {
  deps = createTestDeps();
  deps.clock.set(iso("2026-11-01T00:00:00.000Z"));
  reader = new InMemoryUnitsReader();
  service = new MembersOverviewService({ identity: deps, subscriptions: reader });
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const register = async (name: string) =>
    (await auth.register({ email: `${name}@example.com`, name: `${name} san`, password: "password-123456" })).id;
  const owner = await register("owner");
  ({ organization: { id: orgId } } = await new OrganizationService(deps).createOrganization(owner, { name: "Org" }));
  ids = { OWNER: owner } as Record<Role | "outsider", string>;
  // Joined in an order unlike the roles', a day apart.
  for (const [day, role] of (["VIEWER", "BILLING", "MANAGER", "ADMIN", "CREATOR"] as const).entries()) {
    deps.clock.set(iso(`2026-11-0${day + 2}T00:00:00.000Z`));
    ids[role] = await register(role.toLowerCase());
    await deps.repos.memberships.create({ organizationId: orgId, userId: ids[role], role });
  }
  ids.outsider = await register("outsider");
  deps.clock.set(NOW);
});

function subscribe(planKey: CustomerPlanKey, anchorAt = iso("2026-10-15T00:00:00.000Z")): void {
  reader.subscriptions.set(orgId, {
    id: `sub_${orgId}`,
    organizationId: orgId,
    planKey,
    channel: "SALES_ASSISTED",
    anchorAt,
    commercialReference: "C-1",
    createdAt: iso("2026-10-01T00:00:00.000Z"),
  });
}

function invite(
  email: string,
  overrides: Partial<Pick<Invitation, "id" | "organizationId" | "role" | "status" | "expiresAt" | "createdAt">> = {},
): void {
  deps.repos.invitations.put({
    id: deps.ids.generate("inv"),
    organizationId: orgId,
    email,
    role: "CREATOR",
    tokenHash: `hash:${email}`,
    status: "PENDING",
    invitedByUserId: ids.OWNER,
    expiresAt: iso("2026-11-16T00:00:00.000Z"),
    acceptedAt: null,
    createdAt: iso("2026-11-09T00:00:00.000Z"),
    ...overrides,
  });
}

describe("the members overview", () => {
  it.each(["CREATOR", "VIEWER", "outsider"] as const)("refuses a %s, who lacks member.view", async (who) => {
    subscribe("premium");
    await expect(service.overview(ids[who], orgId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lets an individual member.view grant through, as authorization does everywhere", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.CREATOR, "member.view");
    await expect(service.overview(ids.CREATOR, orgId)).resolves.toMatchObject({ members: expect.any(Array) });
  });

  it("lets a group's member.view through too", async () => {
    const groups = new GroupService(deps);
    const group = await groups.create(ids.OWNER, orgId, "Leads");
    await groups.addMember(ids.OWNER, orgId, group.id, ids.VIEWER);
    await groups.grantPermission(ids.OWNER, orgId, group.id, "member.view");
    await expect(service.overview(ids.VIEWER, orgId)).resolves.toMatchObject({ members: expect.any(Array) });
  });

  it.each(["OWNER", "ADMIN", "MANAGER", "BILLING"] as const)(
    "lists a %s the members by role, then the longest-standing first",
    async (who) => {
      const { members } = await service.overview(ids[who], orgId);
      expect(members.map(({ role }) => role)).toEqual(["OWNER", "ADMIN", "MANAGER", "CREATOR", "VIEWER", "BILLING"]);
      expect(members.filter(({ you }) => you).map(({ role }) => role)).toEqual([who]);
      expect(members[1]).toEqual({
        userId: ids.ADMIN,
        name: "admin san",
        email: "admin@example.com",
        role: "ADMIN",
        joinedAt: iso("2026-11-05T00:00:00.000Z"),
        you: who === "ADMIN",
      });
    },
  );

  it("never lists or counts another organization's members", async () => {
    subscribe("standard");
    const { organization: other } = await new OrganizationService(deps).createOrganization(ids.outsider, {
      name: "Other",
    });
    await deps.repos.memberships.create({ organizationId: other.id, userId: ids.VIEWER, role: "ADMIN" });
    const { members, seats } = await service.overview(ids.OWNER, orgId);
    expect(members.map(({ email }) => email)).not.toContain("outsider@example.com");
    expect(members.filter(({ email }) => email === "viewer@example.com").map(({ role }) => role)).toEqual(["VIEWER"]);
    expect(seats).toEqual({ included: 3, taken: 6 });
  });

  it("puts members of one role in the order they joined", async () => {
    deps.clock.set(iso("2026-11-08T00:00:00.000Z"));
    const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
    const later = (await auth.register({ email: "aaa@example.com", name: "aaa", password: "password-123456" })).id;
    await deps.repos.memberships.create({ organizationId: orgId, userId: later, role: "ADMIN" });
    deps.clock.set(NOW);
    const { members } = await service.overview(ids.OWNER, orgId);
    expect(members.filter(({ role }) => role === "ADMIN").map(({ email }) => email)).toEqual([
      "admin@example.com",
      "aaa@example.com",
    ]);
  });

  it("puts members who joined at the same instant in one fixed order", async () => {
    const at = iso("2026-11-08T00:00:00.000Z");
    deps.clock.set(at);
    for (const { id, email } of [
      { id: "usr_b", email: "b@example.com" },
      { id: "usr_a", email: "a@example.com" },
    ]) {
      const user = { id, email, name: email, status: "ACTIVE" as const };
      deps.repos.users.put({ ...user, emailVerifiedAt: at, createdAt: at, updatedAt: at });
      await deps.repos.memberships.create({ organizationId: orgId, userId: id, role: "MANAGER" });
    }
    deps.clock.set(NOW);
    const { members } = await service.overview(ids.OWNER, orgId);
    expect(members.filter(({ role }) => role === "MANAGER").map(({ email }) => email)).toEqual([
      "manager@example.com",
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("leaves out, and does not count, a member whose account is gone by the time it is read", async () => {
    subscribe("premium");
    await deps.repos.memberships.create({ organizationId: orgId, userId: "usr_gone", role: "CREATOR" });
    const { members, seats } = await service.overview(ids.OWNER, orgId);
    expect(members.map(({ role }) => role)).toEqual(["OWNER", "ADMIN", "MANAGER", "CREATOR", "VIEWER", "BILLING"]);
    expect(seats).toEqual({ included: 10, taken: 6 });
  });

  it("shows only pending invitations that have not expired, oldest first, never another organization's", async () => {
    invite("later@example.com", { id: "inv_later", role: "VIEWER", createdAt: iso("2026-11-09T06:00:00.000Z") });
    invite("first@example.com", { id: "inv_first", role: "MANAGER", createdAt: iso("2026-11-08T00:00:00.000Z") });
    invite("lapsed@example.com", { expiresAt: NOW });
    for (const status of ["ACCEPTED", "REVOKED", "EXPIRED"] satisfies InvitationStatus[]) {
      invite(`${status.toLowerCase()}@example.com`, { status });
    }
    const { organization: other } = await new OrganizationService(deps).createOrganization(ids.outsider, {
      name: "Other",
    });
    invite("elsewhere@example.com", { organizationId: other.id });

    const { invitations } = await service.overview(ids.MANAGER, orgId);
    expect(invitations).toEqual([
      {
        id: "inv_first",
        email: "first@example.com",
        role: "MANAGER",
        invitedAt: iso("2026-11-08T00:00:00.000Z"),
        expiresAt: iso("2026-11-16T00:00:00.000Z"),
      },
      {
        id: "inv_later",
        email: "later@example.com",
        role: "VIEWER",
        invitedAt: iso("2026-11-09T06:00:00.000Z"),
        expiresAt: iso("2026-11-16T00:00:00.000Z"),
      },
    ]);
  });

  it.each([
    ["OWNER", ["OWNER", "ADMIN", "MANAGER", "CREATOR", "VIEWER", "BILLING"]],
    ["ADMIN", ["MANAGER", "CREATOR", "VIEWER"]],
    ["MANAGER", []],
    ["BILLING", []],
  ] as const)("lets a %s invite with the roles its ceiling allows", async (who, roles) => {
    expect((await service.overview(ids[who], orgId)).invitableRoles).toEqual(roles);
  });

  it("offers a MANAGER granted member.manage no role, since the ceiling goes by role", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.MANAGER, "member.manage");
    expect((await service.overview(ids.MANAGER, orgId)).invitableRoles).toEqual([]);
  });

  it.each([
    ["OWNER", ["OWNER", "ADMIN", "MANAGER", "CREATOR", "VIEWER", "BILLING"]],
    ["ADMIN", ["MANAGER", "CREATOR", "VIEWER"]],
    ["MANAGER", []],
    ["BILLING", []],
  ] as const)("lets a %s give a member the roles its ceiling allows (ADR-0139)", async (who, roles) => {
    expect((await service.overview(ids[who], orgId)).assignableRoles).toEqual(roles);
  });

  it("offers a MANAGER granted permission.manage no role to give, since the ceiling goes by role", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.MANAGER, "permission.manage");
    expect((await service.overview(ids.MANAGER, orgId)).assignableRoles).toEqual([]);
  });

  it("has no seats while the organization has no plan", async () => {
    expect((await service.overview(ids.OWNER, orgId)).seats).toBeNull();
  });

  it.each([
    ["standard", 3],
    ["premium", 10],
    ["enterprise", 30],
  ] as const)("gives a %s plan its %i included users as seats", async (planKey, included) => {
    subscribe(planKey);
    expect((await service.overview(ids.OWNER, orgId)).seats).toEqual({ included, taken: 6 });
  });

  it("gives a plan that has not started yet its seats", async () => {
    subscribe("standard", iso("2026-12-01T00:00:00.000Z"));
    expect((await service.overview(ids.OWNER, orgId)).seats).toEqual({ included: 3, taken: 6 });
  });

  it("counts every member and every pending invitation that has not expired, even beyond the seats", async () => {
    subscribe("premium");
    invite("one@example.com");
    invite("two@example.com");
    invite("lapsed@example.com", { expiresAt: NOW });
    invite("revoked@example.com", { status: "REVOKED" });
    expect((await service.overview(ids.OWNER, orgId)).seats).toEqual({ included: 10, taken: 8 });
    subscribe("standard");
    expect((await service.overview(ids.OWNER, orgId)).seats).toEqual({ included: 3, taken: 8 });
  });

  it("writes nothing: no audit entry, and an invitation past its expiry stays pending", async () => {
    subscribe("premium");
    invite("lapsed@example.com", { expiresAt: NOW });
    const audits = (await deps.repos.auditLogs.listByOrganization(orgId)).length;
    await service.overview(ids.OWNER, orgId);
    await service.overview(ids.VIEWER, orgId).catch(() => undefined);
    expect(await deps.repos.auditLogs.listByOrganization(orgId)).toHaveLength(audits);
    const stored = await deps.repos.invitations.listByOrganization(orgId);
    expect(stored.find(({ email }) => email === "lapsed@example.com")?.status).toBe("PENDING");
  });
});

describe("seats", () => {
  it("are none without a plan", () => {
    expect(includedSeats(null)).toBeNull();
  });

  it("are read from the organization's plan for inviting, a plan not yet started included", async () => {
    const seatsOf = includedSeatsFrom(reader);
    expect(await seatsOf(orgId)).toBeNull();
    subscribe("premium", iso("2026-12-01T00:00:00.000Z"));
    expect(await seatsOf(orgId)).toBe(10);
  });

  it("are not held by an invitation from the instant it expires", () => {
    const expiresAt = iso("2026-11-16T00:00:00.000Z");
    expect(holdsSeat({ status: "PENDING", expiresAt }, iso("2026-11-15T23:59:59.999Z"))).toBe(true);
    expect(holdsSeat({ status: "PENDING", expiresAt }, expiresAt)).toBe(false);
    expect(holdsSeat({ status: "ACCEPTED", expiresAt }, iso("2026-11-10T00:00:00.000Z"))).toBe(false);
  });
});
