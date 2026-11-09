import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService, OrganizationService } from "@app/domain";
import { createPrismaIdentityRepositories } from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";

/**
 * Creating an organization against PostgreSQL (AT-2, ADR-0127): the
 * organization, its founding OWNER and `organization.created` commit together
 * or not at all, whichever of the three fails; a slug committed first by an
 * organization whose name gives the same slug rolls the creation back and is
 * answered
 * `SLUG_TAKEN`; and organizations of one name made at once are all made.
 */

const DOMAIN = "org-create.itest";
const PREFIX = "org_itest_org_create_";
const NAME = "Itest Org Create";
const SLUG = "itest-org-create";
const CREATED = "organization.created";

const prisma = new PrismaClient();
const deps = {
  repos: createPrismaIdentityRepositories(prisma),
  clock: new TestClock(new Date("2026-11-09T00:00:00.000Z")),
  ids: { generate: (p: string) => `${p}_itest_org_create_${Math.random().toString(36).slice(2, 12)}` },
  passwords: fakePasswordHasher,
  tokens: fakeTokenService(),
};
const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
const organizations = new OrganizationService(deps);

async function cleanup(): Promise<void> {
  const users = await prisma.user.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orgs = await prisma.organization.findMany({
    where: { OR: [{ id: { startsWith: PREFIX } }, { slug: { startsWith: SLUG } }] },
    select: { id: true },
  });
  const orgIds = orgs.map((o) => o.id);
  await prisma.auditLog.deleteMany({
    where: {
      OR: [{ actorUserId: { in: ids } }, { organizationId: { in: orgIds } }, { resourceId: { startsWith: PREFIX } }],
    },
  });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function user(name: string): Promise<string> {
  return (await auth.register({ email: `${name}@${DOMAIN}`, name, password: "password-123456" })).id;
}

function creation(id: string, ownerUserId: string, overrides: { slug?: string; auditOrganizationId?: string } = {}) {
  // A slug `slugify` could make: lower-case letters, digits and hyphens.
  const slug = overrides.slug ?? `${SLUG}-${id.slice(PREFIX.length).replaceAll("_", "-")}`;
  return {
    organization: { id, name: NAME, slug, status: "ACTIVE" as const },
    ownerUserId,
    audit: {
      organizationId: overrides.auditOrganizationId ?? id,
      actorUserId: ownerUserId,
      action: CREATED,
      resourceType: "organization",
      resourceId: id,
      metadata: { slug },
    },
  };
}

/** What exists of the organization `id`: its row, its members and its audit rows. */
async function traces(id: string) {
  return {
    organization: await prisma.organization.count({ where: { id } }),
    members: await prisma.membership.count({ where: { organizationId: id } }),
    audit: await prisma.auditLog.count({ where: { resourceId: id } }),
  };
}

describe("one transaction", () => {
  it("commits the organization, its OWNER and organization.created together", async () => {
    const owner = await user("owner");
    const { organization, membership } = await organizations.createOrganization(owner, { name: NAME });

    expect(organization).toMatchObject({ name: NAME, slug: SLUG, status: "ACTIVE", mfaRequired: false });
    expect(membership).toMatchObject({ organizationId: organization.id, userId: owner, role: "OWNER" });
    expect(await prisma.membership.findMany({ where: { organizationId: organization.id } })).toEqual([
      expect.objectContaining({ userId: owner, role: "OWNER" }),
    ]);
    expect(await prisma.auditLog.findMany({ where: { organizationId: organization.id } })).toEqual([
      expect.objectContaining({
        actorUserId: owner,
        action: CREATED,
        resourceType: "organization",
        resourceId: organization.id,
        metadata: { slug: SLUG },
      }),
    ]);
  });

  it("leaves no organization and no audit row when the OWNER cannot be written", async () => {
    const id = `${PREFIX}no_owner`;
    // The founding member names no user: the membership's foreign key refuses it.
    const input = creation(id, "usr_itest_org_create_missing");
    await expect(deps.repos.organizations.createWithOwner(input)).rejects.toMatchObject({
      code: "P2003",
      meta: { modelName: "Membership" },
    });
    expect(await traces(id)).toEqual({ organization: 0, members: 0, audit: 0 });
  });

  it("leaves no organization and no OWNER when the audit row cannot be written", async () => {
    const owner = await user("owner");
    const id = `${PREFIX}no_audit`;
    // The entry names an organization that does not exist: its foreign key refuses it.
    const input = creation(id, owner, { auditOrganizationId: `${PREFIX}missing` });
    await expect(deps.repos.organizations.createWithOwner(input)).rejects.toMatchObject({
      code: "P2003",
      meta: { modelName: "AuditLog" },
    });
    expect(await traces(id)).toEqual({ organization: 0, members: 0, audit: 0 });
  });
});

describe("a slug committed first", () => {
  it("writes nothing and answers SLUG_TAKEN", async () => {
    const owner = await user("owner");
    const first = `${PREFIX}first`;
    const second = `${PREFIX}second`;
    const create = (id: string) => deps.repos.organizations.createWithOwner(creation(id, owner, { slug: SLUG }));
    await expect(create(first)).resolves.toMatchObject({ outcome: "CREATED" });
    await expect(create(second)).resolves.toEqual({ outcome: "SLUG_TAKEN" });
    expect(await traces(second)).toEqual({ organization: 0, members: 0, audit: 0 });
    expect(await traces(first)).toEqual({ organization: 1, members: 1, audit: 1 });
  });

  it("is not mistaken for another conflict: a taken id still fails", async () => {
    const owner = await user("owner");
    const id = `${PREFIX}same_id`;
    await deps.repos.organizations.createWithOwner(creation(id, owner, { slug: `${SLUG}-a` }));
    await expect(
      deps.repos.organizations.createWithOwner(creation(id, owner, { slug: `${SLUG}-b` })),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await traces(id)).toEqual({ organization: 1, members: 1, audit: 1 });
  });

  it("is looked for again when a rival commits it between the search and the write", async () => {
    const owner = await user("owner");
    const repo = deps.repos.organizations;
    const real = repo.createWithOwner.bind(repo);
    let rival = true;
    const createWithOwner = vi.spyOn(repo, "createWithOwner").mockImplementation(async (input) => {
      if (rival) {
        rival = false;
        // Another organization takes the slug just found, before this write.
        await prisma.organization.create({ data: { id: `${PREFIX}rival`, name: NAME, slug: input.organization.slug } });
      }
      return real(input);
    });
    try {
      const { organization } = await organizations.createOrganization(owner, { name: NAME });
      expect(organization.slug).toBe(`${SLUG}-1`);
      expect(createWithOwner).toHaveBeenCalledTimes(2);
      const [refused] = createWithOwner.mock.calls[0] ?? [];
      expect(refused?.organization.slug).toBe(SLUG);
      expect(await traces(refused?.organization.id ?? "")).toEqual({ organization: 0, members: 0, audit: 0 });
      expect(await traces(organization.id)).toEqual({ organization: 1, members: 1, audit: 1 });
    } finally {
      createWithOwner.mockRestore();
    }
  });

  it("organizations of one name made at once are all made", async () => {
    const owner = await user("owner");
    const made = await Promise.all([1, 2, 3].map(() => organizations.createOrganization(owner, { name: NAME })));
    expect(made.map(({ organization }) => organization.slug).sort()).toEqual([SLUG, `${SLUG}-1`, `${SLUG}-2`]);
    for (const { organization } of made) {
      expect(await traces(organization.id)).toEqual({ organization: 1, members: 1, audit: 1 });
    }
  });
});
