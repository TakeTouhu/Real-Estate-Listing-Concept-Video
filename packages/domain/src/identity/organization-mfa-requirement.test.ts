import { beforeEach, describe, expect, it, vi } from "vitest";
import { isMfaRequired } from "../mfa/requirement";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { AuthService } from "./auth-service";
import { OrganizationService } from "./organization-service";
import { PermissionGrantService } from "./permission-grant-service";
import type { Role } from "./roles";

/**
 * An organization's "require MFA of every member" (MFA-4, ADR-0065 Decision
 * 18): changed only by an `OWNER` or `ADMIN`, by role; refusals audited; the
 * change and its audit written together, and only if nothing moved meanwhile.
 */

const CHANGED = "organization.mfa_requirement_changed";
const REFUSED = "organization.mfa_requirement_refused";
const STALE = "The MFA requirement or your role changed meanwhile; reload and try again";

let deps: TestDeps;
let organizations: OrganizationService;
let orgId: string;
let ids: Record<Role | "outsider", string>;

beforeEach(async () => {
  deps = createTestDeps();
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  organizations = new OrganizationService(deps);
  const register = async (name: string) =>
    (await auth.register({ email: `${name}@example.com`, name, password: "password-123456" })).id;
  const owner = await register("owner");
  ({ organization: { id: orgId } } = await organizations.createOrganization(owner, { name: "Org" }));
  ids = {
    OWNER: owner,
    ADMIN: await register("admin"),
    MANAGER: await register("manager"),
    CREATOR: await register("creator"),
    VIEWER: await register("viewer"),
    BILLING: await register("billing"),
    outsider: await register("outsider"),
  };
  for (const role of ["ADMIN", "MANAGER", "CREATOR", "VIEWER", "BILLING"] as const) {
    await deps.repos.memberships.create({ organizationId: orgId, userId: ids[role], role });
  }
});

function audited(action: string) {
  return deps.repos.auditLogs.all().filter((entry) => entry.action === action);
}

async function required(): Promise<boolean | undefined> {
  return (await deps.repos.organizations.findById(orgId))?.mfaRequired;
}

describe("an organization's MFA requirement", () => {
  it("is off for a new organization", async () => {
    expect(await required()).toBe(false);
  });

  it.each(["OWNER", "ADMIN"] as const)("may be turned on and off by an %s, each change audited", async (role) => {
    const on = await organizations.setMfaRequirement(ids[role], orgId, true);
    expect(on).toMatchObject({ changed: true, organization: { id: orgId, mfaRequired: true } });
    expect(await required()).toBe(true);
    const off = await organizations.setMfaRequirement(ids[role], orgId, false);
    expect(off).toMatchObject({ changed: true, organization: { mfaRequired: false } });
    expect(await required()).toBe(false);
    expect(audited(CHANGED).map((entry) => entry.metadata)).toEqual([
      { actorRole: role, required: true },
      { actorRole: role, required: false },
    ]);
    expect(audited(CHANGED)[0]).toMatchObject({
      organizationId: orgId,
      actorUserId: ids[role],
      resourceType: "organization",
      resourceId: orgId,
    });
    expect(audited(REFUSED)).toHaveLength(0);
  });

  it("writes nothing when it would change nothing", async () => {
    const result = await organizations.setMfaRequirement(ids.OWNER, orgId, false);
    expect(result).toMatchObject({ changed: false, organization: { mfaRequired: false } });
    await organizations.setMfaRequirement(ids.OWNER, orgId, true);
    expect(await organizations.setMfaRequirement(ids.ADMIN, orgId, true)).toMatchObject({ changed: false });
    expect(audited(CHANGED)).toHaveLength(1);
  });

  it.each(["MANAGER", "CREATOR", "VIEWER", "BILLING"] as const)(
    "is refused to a %s, and the refusal audited",
    async (role) => {
      await expect(organizations.setMfaRequirement(ids[role], orgId, true)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: `Role ${role} may not change whether MFA is required`,
      });
      expect(await required()).toBe(false);
      expect(audited(CHANGED)).toHaveLength(0);
      expect(audited(REFUSED)).toEqual([
        expect.objectContaining({
          organizationId: orgId,
          actorUserId: ids[role],
          resourceType: "organization",
          resourceId: orgId,
          metadata: { actorRole: role, required: true },
        }),
      ]);
    },
  );

  it("is refused to a MANAGER granted organization.manage: it goes by role", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.MANAGER, "organization.manage");
    await expect(organizations.setMfaRequirement(ids.MANAGER, orgId, true)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await required()).toBe(false);
    expect(audited(REFUSED)).toHaveLength(1);
  });

  it("is refused to a non-member, with nothing about the requirement audited", async () => {
    await expect(organizations.setMfaRequirement(ids.outsider, orgId, true)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "You do not have access to this organization",
    });
    expect(await required()).toBe(false);
    expect([...audited(CHANGED), ...audited(REFUSED)]).toHaveLength(0);
  });

  it("refuses a change when the requirement moved after it was read", async () => {
    const organization = await deps.repos.organizations.findById(orgId);
    await organizations.setMfaRequirement(ids.ADMIN, orgId, true);
    vi.spyOn(deps.repos.organizations, "findById").mockResolvedValueOnce(organization);
    await expect(organizations.setMfaRequirement(ids.OWNER, orgId, true)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: STALE,
    });
    expect(await required()).toBe(true);
    expect(audited(CHANGED)).toHaveLength(1);
  });

  it("refuses a change when its maker was demoted after the role check", async () => {
    const findById = deps.repos.organizations.findById.bind(deps.repos.organizations);
    vi.spyOn(deps.repos.organizations, "findById").mockImplementationOnce(async (id) => {
      await deps.repos.memberships.changeRole(orgId, ids.ADMIN, "ADMIN", "MANAGER", {
        organizationId: orgId,
        actorUserId: ids.OWNER,
        action: "member.role_changed",
        resourceType: "membership",
        resourceId: ids.ADMIN,
        metadata: {},
      });
      return findById(id);
    });
    await expect(organizations.setMfaRequirement(ids.ADMIN, orgId, true)).rejects.toMatchObject({ message: STALE });
    expect(await required()).toBe(false);
    expect(audited(CHANGED)).toHaveLength(0);
  });

  it("lets only one of two opposite changes made at once apply", async () => {
    await organizations.setMfaRequirement(ids.OWNER, orgId, true);
    const results = await Promise.allSettled([
      organizations.setMfaRequirement(ids.OWNER, orgId, false),
      organizations.setMfaRequirement(ids.ADMIN, orgId, false),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await required()).toBe(false);
    expect(audited(CHANGED)).toHaveLength(2);
  });

  it("makes MFA mandatory for every member, and stops when it is turned off", async () => {
    const members = ["MANAGER", "CREATOR", "VIEWER"] as const;
    for (const role of members) expect(await isMfaRequired(deps, ids[role])).toBe(false);
    await organizations.setMfaRequirement(ids.ADMIN, orgId, true);
    for (const role of members) expect(await isMfaRequired(deps, ids[role])).toBe(true);
    expect(await isMfaRequired(deps, ids.outsider)).toBe(false);
    await organizations.setMfaRequirement(ids.ADMIN, orgId, false);
    for (const role of members) expect(await isMfaRequired(deps, ids[role])).toBe(false);
  });

  it("shows in the organizations a member lists", async () => {
    await organizations.setMfaRequirement(ids.OWNER, orgId, true);
    const [listed] = await organizations.listForUser(ids.VIEWER);
    expect(listed?.organization.mfaRequired).toBe(true);
  });
});
