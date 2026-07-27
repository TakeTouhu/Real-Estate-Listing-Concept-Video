import { beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "./auth-service";
import { OrganizationService } from "./organization-service";
import { MembershipService } from "./membership-service";
import { createTestDeps, type TestDeps } from "../testing/in-memory";

const PASSWORD = "password-123456";

function setup() {
  const deps: TestDeps = createTestDeps();
  return {
    deps,
    auth: new AuthService(deps, { sessionTtlSeconds: 3600 }),
    orgs: new OrganizationService(deps),
    members: new MembershipService(deps, { invitationTtlSeconds: 3600 }),
  };
}

describe("AuthService", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("registers a user with a credential and an audit event", async () => {
    const user = await ctx.auth.register({ email: "A@Example.com", name: "A", password: PASSWORD });
    expect(user.email).toBe("a@example.com");
    expect(await ctx.deps.repos.credentials.findByUserId(user.id)).not.toBeNull();
    expect(ctx.deps.repos.auditLogs.all().map((a) => a.action)).toContain("user.registered");
  });

  it("rejects duplicate email and short passwords", async () => {
    await ctx.auth.register({ email: "a@example.com", name: "A", password: PASSWORD });
    await expect(
      ctx.auth.register({ email: "a@example.com", name: "A2", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      ctx.auth.register({ email: "b@example.com", name: "B", password: "short" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("logs in with correct credentials and rejects wrong ones", async () => {
    await ctx.auth.register({ email: "a@example.com", name: "A", password: PASSWORD });
    const result = await ctx.auth.login("a@example.com", PASSWORD);
    expect(result.token).toBeTruthy();
    expect(ctx.deps.repos.auditLogs.all().map((a) => a.action)).toContain("user.logged_in");
    await expect(ctx.auth.login("a@example.com", "wrong")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(ctx.auth.login("nobody@example.com", PASSWORD)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("resolves a valid session and rejects an expired one", async () => {
    await ctx.auth.register({ email: "a@example.com", name: "A", password: PASSWORD });
    const { token, user } = await ctx.auth.login("a@example.com", PASSWORD);
    expect((await ctx.auth.resolveSession(token))?.user.id).toBe(user.id);
    ctx.deps.clock.advanceSeconds(3601);
    expect(await ctx.auth.resolveSession(token)).toBeNull();
  });

  it("logs out by revoking the session with an audit event", async () => {
    await ctx.auth.register({ email: "a@example.com", name: "A", password: PASSWORD });
    const { token } = await ctx.auth.login("a@example.com", PASSWORD);
    await ctx.auth.logout(token);
    expect(await ctx.auth.resolveSession(token)).toBeNull();
    expect(ctx.deps.repos.auditLogs.all().map((a) => a.action)).toContain("session.revoked");
  });
});

describe("OrganizationService", () => {
  it("creates an organization, owner membership, and audit event", async () => {
    const { auth, orgs, deps } = setup();
    const a = await auth.register({ email: "a@example.com", name: "A", password: PASSWORD });
    const { organization, membership } = await orgs.createOrganization(a.id, { name: "Acme Realty" });
    expect(membership.role).toBe("OWNER");
    expect(organization.slug).toBe("acme-realty");
    const logs = await deps.repos.auditLogs.listByOrganization(organization.id);
    expect(logs.map((l) => l.action)).toContain("organization.created");
  });

  it("assigns unique slugs for duplicate names", async () => {
    const { auth, orgs } = setup();
    const a = await auth.register({ email: "a@example.com", name: "A", password: PASSWORD });
    const first = await orgs.createOrganization(a.id, { name: "Acme" });
    const second = await orgs.createOrganization(a.id, { name: "Acme" });
    expect(first.organization.slug).toBe("acme");
    expect(second.organization.slug).toBe("acme-1");
  });
});

describe("tenant isolation", () => {
  it("denies access to an organization the user is not a member of", async () => {
    const { auth, orgs, members } = setup();
    const a = await auth.register({ email: "a@example.com", name: "A", password: PASSWORD });
    const b = await auth.register({ email: "b@example.com", name: "B", password: PASSWORD });
    const { organization: org1 } = await orgs.createOrganization(a.id, { name: "Org One" });
    const { organization: org2 } = await orgs.createOrganization(b.id, { name: "Org Two" });

    // Owner of org1 can read org1 but is denied org2, and vice versa.
    expect((await members.listMembers(a.id, org1.id)).length).toBe(1);
    await expect(members.listMembers(a.id, org2.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(members.listMembers(b.id, org1.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("denies mutations across tenants and by insufficient roles", async () => {
    const { auth, orgs, members } = setup();
    const owner = await auth.register({ email: "o@example.com", name: "O", password: PASSWORD });
    const outsider = await auth.register({ email: "x@example.com", name: "X", password: PASSWORD });
    const { organization } = await orgs.createOrganization(owner.id, { name: "Org" });

    // Outsider cannot invite into an org they don't belong to.
    await expect(
      members.invite(outsider.id, { organizationId: organization.id, email: "z@example.com", role: "CREATOR" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // A CREATOR member lacks member:manage.
    const { token } = await members.invite(owner.id, {
      organizationId: organization.id,
      email: "c@example.com",
      role: "CREATOR",
    });
    const creator = await auth.register({ email: "c@example.com", name: "C", password: PASSWORD });
    await members.acceptInvitation(creator.id, token);
    await expect(
      members.invite(creator.id, { organizationId: organization.id, email: "d@example.com", role: "CREATOR" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("invitations and membership lifecycle", () => {
  it("supports invite → accept and records audit events for every write", async () => {
    const { auth, orgs, members, deps } = setup();
    const owner = await auth.register({ email: "o@example.com", name: "O", password: PASSWORD });
    const { organization } = await orgs.createOrganization(owner.id, { name: "Org" });
    const { token } = await members.invite(owner.id, {
      organizationId: organization.id,
      email: "c@example.com",
      role: "CREATOR",
    });
    const creator = await auth.register({ email: "c@example.com", name: "C", password: PASSWORD });
    const membership = await members.acceptInvitation(creator.id, token);
    expect(membership.role).toBe("CREATOR");

    await members.changeRole(owner.id, organization.id, creator.id, "ADMIN");
    await members.removeMember(owner.id, organization.id, creator.id);
    expect(await deps.repos.memberships.find(organization.id, creator.id)).toBeNull();

    const actions = (await deps.repos.auditLogs.listByOrganization(organization.id)).map((l) => l.action);
    expect(actions).toEqual([
      "organization.created",
      "invitation.created",
      "invitation.accepted",
      "member.role_changed",
      "member.removed",
    ]);
  });

  it("rejects an expired invitation and marks it expired", async () => {
    const { auth, orgs, members, deps } = setup();
    const owner = await auth.register({ email: "o@example.com", name: "O", password: PASSWORD });
    const { organization } = await orgs.createOrganization(owner.id, { name: "Org" });
    const { token, invitation } = await members.invite(owner.id, {
      organizationId: organization.id,
      email: "c@example.com",
      role: "CREATOR",
    });
    deps.clock.advanceSeconds(3601);
    const creator = await auth.register({ email: "c@example.com", name: "C", password: PASSWORD });
    await expect(members.acceptInvitation(creator.id, token)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const stored = await deps.repos.invitations.findByTokenHash(deps.tokens.hash(token));
    expect(stored?.status).toBe("EXPIRED");
    expect(invitation.status).toBe("PENDING");
  });

  it("protects the last owner from removal or demotion", async () => {
    const { auth, orgs, members } = setup();
    const owner = await auth.register({ email: "o@example.com", name: "O", password: PASSWORD });
    const { organization } = await orgs.createOrganization(owner.id, { name: "Org" });
    await expect(
      members.removeMember(owner.id, organization.id, owner.id),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      members.changeRole(owner.id, organization.id, owner.id, "ADMIN"),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
