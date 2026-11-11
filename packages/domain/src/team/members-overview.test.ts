import { beforeEach, describe, expect, it } from "vitest";
import type { CustomerPlanKey } from "../pricing/customer-plan-catalog";
import { AuthService } from "../identity/auth-service";
import { OrganizationService } from "../identity/organization-service";
import { PermissionGrantService } from "../identity/permission-grant-service";
import type { Role } from "../identity/roles";
import type { Invitation, InvitationStatus } from "../identity/types";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { InMemoryUnitsReader } from "../testing/in-memory-units";
import { MembersOverviewService } from "./members-overview";
import { holdsSeat, includedSeats } from "./seats";

/**
 * The members page's reading (AT-5, ADR-0134): `member.view` to see it; the
 * members by role with their accounts; only invitations that can still be
 * accepted; seats from the plan's included users, taken by members and those
 * invitations; and nothing written. Every instant is written out literally.
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

async function invite(
  email: string,
  overrides: Partial<Pick<Invitation, "organizationId" | "role" | "status" | "expiresAt">> & { createdAt?: Date } = {},
): Promise<void> {
  const { createdAt = iso("2026-11-09T00:00:00.000Z"), ...rest } = overrides;
  const organizationId = rest.organizationId ?? orgId;
  deps.clock.set(createdAt);
  await deps.repos.invitations.create(
    {
      id: deps.ids.generate("inv"),
      organizationId,
      email,
      role: "CREATOR",
      tokenHash: `hash:${email}`,
      status: "PENDING",
      invitedByUserId: ids.OWNER,
      expiresAt: iso("2026-11-16T00:00:00.000Z"),
      acceptedAt: null,
      ...rest,
    },
    {
      organizationId,
      actorUserId: ids.OWNER,
      action: "invitation.created",
      resourceType: "invitation",
      resourceId: email,
      metadata: {},
    },
  );
  deps.clock.set(NOW);
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

  it.each(["OWNER", "ADMIN", "MANAGER", "BILLING"] as const)(
    "lists a %s the members by role, then the longest-standing first",
    async (who) => {
      const { members } = await service.overview(ids[who], orgId);
      expect(members.map(({ role }) => role)).toEqual(["OWNER", "ADMIN", "MANAGER", "CREATOR", "VIEWER", "BILLING"]);
      expect(members.filter(({ you }) => you).map(({ role }) => role)).toEqual([who]);
      expect(members[1]).toEqual({
        name: "admin san",
        email: "admin@example.com",
        role: "ADMIN",
        joinedAt: iso("2026-11-05T00:00:00.000Z"),
        you: who === "ADMIN",
      });
    },
  );

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

  it("shows only invitations that can still be accepted, oldest first, and never another organization's", async () => {
    await invite("later@example.com", { role: "VIEWER", createdAt: iso("2026-11-09T06:00:00.000Z") });
    await invite("first@example.com", { role: "MANAGER", createdAt: iso("2026-11-08T00:00:00.000Z") });
    await invite("lapsed@example.com", { expiresAt: NOW });
    for (const status of ["ACCEPTED", "REVOKED", "EXPIRED"] satisfies InvitationStatus[]) {
      await invite(`${status.toLowerCase()}@example.com`, { status });
    }
    const { organization: other } = await new OrganizationService(deps).createOrganization(ids.outsider, {
      name: "Other",
    });
    await invite("elsewhere@example.com", { organizationId: other.id });

    const { invitations } = await service.overview(ids.MANAGER, orgId);
    expect(invitations).toEqual([
      {
        email: "first@example.com",
        role: "MANAGER",
        invitedAt: iso("2026-11-08T00:00:00.000Z"),
        expiresAt: iso("2026-11-16T00:00:00.000Z"),
      },
      {
        email: "later@example.com",
        role: "VIEWER",
        invitedAt: iso("2026-11-09T06:00:00.000Z"),
        expiresAt: iso("2026-11-16T00:00:00.000Z"),
      },
    ]);
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

  it("counts every member and every invitation that can still be accepted, even beyond the seats", async () => {
    subscribe("premium");
    await invite("one@example.com");
    await invite("two@example.com");
    await invite("lapsed@example.com", { expiresAt: NOW });
    await invite("revoked@example.com", { status: "REVOKED" });
    expect((await service.overview(ids.OWNER, orgId)).seats).toEqual({ included: 10, taken: 8 });
    subscribe("standard");
    expect((await service.overview(ids.OWNER, orgId)).seats).toEqual({ included: 3, taken: 8 });
  });

  it("writes nothing: no audit entry, and an invitation past its expiry stays pending", async () => {
    subscribe("premium");
    await invite("lapsed@example.com", { expiresAt: NOW });
    const audits = (await deps.repos.auditLogs.listByOrganization(orgId)).length;
    await service.overview(ids.OWNER, orgId);
    await service.overview(ids.VIEWER, orgId).catch(() => undefined);
    expect(await deps.repos.auditLogs.listByOrganization(orgId)).toHaveLength(audits);
    expect((await deps.repos.invitations.findPending(orgId, "lapsed@example.com"))?.status).toBe("PENDING");
  });
});

describe("seats", () => {
  it("are none without a plan", () => {
    expect(includedSeats(null)).toBeNull();
  });

  it("are not held by an invitation from the instant it expires", () => {
    const expiresAt = iso("2026-11-16T00:00:00.000Z");
    expect(holdsSeat({ status: "PENDING", expiresAt }, iso("2026-11-15T23:59:59.999Z"))).toBe(true);
    expect(holdsSeat({ status: "PENDING", expiresAt }, expiresAt)).toBe(false);
    expect(holdsSeat({ status: "ACCEPTED", expiresAt }, iso("2026-11-10T00:00:00.000Z"))).toBe(false);
  });
});
