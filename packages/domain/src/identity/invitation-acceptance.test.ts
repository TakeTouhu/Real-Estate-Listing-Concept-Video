import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDeps, markEmailVerified, membershipTestOptions, type TestDeps } from "../testing/in-memory";
import { AuthService } from "./auth-service";
import { MembershipService } from "./membership-service";
import { OrganizationService } from "./organization-service";
import type { Role } from "./roles";
import type { Invitation } from "./types";

/**
 * Accepting an invitation (AT-7a, ADR-0137): only the account with the
 * invited address, once verified, accepts; an expired invitation is refused
 * and marked; who accepts is asked before the inviter's ceiling and the plan;
 * acceptance needs a seat counting members only; a refusal writes nothing.
 * Every instant is written out literally.
 */

const iso = (value: string) => new Date(value);
const NOW = iso("2026-11-11T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

let deps: TestDeps;
let members: MembershipService;
let seats: number | null;
let orgId: string;
let ids: Record<"OWNER" | "ADMIN" | "CREATOR" | "outsider", string>;
let register: (name: string, verified?: boolean) => Promise<string>;

beforeEach(async () => {
  deps = createTestDeps();
  deps.clock.set(NOW);
  seats = 5;
  members = new MembershipService(deps, membershipTestOptions({ includedSeats: () => Promise.resolve(seats) }));
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  register = async (name: string, verified = true) => {
    const { id } = await auth.register({ email: `${name}@example.com`, name, password: "password-123456" });
    if (verified) markEmailVerified(deps, id);
    return id;
  };
  const owner = await register("owner");
  ({ organization: { id: orgId } } = await new OrganizationService(deps).createOrganization(owner, { name: "Org" }));
  ids = { OWNER: owner, ADMIN: await register("admin"), CREATOR: await register("creator"), outsider: "" };
  await deps.repos.memberships.create({ organizationId: orgId, userId: ids.ADMIN, role: "ADMIN" });
  await deps.repos.memberships.create({ organizationId: orgId, userId: ids.CREATOR, role: "CREATOR" });
  ids.outsider = await register("outsider");
});

async function invite(email: string, role: Role = "VIEWER", actor = ids.OWNER): Promise<string> {
  return (await members.invite(actor, { organizationId: orgId, email, role })).token;
}

const accept = (userId: string, token: string) => members.acceptInvitation(userId, token);
const roleOf = async (userId: string) => (await deps.repos.memberships.find(orgId, userId))?.role;
const statuses = async () => (await deps.repos.invitations.listByOrganization(orgId)).map(({ status }) => status);
const audited = (action: string) => deps.repos.auditLogs.all().filter((entry) => entry.action === action);
const reasonOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "accepted",
    (error: { code?: string; details?: { reason?: string } }) => `${error.code}:${error.details?.reason ?? ""}`,
  );

/** Nothing was written: no membership for `userId`, the invitations as they were, no audit entry. */
async function expectNothingWritten(userId: string, before: { statuses: string[]; entries: number }) {
  expect(await roleOf(userId)).toBeUndefined();
  expect(await statuses()).toEqual(before.statuses);
  expect(deps.repos.auditLogs.all()).toHaveLength(before.entries);
}

const snapshot = async () => ({ statuses: await statuses(), entries: deps.repos.auditLogs.all().length });

describe("who accepts", () => {
  it("joins the account with the invited address, verified, with the invited role, and audits it", async () => {
    const token = await invite("New.Hire@Example.com", "CREATOR");
    const newHire = await register("new.hire");
    expect(await accept(newHire, token)).toMatchObject({ organizationId: orgId, userId: newHire, role: "CREATOR" });
    const [invitation] = await deps.repos.invitations.listByOrganization(orgId);
    expect(invitation).toMatchObject({ status: "ACCEPTED", acceptedAt: NOW });
    expect(audited("invitation.accepted")).toEqual([
      expect.objectContaining({
        organizationId: orgId,
        actorUserId: newHire,
        resourceType: "membership",
        resourceId: `${orgId}:${newHire}`,
        metadata: { role: "CREATOR", scope: "OWN" },
      }),
    ]);
  });

  it("refuses any other account, verified or a member already, writing nothing", async () => {
    const token = await invite("invitee@example.com");
    const before = await snapshot();
    expect(await reasonOf(accept(ids.outsider, token))).toBe("VALIDATION_FAILED:WRONG_ACCOUNT");
    expect(await reasonOf(accept(ids.ADMIN, token))).toBe("VALIDATION_FAILED:WRONG_ACCOUNT");
    await expectNothingWritten(ids.outsider, before);
    expect(await roleOf(ids.ADMIN)).toBe("ADMIN");
  });

  it("refuses the invited address until it is verified, writing nothing, then accepts", async () => {
    const token = await invite("invitee@example.com");
    const invitee = await register("invitee", false);
    const before = await snapshot();
    expect(await reasonOf(accept(invitee, token))).toBe("VALIDATION_FAILED:EMAIL_NOT_VERIFIED");
    await expectNothingWritten(invitee, before);
    markEmailVerified(deps, invitee);
    expect(await reasonOf(accept(invitee, token))).toBe("accepted");
    expect(await roleOf(invitee)).toBe("VIEWER");
  });

  it("refuses an account that is gone or disabled, writing nothing", async () => {
    const token = await invite("invitee@example.com");
    const invitee = await register("invitee");
    const user = deps.repos.users.peek(invitee)!;
    deps.repos.users.put({ ...user, status: "DISABLED" });
    const before = await snapshot();
    await expect(accept(invitee, token)).rejects.toMatchObject({ code: "NOT_FOUND", message: "Account not found" });
    await expect(accept("usr_gone", token)).rejects.toMatchObject({ code: "NOT_FOUND", message: "Account not found" });
    await expectNothingWritten(invitee, before);
  });

  it("refuses a member of the organization whose address was invited", async () => {
    deps.repos.invitations.put(stored("creator@example.com"));
    expect(await reasonOf(accept(ids.CREATOR, "creator"))).toBe("VALIDATION_FAILED:ALREADY_MEMBER");
    expect(await roleOf(ids.CREATOR)).toBe("CREATOR");
    expect(await statuses()).toEqual(["PENDING"]);
  });

  it("asks who accepts before the inviter's ceiling, so only the invitee's refusal is audited", async () => {
    const token = await invite("invitee@example.com", "MANAGER", ids.ADMIN);
    await members.changeRole(ids.OWNER, orgId, ids.ADMIN, "VIEWER");
    const invitee = await register("invitee", false);
    expect(await reasonOf(accept(ids.outsider, token))).toBe("VALIDATION_FAILED:WRONG_ACCOUNT");
    expect(await reasonOf(accept(invitee, token))).toBe("VALIDATION_FAILED:EMAIL_NOT_VERIFIED");
    expect(audited("member.role_change_refused")).toEqual([]);
    markEmailVerified(deps, invitee);
    expect(await reasonOf(accept(invitee, token))).toBe("FORBIDDEN:");
    expect(audited("member.role_change_refused").map(({ actorUserId, metadata }) => [actorUserId, metadata])).toEqual([
      [
        invitee,
        { operation: "accept_invitation", requestedRole: "MANAGER", invitedByUserId: ids.ADMIN, inviterRole: "VIEWER" },
      ],
    ]);
  });
});

describe("the invitation", () => {
  it("is refused once expired, before who accepts is asked, and marked EXPIRED", async () => {
    const token = await invite("invitee@example.com");
    deps.clock.set(new Date(NOW.getTime() + HOUR_MS));
    expect(await reasonOf(accept(ids.outsider, token))).toBe("VALIDATION_FAILED:EXPIRED");
    expect(await statuses()).toEqual(["EXPIRED"]);
    expect(audited("invitation.accepted")).toEqual([]);
  });

  it("is accepted until the last millisecond before it expires", async () => {
    const token = await invite("invitee@example.com");
    const invitee = await register("invitee");
    deps.clock.set(new Date(NOW.getTime() + HOUR_MS - 1));
    expect(await reasonOf(accept(invitee, token))).toBe("accepted");
  });

  it.each([
    ["accepted", "ACCEPTED"],
    ["cancelled", "REVOKED"],
    ["marked expired", "EXPIRED"],
  ] as const)("is not found once %s, nor for a token of none", async (_, status) => {
    const invitee = await register("invitee");
    deps.repos.invitations.put(stored("invitee@example.com", { status }));
    for (const token of ["invitee", "unknown"]) {
      await expect(accept(invitee, token)).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Invitation is invalid or already used",
      });
    }
    expect(await roleOf(invitee)).toBeUndefined();
  });
});

describe("the seats", () => {
  it("are none without a plan, so nothing is written", async () => {
    const token = await invite("invitee@example.com");
    const invitee = await register("invitee");
    seats = null;
    const before = await snapshot();
    expect(await reasonOf(accept(invitee, token))).toBe("VALIDATION_FAILED:NO_PLAN");
    await expectNothingWritten(invitee, before);
  });

  it("are asked after the inviter's ceiling", async () => {
    const token = await invite("invitee@example.com", "VIEWER", ids.ADMIN);
    await members.removeMember(ids.OWNER, orgId, ids.ADMIN);
    seats = null;
    expect(await reasonOf(accept(await register("invitee"), token))).toBe("FORBIDDEN:");
  });

  it("count the members only, so every invitation made within the seats is accepted", async () => {
    const tokens = [await invite("one@example.com"), await invite("two@example.com")];
    await expect(invite("three@example.com")).rejects.toMatchObject({ details: { reason: "NO_SEAT" } });
    expect(await reasonOf(accept(await register("one"), tokens[0]!))).toBe("accepted");
    expect(await reasonOf(accept(await register("two"), tokens[1]!))).toBe("accepted");
    expect((await deps.repos.memberships.listByOrganization(orgId)).length).toBe(5);
  });

  it("refuse an acceptance once the members take every seat, leaving its invitation pending", async () => {
    const tokens = [await invite("one@example.com"), await invite("two@example.com")];
    const [one, two] = [await register("one"), await register("two")];
    seats = 4;
    expect(await reasonOf(accept(one, tokens[0]!))).toBe("accepted");
    const before = await snapshot();
    expect(await reasonOf(accept(two, tokens[1]!))).toBe("VALIDATION_FAILED:NO_SEAT");
    await expectNothingWritten(two, before);
    expect(await statuses()).toEqual(["ACCEPTED", "PENDING"]);
    seats = 5;
    expect(await reasonOf(accept(two, tokens[1]!))).toBe("accepted");
  });
});

it("takes back the membership and the acceptance when its audit entry cannot be kept", async () => {
  const token = await invite("invitee@example.com");
  const invitee = await register("invitee");
  vi.spyOn(deps.repos.auditLogs, "append").mockRejectedValueOnce(new Error("audit down"));
  await expect(accept(invitee, token)).rejects.toThrow("audit down");
  expect(await roleOf(invitee)).toBeUndefined();
  expect(await deps.repos.invitations.listByOrganization(orgId)).toEqual([
    expect.objectContaining({ status: "PENDING", acceptedAt: null }),
  ]);
});

/** An invitation as it may be stored, `inv_` and its address's local part, whose token is that local part. */
function stored(
  email: string,
  overrides: Partial<Pick<Invitation, "status" | "expiresAt" | "role" | "invitedByUserId">> = {},
): Invitation {
  const local = email.split("@")[0]!;
  return {
    id: `inv_${local}`,
    organizationId: orgId,
    email,
    role: "VIEWER",
    tokenHash: deps.tokens.hash(local),
    status: "PENDING",
    invitedByUserId: ids.OWNER,
    expiresAt: new Date(NOW.getTime() + HOUR_MS),
    acceptedAt: null,
    createdAt: iso("2026-11-10T00:00:00.000Z"),
    ...overrides,
  };
}
