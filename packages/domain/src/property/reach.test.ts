import { beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../identity/auth-service";
import type { AuthContext } from "../identity/authorization";
import { GroupService } from "../identity/group-service";
import { OrganizationService } from "../identity/organization-service";
import { ROLES, type Role } from "../identity/roles";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { InMemoryPropertyRepository } from "../testing/in-memory-property";
import { findReachableProperty, reachOf, reaches, type Reach } from "./reach";
import type { Property } from "./types";

/**
 * The reach predicate (ADR-0052 Decision 10, Phase 6I, ADR-0064): which of its
 * organization's Properties a member reaches, by its role's fixed scope and the
 * Property's assignments alone.
 */

const PASSWORD = "password-123456";
const ORG = "org_reach";
const OTHER = "org_reach_other";
const ME = "usr_me";
const SOMEONE = "usr_someone";

function property(assignment: { responsibleUserId?: string | null; groupId?: string | null; organizationId?: string } = {}) {
  return {
    organizationId: assignment.organizationId ?? ORG,
    responsibleUserId: assignment.responsibleUserId ?? null,
    groupId: assignment.groupId ?? null,
  };
}

describe("reaches", () => {
  const organization: Reach = { scope: "ORGANIZATION", organizationId: ORG };
  const group: Reach = { scope: "GROUP", organizationId: ORG, groupIds: ["grp_a", "grp_b"] };
  const noGroup: Reach = { scope: "GROUP", organizationId: ORG, groupIds: [] };
  const own: Reach = { scope: "OWN", organizationId: ORG, userId: ME };

  it("ORGANIZATION reaches every Property of the organization, assigned or not", () => {
    expect(reaches(organization, property())).toBe(true);
    expect(reaches(organization, property({ responsibleUserId: SOMEONE, groupId: "grp_z" }))).toBe(true);
  });

  it("GROUP reaches a Property in any of the member's groups", () => {
    expect(reaches(group, property({ groupId: "grp_a" }))).toBe(true);
    expect(reaches(group, property({ groupId: "grp_b" }))).toBe(true);
  });

  it("GROUP does not reach another group's Property, an ungrouped one, or one it is responsible for", () => {
    expect(reaches(group, property({ groupId: "grp_c" }))).toBe(false);
    expect(reaches(group, property())).toBe(false);
    expect(reaches({ ...group, groupIds: ["grp_a"] }, property({ responsibleUserId: ME }))).toBe(false);
    expect(reaches(noGroup, property({ groupId: "grp_a" }))).toBe(false);
    expect(reaches(noGroup, property())).toBe(false);
  });

  it("OWN reaches only a Property the member is the responsible user of", () => {
    expect(reaches(own, property({ responsibleUserId: ME }))).toBe(true);
    expect(reaches(own, property({ responsibleUserId: ME, groupId: "grp_a" }))).toBe(true);
    expect(reaches(own, property({ responsibleUserId: SOMEONE }))).toBe(false);
    expect(reaches(own, property())).toBe(false);
    expect(reaches(own, property({ groupId: "grp_a" }))).toBe(false);
  });

  it("no scope reaches another organization's Property", () => {
    const elsewhere = { organizationId: OTHER, responsibleUserId: ME, groupId: "grp_a" };
    for (const reach of [organization, group, own]) expect(reaches(reach, elsewhere)).toBe(false);
  });
});

describe("reachOf and findReachableProperty", () => {
  let deps: TestDeps;
  let repo: InMemoryPropertyRepository;
  let orgId: string;
  let otherOrgId: string;
  let ownerId: string;
  let memberId: string;
  let groupId: string;

  beforeEach(async () => {
    deps = createTestDeps();
    repo = new InMemoryPropertyRepository(deps.clock, deps.repos);
    const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
    const organizations = new OrganizationService(deps);
    const owner = await auth.register({ email: "owner@example.com", name: "Owner", password: PASSWORD });
    const member = await auth.register({ email: "member@example.com", name: "Member", password: PASSWORD });
    orgId = (await organizations.createOrganization(owner.id, { name: "Org" })).organization.id;
    otherOrgId = (await organizations.createOrganization(owner.id, { name: "Other" })).organization.id;
    await deps.repos.memberships.create({ organizationId: orgId, userId: member.id, role: "MANAGER" });
    groupId = (await new GroupService(deps).create(owner.id, orgId, "East")).id;
    ownerId = owner.id;
    memberId = member.id;
  });

  function actor(role: Role, userId = memberId, organizationId = orgId): AuthContext {
    return { userId, organizationId, role, permissions: [] };
  }

  async function stored(extra: Partial<Property> = {}): Promise<Property> {
    const id = deps.ids.generate("prp");
    const created = await repo.create(
      {
        id,
        organizationId: orgId,
        name: id,
        propertyType: "HOUSE",
        addressMasked: null,
        description: null,
        status: "ACTIVE",
        createdBy: ownerId,
        responsibleUserId: null,
        groupId: null,
        ...extra,
      },
      { organizationId: orgId, actorUserId: ownerId, action: "property.created", resourceType: "property", resourceId: id, metadata: {} },
    );
    if (created.outcome !== "CREATED") throw new Error("the Property was not stored");
    return created.property;
  }

  it("fixes the scope by role and reads a MANAGER's current groups", async () => {
    const scopes: Record<string, string> = {};
    for (const role of ROLES) scopes[role] = (await reachOf(deps, actor(role))).scope;
    expect(scopes).toEqual({
      OWNER: "ORGANIZATION",
      ADMIN: "ORGANIZATION",
      MANAGER: "GROUP",
      CREATOR: "OWN",
      VIEWER: "OWN",
      BILLING: "ORGANIZATION",
    });
    expect(await reachOf(deps, actor("MANAGER"))).toEqual({ scope: "GROUP", organizationId: orgId, groupIds: [] });
    await new GroupService(deps).addMember(ownerId, orgId, groupId, memberId);
    expect(await reachOf(deps, actor("MANAGER"))).toEqual({ scope: "GROUP", organizationId: orgId, groupIds: [groupId] });
    expect(await reachOf(deps, actor("VIEWER"))).toEqual({ scope: "OWN", organizationId: orgId, userId: memberId });
  });

  it("returns a Property only when it exists in the organization and is reached", async () => {
    const mine = await stored({ responsibleUserId: memberId });
    const theirs = await stored({ responsibleUserId: ownerId });
    const deleted = await stored({ responsibleUserId: memberId, status: "DELETED" });

    expect(await findReachableProperty(deps, repo, actor("VIEWER"), mine.id)).toEqual(mine);
    expect(await findReachableProperty(deps, repo, actor("VIEWER"), theirs.id)).toBeNull();
    expect(await findReachableProperty(deps, repo, actor("VIEWER"), "prp_missing")).toBeNull();
    // A deleted Property is returned as it is; each caller keeps its own rule.
    expect(await findReachableProperty(deps, repo, actor("VIEWER"), deleted.id)).toEqual(deleted);
    // Only the organization the member was authorized in is looked in.
    expect(await findReachableProperty(deps, repo, actor("OWNER", ownerId, otherOrgId), mine.id)).toBeNull();
    // Its creator, now judged by OWN, does not reach a Property someone else is responsible for.
    expect(await findReachableProperty(deps, repo, actor("CREATOR", ownerId), mine.id)).toBeNull();
  });
});
