import { beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "./auth-service";
import { OrganizationService } from "./organization-service";
import { MembershipService } from "./membership-service";
import { authorizeOrganization } from "./authorization";
import { ROLES, type Role } from "./roles";
import type { AuditLog } from "./types";
import { createTestDeps, type TestDeps } from "../testing/in-memory";

/**
 * The role-assignment ceiling on every membership path (ADR-0052 Decision 10,
 * Phase 6C): invitation, acceptance, role change and removal.
 */

const PASSWORD = "password-123456";
const REFUSED = "member.role_change_refused";

interface Fixture {
  readonly deps: TestDeps;
  readonly auth: AuthService;
  readonly members: MembershipService;
  readonly orgId: string;
  readonly ownerId: string;
  /** One member per template besides the founding OWNER. */
  readonly ids: Readonly<Record<Role, string>>;
  readonly outsiderId: string;
}

let fx: Fixture;

beforeEach(async () => {
  const deps = createTestDeps();
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const members = new MembershipService(deps, { invitationTtlSeconds: 3600 });
  const owner = await auth.register({ email: "owner@example.com", name: "Owner", password: PASSWORD });
  const { organization } = await new OrganizationService(deps).createOrganization(owner.id, { name: "Org" });
  const ids = {} as Record<Role, string>;
  for (const role of ROLES) {
    const user = await auth.register({ email: `member-${role.toLowerCase()}@example.com`, name: role, password: PASSWORD });
    await deps.repos.memberships.create({ organizationId: organization.id, userId: user.id, role });
    ids[role] = user.id;
  }
  const outsider = await auth.register({ email: "outsider@example.com", name: "Out", password: PASSWORD });
  fx = { deps, auth, members, orgId: organization.id, ownerId: owner.id, ids, outsiderId: outsider.id };
});

function refusals(): AuditLog[] {
  return fx.deps.repos.auditLogs.all().filter((entry) => entry.action === REFUSED);
}

async function roleOf(userId: string): Promise<Role | undefined> {
  return (await fx.deps.repos.memberships.find(fx.orgId, userId))?.role;
}

describe("invite", () => {
  it.each(["MANAGER", "CREATOR", "VIEWER"] as const)("lets an ADMIN invite a %s", async (role) => {
    const { invitation } = await fx.members.invite(fx.ids.ADMIN, {
      organizationId: fx.orgId,
      email: "new@example.com",
      role,
    });
    expect(invitation.role).toBe(role);
    expect(refusals()).toEqual([]);
  });

  it.each(["OWNER", "ADMIN", "BILLING"] as const)("refuses and audits an ADMIN inviting an %s", async (role) => {
    await expect(
      fx.members.invite(fx.ids.ADMIN, { organizationId: fx.orgId, email: "new@example.com", role }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await fx.deps.repos.invitations.listByOrganization(fx.orgId)).toEqual([]);
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toMatchObject({
      organizationId: fx.orgId,
      actorUserId: fx.ids.ADMIN,
      resourceType: "organization",
      resourceId: fx.orgId,
      metadata: { operation: "invite", actorRole: "ADMIN", requestedRole: role, email: "new@example.com" },
    });
  });

  it("lets an OWNER invite every template", async () => {
    for (const role of ROLES) {
      await fx.members.invite(fx.ownerId, { organizationId: fx.orgId, email: `n-${role}@example.com`, role });
    }
    expect(await fx.deps.repos.invitations.listByOrganization(fx.orgId)).toHaveLength(ROLES.length);
  });

  it.each(["MANAGER", "CREATOR", "VIEWER", "BILLING"] as const)(
    "refuses and audits a %s, who lacks member.manage",
    async (role) => {
      await expect(
        fx.members.invite(fx.ids[role], { organizationId: fx.orgId, email: "new@example.com", role: "VIEWER" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(refusals()).toHaveLength(1);
      expect(refusals()[0]!.metadata).toMatchObject({ operation: "invite", actorRole: role });
    },
  );

  it("refuses a non-member without writing into the organization's audit trail", async () => {
    await expect(
      fx.members.invite(fx.outsiderId, { organizationId: fx.orgId, email: "new@example.com", role: "VIEWER" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(refusals()).toEqual([]);
  });
});

describe("changeRole", () => {
  it("refuses and audits an ADMIN promoting itself to OWNER", async () => {
    await expect(fx.members.changeRole(fx.ids.ADMIN, fx.orgId, fx.ids.ADMIN, "OWNER")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await roleOf(fx.ids.ADMIN)).toBe("ADMIN");
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toMatchObject({
      actorUserId: fx.ids.ADMIN,
      resourceType: "membership",
      resourceId: `${fx.orgId}:${fx.ids.ADMIN}`,
      metadata: {
        operation: "change_role",
        actorRole: "ADMIN",
        targetUserId: fx.ids.ADMIN,
        currentRole: "ADMIN",
        requestedRole: "OWNER",
      },
    });
  });

  it.each(["OWNER", "ADMIN", "BILLING"] as const)("refuses an ADMIN giving another member %s", async (role) => {
    await expect(fx.members.changeRole(fx.ids.ADMIN, fx.orgId, fx.ids.CREATOR, role)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await roleOf(fx.ids.CREATOR)).toBe("CREATOR");
    expect(refusals()).toHaveLength(1);
  });

  it.each(["OWNER", "BILLING"] as const)("refuses an ADMIN demoting an %s, a role it may not take away", async (role) => {
    await expect(fx.members.changeRole(fx.ids.ADMIN, fx.orgId, fx.ids[role], "VIEWER")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await roleOf(fx.ids[role])).toBe(role);
    expect(refusals()[0]!.metadata).toMatchObject({ currentRole: role, requestedRole: "VIEWER" });
  });

  it("lets an ADMIN move a member between MANAGER, CREATOR and VIEWER, recording the fixed Scope", async () => {
    await fx.members.changeRole(fx.ids.ADMIN, fx.orgId, fx.ids.CREATOR, "MANAGER");
    expect(await roleOf(fx.ids.CREATOR)).toBe("MANAGER");
    const changed = fx.deps.repos.auditLogs.all().find((entry) => entry.action === "member.role_changed");
    expect(changed).toMatchObject({
      actorUserId: fx.ids.ADMIN,
      metadata: { targetUserId: fx.ids.CREATOR, previousRole: "CREATOR", role: "MANAGER", scope: "GROUP" },
    });
    expect(refusals()).toEqual([]);
  });

  it("lets an OWNER assign BILLING and promote to OWNER", async () => {
    await fx.members.changeRole(fx.ownerId, fx.orgId, fx.ids.VIEWER, "BILLING");
    await fx.members.changeRole(fx.ownerId, fx.orgId, fx.ids.ADMIN, "OWNER");
    expect(await roleOf(fx.ids.VIEWER)).toBe("BILLING");
    expect(await roleOf(fx.ids.ADMIN)).toBe("OWNER");
  });

  it.each(["MANAGER", "CREATOR", "VIEWER", "BILLING"] as const)(
    "refuses and audits a %s changing its own role, which needs permission.manage",
    async (role) => {
      await expect(fx.members.changeRole(fx.ids[role], fx.orgId, fx.ids[role], "OWNER")).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(await roleOf(fx.ids[role])).toBe(role);
      expect(refusals()[0]!.metadata).toMatchObject({
        operation: "change_role",
        actorRole: role,
        currentRole: null,
        requestedRole: "OWNER",
      });
    },
  );

  it("still keeps the last OWNER, for an OWNER", async () => {
    // The fixture has two OWNERs; with one gone, the other is the last.
    await fx.members.removeMember(fx.ownerId, fx.orgId, fx.ids.OWNER);
    await expect(fx.members.changeRole(fx.ownerId, fx.orgId, fx.ownerId, "ADMIN")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

describe("removeMember", () => {
  it.each(["OWNER", "ADMIN", "BILLING"] as const)("refuses and audits an ADMIN removing an %s", async (role) => {
    await expect(fx.members.removeMember(fx.ids.ADMIN, fx.orgId, fx.ids[role])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await roleOf(fx.ids[role])).toBe(role);
    expect(refusals()[0]!.metadata).toMatchObject({ operation: "remove_member", currentRole: role });
  });

  it.each(["MANAGER", "CREATOR", "VIEWER"] as const)("lets an ADMIN remove a %s", async (role) => {
    await fx.members.removeMember(fx.ids.ADMIN, fx.orgId, fx.ids[role]);
    expect(await roleOf(fx.ids[role])).toBeUndefined();
  });

  it("refuses and audits a member without member.manage", async () => {
    await expect(fx.members.removeMember(fx.ids.BILLING, fx.orgId, fx.ids.VIEWER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await roleOf(fx.ids.VIEWER)).toBe("VIEWER");
    // Refused on the permission, before the target's role is read.
    expect(refusals()[0]!.metadata).toMatchObject({
      operation: "remove_member",
      actorRole: "BILLING",
      currentRole: null,
    });
  });
});

describe("acceptInvitation", () => {
  async function inviteAs(inviterId: string, role: Role): Promise<{ token: string; invitationId: string }> {
    const { token, invitation } = await fx.members.invite(inviterId, {
      organizationId: fx.orgId,
      email: "invitee@example.com",
      role,
    });
    return { token, invitationId: invitation.id };
  }

  it("grants the role when the inviter may still assign it", async () => {
    const { token } = await inviteAs(fx.ids.ADMIN, "MANAGER");
    const invitee = await fx.auth.register({ email: "invitee@example.com", name: "I", password: PASSWORD });
    const membership = await fx.members.acceptInvitation(invitee.id, token);
    expect(membership.role).toBe("MANAGER");
    const accepted = fx.deps.repos.auditLogs.all().find((entry) => entry.action === "invitation.accepted");
    expect(accepted?.metadata).toEqual({ role: "MANAGER", scope: "GROUP" });
  });

  it("refuses and audits an ADMIN invitation whose inviter has since been demoted", async () => {
    const { token, invitationId } = await inviteAs(fx.ownerId, "ADMIN");
    // A second OWNER demotes the inviter to VIEWER, who may assign nothing.
    await fx.members.changeRole(fx.ids.OWNER, fx.orgId, fx.ownerId, "VIEWER");
    const invitee = await fx.auth.register({ email: "invitee@example.com", name: "I", password: PASSWORD });

    await expect(fx.members.acceptInvitation(invitee.id, token)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await roleOf(invitee.id)).toBeUndefined();
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toMatchObject({
      actorUserId: invitee.id,
      resourceType: "invitation",
      resourceId: invitationId,
      metadata: {
        operation: "accept_invitation",
        requestedRole: "ADMIN",
        invitedByUserId: fx.ownerId,
        inviterRole: "VIEWER",
      },
    });
  });

  it("refuses an ADMIN invitation whose inviter is now an ADMIN, which still manages members", async () => {
    const { token } = await inviteAs(fx.ownerId, "ADMIN");
    // The inviter keeps member.manage but may no longer assign ADMIN.
    await fx.members.changeRole(fx.ids.OWNER, fx.orgId, fx.ownerId, "ADMIN");
    const invitee = await fx.auth.register({ email: "invitee@example.com", name: "I", password: PASSWORD });

    await expect(fx.members.acceptInvitation(invitee.id, token)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await roleOf(invitee.id)).toBeUndefined();
    expect(refusals()[0]!.metadata).toMatchObject({ requestedRole: "ADMIN", inviterRole: "ADMIN" });
  });

  it("refuses an invitation whose inviter is no longer a member", async () => {
    const { token } = await inviteAs(fx.ids.ADMIN, "VIEWER");
    await fx.members.removeMember(fx.ownerId, fx.orgId, fx.ids.ADMIN);
    const invitee = await fx.auth.register({ email: "invitee@example.com", name: "I", password: PASSWORD });

    await expect(fx.members.acceptInvitation(invitee.id, token)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await roleOf(invitee.id)).toBeUndefined();
    expect(refusals()[0]!.metadata).toMatchObject({ inviterRole: null });
  });
});

describe("listMembers", () => {
  it.each(["OWNER", "ADMIN", "MANAGER", "BILLING"] as const)("lets a %s, who holds member.view, list members", async (role) => {
    expect(await fx.members.listMembers(fx.ids[role], fx.orgId)).toHaveLength(ROLES.length + 1);
  });

  it.each(["CREATOR", "VIEWER"] as const)("refuses a %s, who does not hold member.view", async (role) => {
    await expect(fx.members.listMembers(fx.ids[role], fx.orgId)).rejects.toThrow(/lacks permission 'member\.view'/);
  });
});

describe("authorizeOrganization", () => {
  it("requires every permission it is given, not only the first", async () => {
    await expect(
      authorizeOrganization(fx.deps, fx.ids.CREATOR, fx.orgId, ["organization.view", "billing.manage"]),
    ).rejects.toThrow(/lacks permission 'billing\.manage'/);
    await expect(
      authorizeOrganization(fx.deps, fx.ids.BILLING, fx.orgId, ["organization.view", "billing.manage"]),
    ).resolves.toMatchObject({ role: "BILLING" });
  });

  it("checks a single permission given alone, and only membership when given none", async () => {
    await expect(authorizeOrganization(fx.deps, fx.ids.VIEWER, fx.orgId, "member.view")).rejects.toThrow(
      /lacks permission 'member\.view'/,
    );
    await expect(authorizeOrganization(fx.deps, fx.ids.VIEWER, fx.orgId)).resolves.toMatchObject({ role: "VIEWER" });
    await expect(authorizeOrganization(fx.deps, fx.outsiderId, fx.orgId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
