import { beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "./auth-service";
import { OrganizationService } from "./organization-service";
import { MembershipService } from "./membership-service";
import type { Role } from "./roles";
import { createTestDeps, markEmailVerified, membershipTestOptions, type TestDeps } from "../testing/in-memory";

/**
 * Membership changes made concurrently (Phase 6E, ADR-0059). Each change checks
 * what it read and then writes; two of them in flight together each read before
 * either writes, and only an interleaving every check still holds for may apply.
 */

const PASSWORD = "password-123456";
const LAST_OWNER = "Cannot remove or demote the last owner";
const CHANGED = "This member changed meanwhile; reload and try again";

let deps: TestDeps;
let members: MembershipService;
let seats: number;
let orgId: string;
let ids: Record<"owner" | "coOwner" | "admin" | "creator" | "newcomer" | "other", string>;

beforeEach(async () => {
  deps = createTestDeps();
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  seats = 30;
  members = new MembershipService(deps, membershipTestOptions({ includedSeats: () => Promise.resolve(seats) }));
  const register = async (name: string) =>
    (await auth.register({ email: `${name}@example.com`, name, password: PASSWORD })).id;
  const owner = await register("owner");
  ({ organization: { id: orgId } } = await new OrganizationService(deps).createOrganization(owner, { name: "Org" }));
  ids = {
    owner,
    coOwner: await register("co-owner"),
    admin: await register("admin"),
    creator: await register("creator"),
    newcomer: await register("newcomer"),
    other: await register("other"),
  };
  const roles: [string, Role][] = [
    [ids.coOwner, "OWNER"],
    [ids.admin, "ADMIN"],
    [ids.creator, "CREATOR"],
  ];
  for (const [userId, role] of roles) await deps.repos.memberships.create({ organizationId: orgId, userId, role });
});

async function roleOf(userId: string): Promise<Role | undefined> {
  return (await deps.repos.memberships.find(orgId, userId))?.role;
}

function audited(action: string) {
  return deps.repos.auditLogs.all().filter((entry) => entry.action === action);
}

/** The one fulfilled result and the one refusal's message, in that order. */
function oneEach(results: PromiseSettledResult<unknown>[]): [number, string] {
  const fulfilled = results.findIndex((r) => r.status === "fulfilled");
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  expect(fulfilled).toBeGreaterThanOrEqual(0);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]!.reason).toMatchObject({ code: "VALIDATION_FAILED" });
  return [fulfilled, (rejected[0]!.reason as Error).message];
}

describe("the last OWNER under concurrency", () => {
  it("lets exactly one of two OWNERs demoting each other at once succeed", async () => {
    const results = await Promise.allSettled([
      members.changeRole(ids.owner, orgId, ids.coOwner, "ADMIN"),
      members.changeRole(ids.coOwner, orgId, ids.owner, "ADMIN"),
    ]);
    const [, message] = oneEach(results);
    expect(message).toBe(LAST_OWNER);
    expect([await roleOf(ids.owner), await roleOf(ids.coOwner)].sort()).toEqual(["ADMIN", "OWNER"]);
    expect(audited("member.role_changed")).toHaveLength(1);
  });

  it("lets exactly one of two OWNERs removing each other at once succeed", async () => {
    const results = await Promise.allSettled([
      members.removeMember(ids.owner, orgId, ids.coOwner),
      members.removeMember(ids.coOwner, orgId, ids.owner),
    ]);
    const [, message] = oneEach(results);
    expect(message).toBe(LAST_OWNER);
    expect([await roleOf(ids.owner), await roleOf(ids.coOwner)].filter(Boolean)).toEqual(["OWNER"]);
    expect(audited("member.removed")).toHaveLength(1);
  });
});

describe("a change checked against a role the member no longer holds", () => {
  it("does not let an ADMIN demote a member an OWNER promoted to ADMIN meanwhile", async () => {
    const results = await Promise.allSettled([
      members.changeRole(ids.owner, orgId, ids.creator, "ADMIN"),
      members.changeRole(ids.admin, orgId, ids.creator, "VIEWER"),
    ]);
    expect(oneEach(results)).toEqual([0, CHANGED]);
    expect(await roleOf(ids.creator)).toBe("ADMIN");
    expect(audited("member.role_changed").map((entry) => entry.metadata)).toEqual([
      expect.objectContaining({ previousRole: "CREATOR", role: "ADMIN" }),
    ]);
  });

  it("does not let an ADMIN remove a member an OWNER promoted to ADMIN meanwhile", async () => {
    const results = await Promise.allSettled([
      members.changeRole(ids.owner, orgId, ids.creator, "ADMIN"),
      members.removeMember(ids.admin, orgId, ids.creator),
    ]);
    expect(oneEach(results)).toEqual([0, CHANGED]);
    expect(await roleOf(ids.creator)).toBe("ADMIN");
    expect(audited("member.removed")).toHaveLength(0);
  });
});

describe("acceptance under concurrency", () => {
  async function inviteVerified(userId: string, name: string): Promise<string> {
    markEmailVerified(deps, userId);
    const invited = await members.invite(ids.owner, {
      organizationId: orgId,
      email: `${name}@example.com`,
      role: "CREATOR",
    });
    return invited.token;
  }

  it("makes one membership of one invitation accepted twice at once", async () => {
    const token = await inviteVerified(ids.newcomer, "newcomer");
    const results = await Promise.allSettled([
      members.acceptInvitation(ids.newcomer, token),
      members.acceptInvitation(ids.newcomer, token),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({
      code: "NOT_FOUND",
      message: "Invitation is invalid or already used",
    });
    expect(await roleOf(ids.newcomer)).toBe("CREATOR");
    expect(audited("invitation.accepted")).toHaveLength(1);
  });

  it("makes one member of two acceptances racing for the last seat, leaving the other pending", async () => {
    const tokens = [await inviteVerified(ids.newcomer, "newcomer"), await inviteVerified(ids.other, "other")];
    seats = 5;
    const results = await Promise.allSettled([
      members.acceptInvitation(ids.newcomer, tokens[0]!),
      members.acceptInvitation(ids.other, tokens[1]!),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { reason: "NO_SEAT" },
    });
    expect([await roleOf(ids.newcomer), await roleOf(ids.other)]).toEqual(["CREATOR", undefined]);
    const stored = await deps.repos.invitations.findByTokenHash(deps.tokens.hash(tokens[1]!));
    expect(stored?.status).toBe("PENDING");
    expect(audited("invitation.accepted")).toHaveLength(1);
  });
});
