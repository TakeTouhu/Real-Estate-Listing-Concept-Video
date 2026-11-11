import { beforeEach, describe, expect, it } from "vitest";
import {
  createTestDeps,
  membershipTestOptions,
  type MembershipTestOptions,
  type TestDeps,
} from "../testing/in-memory";
import { AuthService } from "./auth-service";
import { INVITATION_TTL_SECONDS, MembershipService, invitationMessage } from "./membership-service";
import { OrganizationService } from "./organization-service";
import type { Role } from "./roles";
import type { Invitation } from "./types";

/**
 * Inviting within the seats, and cancelling (AT-6a, ADR-0135): every member
 * and every pending invitation that has not expired takes a seat; one pending
 * invitation per address; an expired one frees its address and its seat; the
 * email is built before anything is written and sent after; cancelling is
 * under the role ceiling and audited. Every instant is written out literally.
 */

const iso = (value: string) => new Date(value);
const NOW = iso("2026-11-11T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

let deps: TestDeps;
let options: MembershipTestOptions;
let members: MembershipService;
let seats: number | null;
let orgId: string;
let ids: Record<"OWNER" | "ADMIN" | "CREATOR" | "outsider", string>;

beforeEach(async () => {
  deps = createTestDeps();
  deps.clock.set(NOW);
  seats = 5;
  options = membershipTestOptions({ includedSeats: () => Promise.resolve(seats) });
  members = new MembershipService(deps, options);
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const register = async (name: string) =>
    (await auth.register({ email: `${name}@example.com`, name, password: "password-123456" })).id;
  const owner = await register("owner");
  ({ organization: { id: orgId } } = await new OrganizationService(deps).createOrganization(owner, {
    name: "Tokyo  Homes\n Ltd",
  }));
  ids = { OWNER: owner, ADMIN: await register("admin"), CREATOR: await register("creator"), outsider: "" };
  await deps.repos.memberships.create({ organizationId: orgId, userId: ids.ADMIN, role: "ADMIN" });
  await deps.repos.memberships.create({ organizationId: orgId, userId: ids.CREATOR, role: "CREATOR" });
  ids.outsider = await register("outsider");
});

const invite = (email: string, role: Role = "VIEWER", actor = ids.OWNER) =>
  members.invite(actor, { organizationId: orgId, email, role });

const invitations = () => deps.repos.invitations.listByOrganization(orgId);
const audited = (action: string) => deps.repos.auditLogs.all().filter((entry) => entry.action === action);
const reasonOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "invited",
    (error: { code?: string; details?: { reason?: string } }) => `${error.code}:${error.details?.reason ?? ""}`,
  );

describe("inviting", () => {
  it("keeps the invitation with its audit entry, then mails the invited address its link", async () => {
    const { invitation, token } = await invite("New.Hire@Example.com", "CREATOR");
    expect(invitation).toMatchObject({
      organizationId: orgId,
      email: "new.hire@example.com",
      role: "CREATOR",
      status: "PENDING",
      invitedByUserId: ids.OWNER,
      expiresAt: new Date(NOW.getTime() + HOUR_MS),
      acceptedAt: null,
    });
    expect(await invitations()).toEqual([invitation]);
    expect(audited("invitation.created").map(({ metadata }) => metadata)).toEqual([
      { email: "new.hire@example.com", role: "CREATOR" },
    ]);
    expect(options.email.sent).toHaveLength(1);
    expect(options.email.sent[0]).toMatchObject({ kind: "INVITATION", to: "new.hire@example.com" });
    expect(options.email.sent[0]?.text.split("\n")).toEqual([
      "You are invited to join Tokyo Homes Ltd on VTaVision as a Creator.",
      "",
      "Open the link below to accept. You sign in, or create an account, with this email address.",
      "",
      `invite:${token}`,
      "",
      "The invitation expires in 1 hour.",
      "If you did not expect this invitation, you can ignore this email.",
    ]);
  });

  it("says the product's invitation expires in 7 days", () => {
    expect(INVITATION_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    const text = invitationMessage("a@example.com", "Org", "ADMIN", "https://x.test/", INVITATION_TTL_SECONDS).text;
    expect(text).toContain("as an Admin.");
    expect(text).toContain("The invitation expires in 7 days.");
  });

  it("refuses an address mail cannot reach before anything else, writing and sending nothing", async () => {
    const entries = deps.repos.auditLogs.all().length;
    expect(await reasonOf(invite("not-an-address", "ADMIN", ids.CREATOR))).toBe("VALIDATION_FAILED:INVALID_EMAIL");
    expect(await invitations()).toEqual([]);
    expect(deps.repos.auditLogs.all()).toHaveLength(entries);
    expect(options.email.sent).toEqual([]);
  });

  it("asks the role ceiling before the plan, so a refused member is audited even with no plan", async () => {
    seats = null;
    expect(await reasonOf(invite("a@example.com", "VIEWER", ids.CREATOR))).toBe("FORBIDDEN:");
    expect(await reasonOf(invite("a@example.com", "ADMIN", ids.ADMIN))).toBe("FORBIDDEN:");
    expect(audited("member.role_change_refused")).toHaveLength(2);
    expect(await reasonOf(invite("a@example.com", "VIEWER", ids.outsider))).toBe("FORBIDDEN:");
    expect(audited("member.role_change_refused")).toHaveLength(2);
  });

  it("refuses an organization with no plan, writing and sending nothing", async () => {
    seats = null;
    expect(await reasonOf(invite("a@example.com"))).toBe("VALIDATION_FAILED:NO_PLAN");
    expect(await invitations()).toEqual([]);
    expect(audited("invitation.created")).toEqual([]);
    expect(options.email.sent).toEqual([]);
  });

  it("counts every member and every pending invitation that has not expired against the seats", async () => {
    seats = 5;
    await invite("one@example.com");
    await invite("two@example.com");
    expect(await reasonOf(invite("three@example.com"))).toBe("VALIDATION_FAILED:NO_SEAT");
    expect((await invitations()).map(({ email }) => email)).toEqual(["one@example.com", "two@example.com"]);
    expect(options.email.sent.map(({ to }) => to)).toEqual(["one@example.com", "two@example.com"]);
    seats = 6;
    await invite("three@example.com");
  });

  it("counts no invitation that is accepted, cancelled or expired", async () => {
    seats = 4;
    for (const status of ["ACCEPTED", "REVOKED", "EXPIRED"] as const) {
      deps.repos.invitations.put(stored(`${status.toLowerCase()}@example.com`, { status }));
    }
    deps.repos.invitations.put(stored("lapsed@example.com", { expiresAt: NOW }));
    await invite("fourth@example.com");
    expect(await reasonOf(invite("fifth@example.com"))).toBe("VALIDATION_FAILED:NO_SEAT");
  });

  it("refuses a second invitation of an address while the first is pending, whatever its case", async () => {
    await invite("twice@example.com", "VIEWER");
    expect(await reasonOf(invite("TWICE@example.com", "CREATOR"))).toBe("VALIDATION_FAILED:ALREADY_INVITED");
    expect(await invitations()).toHaveLength(1);
    expect(options.email.sent).toHaveLength(1);
  });

  it("marks an expired invitation EXPIRED when its address is invited again", async () => {
    const first = (await invite("again@example.com")).invitation;
    deps.clock.set(first.expiresAt);
    const second = (await invite("again@example.com")).invitation;
    expect((await invitations()).map(({ id, status }) => [id, status])).toEqual([
      [first.id, "EXPIRED"],
      [second.id, "PENDING"],
    ]);
  });

  it("refuses the address of a member, whatever its case", async () => {
    expect(await reasonOf(invite("Admin@Example.com"))).toBe("VALIDATION_FAILED:ALREADY_MEMBER");
    expect(await reasonOf(invite("outsider@example.com"))).toBe("invited");
  });

  it("writes nothing when the link cannot be built", async () => {
    const failing = new MembershipService(deps, {
      ...options,
      invitationUrl: () => {
        throw new Error("no base URL");
      },
    });
    await expect(failing.invite(ids.OWNER, { organizationId: orgId, email: "a@example.com", role: "VIEWER" }))
      .rejects.toThrow("no base URL");
    expect(await invitations()).toEqual([]);
    expect(audited("invitation.created")).toEqual([]);
  });

  it("keeps the invitation and its audit entry when the email is refused, and says so", async () => {
    options.email.failing = true;
    await expect(invite("a@example.com")).rejects.toThrow("delivery refused");
    expect((await invitations()).map(({ status }) => status)).toEqual(["PENDING"]);
    expect(audited("invitation.created")).toHaveLength(1);
  });
});

describe("cancelling an invitation", () => {
  const cancel = (invitationId: string, actor = ids.OWNER, organizationId = orgId) =>
    members.cancelInvitation(actor, organizationId, invitationId);

  it("revokes it with an audit entry, frees its seat, and the link no longer works", async () => {
    seats = 4;
    const { invitation, token } = await invite("gone@example.com", "MANAGER");
    await cancel(invitation.id, ids.ADMIN);
    expect((await invitations()).map(({ status }) => status)).toEqual(["REVOKED"]);
    expect(audited("invitation.revoked")).toEqual([
      expect.objectContaining({
        organizationId: orgId,
        actorUserId: ids.ADMIN,
        resourceType: "invitation",
        resourceId: invitation.id,
        metadata: { email: "gone@example.com", role: "MANAGER" },
      }),
    ]);
    await invite("next@example.com");
    await expect(members.acceptInvitation(ids.outsider, token)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses and audits a member cancelling past its ceiling or without member.manage", async () => {
    const { invitation } = await invite("boss@example.com", "ADMIN");
    await expect(cancel(invitation.id, ids.ADMIN)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(cancel(invitation.id, ids.CREATOR)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(audited("member.role_change_refused").map(({ metadata }) => metadata)).toEqual([
      { operation: "cancel_invitation", actorRole: "ADMIN", invitedRole: "ADMIN" },
      { operation: "cancel_invitation", actorRole: "CREATOR", invitedRole: null },
    ]);
    expect((await invitations()).map(({ status }) => status)).toEqual(["PENDING"]);
  });

  it("refuses a non-member without writing into the organization's audit trail", async () => {
    const { invitation } = await invite("a@example.com");
    await expect(cancel(invitation.id, ids.outsider)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(audited("member.role_change_refused")).toEqual([]);
  });

  it("finds no invitation of another organization", async () => {
    const { organization: other } = await new OrganizationService(deps).createOrganization(ids.outsider, {
      name: "Other",
    });
    const { invitation } = await invite("a@example.com");
    await expect(cancel(invitation.id, ids.outsider, other.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await invitations()).map(({ status }) => status)).toEqual(["PENDING"]);
  });

  it.each([
    ["accepted", { status: "ACCEPTED" }],
    ["cancelled", { status: "REVOKED" }],
    ["marked expired", { status: "EXPIRED" }],
    ["past its expiry", { expiresAt: NOW }],
  ] as const)("finds no pending invitation once it is %s, and writes nothing", async (_, overrides) => {
    deps.repos.invitations.put(stored("a@example.com", overrides));
    await expect(cancel("inv_a")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(audited("invitation.revoked")).toEqual([]);
  });
});

/** An invitation as it may be stored, `inv_` and its address's local part. */
function stored(email: string, overrides: Partial<Pick<Invitation, "status" | "expiresAt">> = {}): Invitation {
  return {
    id: `inv_${email.split("@")[0]}`,
    organizationId: orgId,
    email,
    role: "VIEWER",
    tokenHash: `hash:${email}`,
    status: "PENDING",
    invitedByUserId: ids.OWNER,
    expiresAt: new Date(NOW.getTime() + HOUR_MS),
    acceptedAt: null,
    createdAt: iso("2026-11-10T00:00:00.000Z"),
    ...overrides,
  };
}
