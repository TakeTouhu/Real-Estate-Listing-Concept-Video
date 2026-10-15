import { beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../identity/auth-service";
import { GroupService } from "../identity/group-service";
import { MembershipService } from "../identity/membership-service";
import { OrganizationService } from "../identity/organization-service";
import { ROLES, type Role } from "../identity/roles";
import type { AuditLog } from "../identity/types";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { InMemoryMediaAssetRepository, InMemoryPropertyRepository } from "../testing/in-memory-property";
import { PropertyService, type CreatePropertyInput } from "./property-service";
import type { Property } from "./types";

/**
 * Property assignment (ADR-0052 Decisions 10 and 11, Phase 6H, ADR-0062): the
 * responsible user and group a Property starts with, by its creator's role;
 * who may change them later; and what a group's deletion or a member's removal
 * releases. Reach is not enforced yet (6I).
 */

const PASSWORD = "password-123456";
const INELIGIBLE = "The responsible user must be a member of this organization who is not BILLING";
const NOT_A_GROUP = "The group must be a group of this organization";

interface Fixture {
  readonly deps: TestDeps;
  readonly service: PropertyService;
  readonly repo: InMemoryPropertyRepository;
  readonly groups: GroupService;
  readonly members: MembershipService;
  readonly orgId: string;
  readonly otherOrgId: string;
  /** The founding OWNER. */
  readonly ownerId: string;
  /** One member per template besides the founding OWNER. */
  readonly ids: Readonly<Record<Role, string>>;
  readonly outsiderId: string;
  /** Groups of the organization: the MANAGER belongs to `east` and `west`, not `north`. */
  readonly east: string;
  readonly west: string;
  readonly north: string;
  /** A group of the other organization. */
  readonly elsewhere: string;
}

let fx: Fixture;

beforeEach(async () => {
  const deps = createTestDeps();
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const organizations = new OrganizationService(deps);
  const owner = await auth.register({ email: "owner@example.com", name: "Owner", password: PASSWORD });
  const { organization } = await organizations.createOrganization(owner.id, { name: "Org" });
  const other = await organizations.createOrganization(owner.id, { name: "Other" });
  const ids = {} as Record<Role, string>;
  for (const role of ROLES) {
    const user = await auth.register({ email: `member-${role.toLowerCase()}@example.com`, name: role, password: PASSWORD });
    await deps.repos.memberships.create({ organizationId: organization.id, userId: user.id, role });
    ids[role] = user.id;
  }
  const outsider = await auth.register({ email: "outsider@example.com", name: "Out", password: PASSWORD });
  const groups = new GroupService(deps);
  const east = (await groups.create(owner.id, organization.id, "East")).id;
  const west = (await groups.create(owner.id, organization.id, "West")).id;
  const north = (await groups.create(owner.id, organization.id, "North")).id;
  const elsewhere = (await groups.create(owner.id, other.organization.id, "East")).id;
  await groups.addMember(owner.id, organization.id, east, ids.MANAGER);
  await groups.addMember(owner.id, organization.id, west, ids.MANAGER);
  await groups.addMember(owner.id, organization.id, east, ids.CREATOR);
  const repo = new InMemoryPropertyRepository(deps.clock, deps.repos);
  fx = {
    deps,
    repo,
    service: new PropertyService({
      identity: deps,
      properties: repo,
      assets: new InMemoryMediaAssetRepository(deps.clock),
      clock: deps.clock,
      ids: deps.ids,
    }),
    groups,
    members: new MembershipService(deps, { invitationTtlSeconds: 3600 }),
    orgId: organization.id,
    otherOrgId: other.organization.id,
    ownerId: owner.id,
    ids,
    outsiderId: outsider.id,
    east,
    west,
    north,
    elsewhere,
  };
});

function audits(action: string): AuditLog[] {
  return fx.deps.repos.auditLogs.all().filter((entry) => entry.action === action);
}

function create(actorUserId: string, choice: Pick<CreatePropertyInput, "responsibleUserId" | "groupId"> = {}): Promise<Property> {
  return fx.service.create(actorUserId, {
    organizationId: fx.orgId,
    name: "Harbor View",
    propertyType: "APARTMENT",
    rightsConfirmed: true,
    ...choice,
  });
}

async function stored(): Promise<Property[]> {
  return fx.repo.listReachable({ scope: "ORGANIZATION", organizationId: fx.orgId });
}

function assignment(property: Property | null): { responsibleUserId: string | null; groupId: string | null } {
  return { responsibleUserId: property?.responsibleUserId ?? null, groupId: property?.groupId ?? null };
}

/** Make the MANAGER a member of exactly `groupIds`. */
async function managerGroups(...groupIds: string[]): Promise<void> {
  for (const groupId of [fx.east, fx.west]) await fx.groups.removeMember(fx.ownerId, fx.orgId, groupId, fx.ids.MANAGER);
  for (const groupId of groupIds) await fx.groups.addMember(fx.ownerId, fx.orgId, groupId, fx.ids.MANAGER);
}

describe("creation-time assignments by creator role", () => {
  it.each(["OWNER", "ADMIN"] as const)("leaves both unset when an %s chooses nothing", async (role) => {
    const property = await create(fx.ids[role]);
    expect(assignment(property)).toEqual({ responsibleUserId: null, groupId: null });
    expect(audits("property.created")).toEqual([
      expect.objectContaining({
        organizationId: fx.orgId,
        actorUserId: fx.ids[role],
        resourceType: "property",
        resourceId: property.id,
        metadata: { propertyType: "APARTMENT", creatorRole: role, responsibleUserId: null, groupId: null },
      }),
    ]);
  });

  it.each(["OWNER", "ADMIN"] as const)("lets an %s choose any member but BILLING, and any group", async (role) => {
    for (const target of ["OWNER", "ADMIN", "MANAGER", "CREATOR", "VIEWER"] as const) {
      const property = await create(fx.ids[role], { responsibleUserId: fx.ids[target], groupId: fx.north });
      expect(assignment(await fx.repo.findById(fx.orgId, property.id))).toEqual({
        responsibleUserId: fx.ids[target],
        groupId: fx.north,
      });
    }
    expect(audits("property.created").at(-1)?.metadata).toEqual({
      propertyType: "APARTMENT",
      creatorRole: role,
      responsibleUserId: fx.ids.VIEWER,
      groupId: fx.north,
    });
  });

  it("refuses a BILLING member, a non-member and an unknown user as the responsible user", async () => {
    for (const responsibleUserId of [fx.ids.BILLING, fx.outsiderId, "usr_missing"]) {
      await expect(create(fx.ownerId, { responsibleUserId })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: INELIGIBLE,
      });
    }
    expect(await stored()).toEqual([]);
    expect(audits("property.created")).toEqual([]);
  });

  it("refuses another organization's group and an unknown group", async () => {
    for (const groupId of [fx.elsewhere, "grp_missing"]) {
      await expect(create(fx.ids.ADMIN, { groupId })).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: NOT_A_GROUP });
    }
    expect(await stored()).toEqual([]);
  });

  it("fixes a MANAGER as its own responsible user, in its only group", async () => {
    await managerGroups(fx.west);
    // Its group in another organization is not one of its groups here.
    await fx.deps.repos.memberships.create({ organizationId: fx.otherOrgId, userId: fx.ids.MANAGER, role: "MANAGER" });
    await fx.groups.addMember(fx.ownerId, fx.otherOrgId, fx.elsewhere, fx.ids.MANAGER);
    const property = await create(fx.ids.MANAGER);
    expect(assignment(property)).toEqual({ responsibleUserId: fx.ids.MANAGER, groupId: fx.west });
    expect(audits("property.created")[0]?.metadata).toEqual({
      propertyType: "APARTMENT",
      creatorRole: "MANAGER",
      responsibleUserId: fx.ids.MANAGER,
      groupId: fx.west,
    });
  });

  it("lets a MANAGER in several groups name one of them, and makes it name one", async () => {
    await expect(create(fx.ids.MANAGER)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await stored()).toEqual([]);
    const property = await create(fx.ids.MANAGER, { responsibleUserId: fx.ids.MANAGER, groupId: fx.west });
    expect(assignment(property)).toEqual({ responsibleUserId: fx.ids.MANAGER, groupId: fx.west });
    expect(audits("property.assignment_refused")).toEqual([]);
  });

  it("refuses, and audits, a MANAGER naming a group it does not belong to", async () => {
    await expect(create(fx.ids.MANAGER, { groupId: fx.north })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(create(fx.ids.MANAGER, { groupId: fx.elsewhere })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await stored()).toEqual([]);
    expect(audits("property.assignment_refused").map((entry) => entry.metadata)).toEqual([
      { operation: "create", reason: "group_not_own", actorRole: "MANAGER", responsibleUserId: null, groupId: fx.north },
      { operation: "create", reason: "group_not_own", actorRole: "MANAGER", responsibleUserId: null, groupId: fx.elsewhere },
    ]);
  });

  it("refuses, and audits, a MANAGER in no group: its Property could not be grouped", async () => {
    await managerGroups();
    await expect(create(fx.ids.MANAGER)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await stored()).toEqual([]);
    expect(audits("property.assignment_refused")).toEqual([
      expect.objectContaining({
        organizationId: fx.orgId,
        actorUserId: fx.ids.MANAGER,
        resourceType: "organization",
        resourceId: fx.orgId,
        metadata: { operation: "create", reason: "no_group", actorRole: "MANAGER", responsibleUserId: null, groupId: null },
      }),
    ]);
  });

  it.each(["MANAGER", "CREATOR"] as const)("refuses, and audits, a %s naming anyone else as responsible user", async (role) => {
    await expect(create(fx.ids[role], { responsibleUserId: fx.ids.VIEWER, groupId: fx.east })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await stored()).toEqual([]);
    expect(audits("property.assignment_refused").map((entry) => entry.metadata)).toEqual([
      { operation: "create", reason: "responsible_user_fixed", actorRole: role, responsibleUserId: fx.ids.VIEWER, groupId: fx.east },
    ]);
  });

  it("fixes a CREATOR as its own responsible user, ungrouped", async () => {
    const property = await create(fx.ids.CREATOR, { responsibleUserId: fx.ids.CREATOR });
    expect(assignment(property)).toEqual({ responsibleUserId: fx.ids.CREATOR, groupId: null });
    expect(audits("property.created")[0]?.metadata).toMatchObject({ creatorRole: "CREATOR", groupId: null });
  });

  it("refuses, and audits, a CREATOR naming any group, its own included", async () => {
    await expect(create(fx.ids.CREATOR, { groupId: fx.east })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await stored()).toEqual([]);
    expect(audits("property.assignment_refused").map((entry) => entry.metadata.reason)).toEqual(["group_not_selectable"]);
  });

  it.each(["VIEWER", "BILLING"] as const)("never lets a %s create, so no assignment rule applies to it", async (role) => {
    await expect(create(fx.ids[role])).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await stored()).toEqual([]);
  });

  it("does not write a Property whose responsible user left meanwhile", async () => {
    const created = await fx.repo.create(
      {
        id: "prp_stale",
        organizationId: fx.orgId,
        name: "Stale",
        propertyType: "HOUSE",
        addressMasked: null,
        description: null,
        status: "ACTIVE",
        createdBy: fx.ownerId,
        responsibleUserId: fx.outsiderId,
        groupId: null,
      },
      { organizationId: fx.orgId, actorUserId: fx.ownerId, action: "property.created", resourceType: "property", resourceId: "prp_stale", metadata: {} },
    );
    expect(created).toEqual({ outcome: "STALE" });
    expect(await stored()).toEqual([]);
    expect(audits("property.created")).toEqual([]);
  });
});

describe("reassignment", () => {
  let property: Property;
  beforeEach(async () => {
    property = await create(fx.ownerId, { responsibleUserId: fx.ids.CREATOR, groupId: fx.east });
  });

  it.each(["OWNER", "ADMIN"] as const)("lets an %s change both assignments, recording previous and new", async (role) => {
    const result = await fx.service.assign(fx.ids[role], fx.orgId, property.id, {
      responsibleUserId: fx.ids.VIEWER,
      groupId: fx.north,
    });
    expect(result.changed).toBe(true);
    expect(assignment(result.property)).toEqual({ responsibleUserId: fx.ids.VIEWER, groupId: fx.north });
    expect(assignment(await fx.repo.findById(fx.orgId, property.id))).toEqual(assignment(result.property));
    expect(audits("property.assignment_changed")).toEqual([
      expect.objectContaining({
        organizationId: fx.orgId,
        actorUserId: fx.ids[role],
        resourceType: "property",
        resourceId: property.id,
        metadata: {
          actorRole: role,
          previousResponsibleUserId: fx.ids.CREATOR,
          responsibleUserId: fx.ids.VIEWER,
          previousGroupId: fx.east,
          groupId: fx.north,
        },
      }),
    ]);
  });

  it("keeps an omitted assignment and unsets a null one", async () => {
    const ungrouped = await fx.service.assign(fx.ownerId, fx.orgId, property.id, { groupId: null });
    expect(assignment(ungrouped.property)).toEqual({ responsibleUserId: fx.ids.CREATOR, groupId: null });
    const unassigned = await fx.service.assign(fx.ownerId, fx.orgId, property.id, { responsibleUserId: null });
    expect(assignment(unassigned.property)).toEqual({ responsibleUserId: null, groupId: null });
    expect(audits("property.assignment_changed")).toHaveLength(2);
  });

  it("writes nothing for a change that changes nothing", async () => {
    for (const input of [{}, { responsibleUserId: fx.ids.CREATOR }, { responsibleUserId: fx.ids.CREATOR, groupId: fx.east }]) {
      const result = await fx.service.assign(fx.ownerId, fx.orgId, property.id, input);
      expect(result).toEqual({ property: await fx.repo.findById(fx.orgId, property.id), changed: false });
    }
    expect(audits("property.assignment_changed")).toEqual([]);
  });

  it.each(["MANAGER", "CREATOR", "VIEWER", "BILLING"] as const)(
    "refuses, and audits, a %s, even one holding property.edit, before looking the Property up",
    async (role) => {
      for (const propertyId of [property.id, "prp_missing"]) {
        await expect(
          fx.service.assign(fx.ids[role], fx.orgId, propertyId, { responsibleUserId: fx.ids[role] }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      expect(assignment(await fx.repo.findById(fx.orgId, property.id))).toEqual({
        responsibleUserId: fx.ids.CREATOR,
        groupId: fx.east,
      });
      expect(audits("property.assignment_refused")).toEqual([
        expect.objectContaining({
          actorUserId: fx.ids[role],
          resourceType: "property",
          resourceId: property.id,
          metadata: { operation: "assign", reason: "reassignment_role", actorRole: role, responsibleUserId: fx.ids[role], groupId: null },
        }),
        expect.objectContaining({ resourceId: "prp_missing" }),
      ]);
      expect(audits("property.assignment_changed")).toEqual([]);
    },
  );

  it("refuses a non-member without auditing it", async () => {
    await expect(fx.service.assign(fx.outsiderId, fx.orgId, property.id, { groupId: null })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(audits("property.assignment_refused")).toEqual([]);
  });

  it("does not find a missing, deleted or other organization's Property", async () => {
    await expect(fx.service.assign(fx.ownerId, fx.otherOrgId, property.id, { groupId: null })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(fx.service.assign(fx.ownerId, fx.orgId, "prp_missing", { groupId: null })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await fx.service.remove(fx.ownerId, fx.orgId, property.id);
    await expect(fx.service.assign(fx.ownerId, fx.orgId, property.id, { groupId: null })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(audits("property.assignment_changed")).toEqual([]);
  });

  it("refuses a BILLING member, a non-member, and another organization's group as the new choice", async () => {
    for (const [input, message] of [
      [{ responsibleUserId: fx.ids.BILLING }, INELIGIBLE],
      [{ responsibleUserId: fx.outsiderId }, INELIGIBLE],
      [{ groupId: fx.elsewhere }, NOT_A_GROUP],
    ] as const) {
      await expect(fx.service.assign(fx.ownerId, fx.orgId, property.id, input)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message,
      });
    }
    expect(assignment(await fx.repo.findById(fx.orgId, property.id))).toEqual({
      responsibleUserId: fx.ids.CREATOR,
      groupId: fx.east,
    });
    expect(audits("property.assignment_changed")).toEqual([]);
  });

  it("keeps a responsible user whose role changed, and still lets the group change", async () => {
    await fx.members.changeRole(fx.ownerId, fx.orgId, fx.ids.CREATOR, "BILLING");
    expect(assignment(await fx.repo.findById(fx.orgId, property.id))).toEqual({
      responsibleUserId: fx.ids.CREATOR,
      groupId: fx.east,
    });
    const result = await fx.service.assign(fx.ownerId, fx.orgId, property.id, { groupId: fx.west });
    expect(assignment(result.property)).toEqual({ responsibleUserId: fx.ids.CREATOR, groupId: fx.west });
  });

  it("lets only one of two concurrent reassignments from the same assignments win", async () => {
    const results = await Promise.allSettled([
      fx.service.assign(fx.ownerId, fx.orgId, property.id, { responsibleUserId: fx.ids.VIEWER }),
      fx.service.assign(fx.ids.ADMIN, fx.orgId, property.id, { responsibleUserId: fx.ids.MANAGER }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { code: "VALIDATION_FAILED" } });
    expect(assignment(await fx.repo.findById(fx.orgId, property.id))).toEqual({
      responsibleUserId: fx.ids.VIEWER,
      groupId: fx.east,
    });
    expect(audits("property.assignment_changed")).toHaveLength(1);
  });

  it("is never undone by editing or deleting the Property", async () => {
    // A write from a snapshot taken before a reassignment keeps the assignments.
    await fx.repo.update({ ...property, responsibleUserId: null, groupId: null, name: "Stale" });
    await fx.service.update(fx.ownerId, fx.orgId, property.id, { name: "Renamed" });
    expect(assignment(await fx.repo.findById(fx.orgId, property.id))).toEqual({
      responsibleUserId: fx.ids.CREATOR,
      groupId: fx.east,
    });
    await fx.service.remove(fx.ownerId, fx.orgId, property.id);
    expect(assignment(await fx.repo.findById(fx.orgId, property.id))).toEqual({
      responsibleUserId: fx.ids.CREATOR,
      groupId: fx.east,
    });
  });
});

describe("releasing assignments", () => {
  it("ungroups a deleted group's Properties, and only those, counting them", async () => {
    const inEast = await create(fx.ownerId, { responsibleUserId: fx.ids.VIEWER, groupId: fx.east });
    const alsoEast = await create(fx.ids.ADMIN, { groupId: fx.east });
    const inWest = await create(fx.ownerId, { groupId: fx.west });
    await fx.groups.delete(fx.ownerId, fx.orgId, fx.east);
    expect(assignment(await fx.repo.findById(fx.orgId, inEast.id))).toEqual({ responsibleUserId: fx.ids.VIEWER, groupId: null });
    expect(assignment(await fx.repo.findById(fx.orgId, alsoEast.id))).toEqual({ responsibleUserId: null, groupId: null });
    expect(assignment(await fx.repo.findById(fx.orgId, inWest.id))).toEqual({ responsibleUserId: null, groupId: fx.west });
    expect(audits("group.deleted")[0]?.metadata).toMatchObject({ removedMemberCount: 2, ungroupedPropertyCount: 2 });
  });

  it("unassigns a removed member's Properties, and only those, counting them", async () => {
    const first = await create(fx.ownerId, { responsibleUserId: fx.ids.VIEWER, groupId: fx.north });
    const second = await create(fx.ownerId, { responsibleUserId: fx.ids.VIEWER });
    const other = await create(fx.ownerId, { responsibleUserId: fx.ids.CREATOR });
    await fx.members.removeMember(fx.ownerId, fx.orgId, fx.ids.VIEWER);
    expect(assignment(await fx.repo.findById(fx.orgId, first.id))).toEqual({ responsibleUserId: null, groupId: fx.north });
    expect(assignment(await fx.repo.findById(fx.orgId, second.id))).toEqual({ responsibleUserId: null, groupId: null });
    expect(assignment(await fx.repo.findById(fx.orgId, other.id))).toEqual({ responsibleUserId: fx.ids.CREATOR, groupId: null });
    expect(audits("member.removed")[0]?.metadata).toEqual({ unassignedPropertyCount: 2 });
  });

  it("counts nothing when nothing referred to the group or member", async () => {
    await fx.groups.delete(fx.ownerId, fx.orgId, fx.north);
    await fx.members.removeMember(fx.ownerId, fx.orgId, fx.ids.VIEWER);
    expect(audits("group.deleted")[0]?.metadata).toMatchObject({ ungroupedPropertyCount: 0 });
    expect(audits("member.removed")[0]?.metadata).toEqual({ unassignedPropertyCount: 0 });
  });

  it("never reassigns to a member who left or a group deleted after the check", async () => {
    const property = await create(fx.ownerId);
    const expected = { responsibleUserId: null, groupId: null };
    const audit = { organizationId: fx.orgId, actorUserId: fx.ownerId, action: "property.assignment_changed", resourceType: "property", resourceId: property.id, metadata: {} };
    await fx.members.removeMember(fx.ownerId, fx.orgId, fx.ids.VIEWER);
    await fx.groups.delete(fx.ownerId, fx.orgId, fx.north);
    expect(await fx.repo.assign(fx.orgId, property.id, expected, { responsibleUserId: fx.ids.VIEWER, groupId: null }, audit)).toEqual({
      outcome: "STALE",
    });
    expect(await fx.repo.assign(fx.orgId, property.id, expected, { responsibleUserId: null, groupId: fx.north }, audit)).toEqual({
      outcome: "STALE",
    });
    expect(assignment(await fx.repo.findById(fx.orgId, property.id))).toEqual(expected);
    expect(audits("property.assignment_changed")).toEqual([]);
  });
});
