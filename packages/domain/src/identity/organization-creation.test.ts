import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuthService } from "./auth-service";
import { ORGANIZATION_SLUG_ATTEMPTS, OrganizationService } from "./organization-service";
import { createTestDeps, type TestDeps } from "../testing/in-memory";

/**
 * Creating an organization (AT-2, ADR-0127): the organization, its founding
 * OWNER and its audit entry are made by one repository call, which writes all
 * three or none; a slug taken meanwhile is looked for again, a bounded number
 * of times; and nothing else in the product creates an organization.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

async function setup(): Promise<{ deps: TestDeps; orgs: OrganizationService; owner: string }> {
  const deps = createTestDeps();
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const owner = (await auth.register({ email: "owner@example.test", name: "Owner", password: "password-123456" })).id;
  return { deps, orgs: new OrganizationService(deps), owner };
}

function organizationAudit(deps: TestDeps) {
  return deps.repos.auditLogs.all().filter((entry) => entry.action !== "user.registered");
}

describe("creating an organization", () => {
  it("makes the organization, its OWNER and one audit entry, all naming the same organization", async () => {
    const { deps, orgs, owner } = await setup();
    const { organization, membership } = await orgs.createOrganization(owner, { name: "  Acme Realty  " });

    expect(organization).toMatchObject({ name: "Acme Realty", slug: "acme-realty", status: "ACTIVE" });
    expect(organization.mfaRequired).toBe(false);
    expect(membership).toMatchObject({ organizationId: organization.id, userId: owner, role: "OWNER" });
    expect(await deps.repos.organizations.findById(organization.id)).toEqual(organization);
    expect(await deps.repos.memberships.listByOrganization(organization.id)).toEqual([membership]);
    expect(organizationAudit(deps)).toEqual([
      expect.objectContaining({
        organizationId: organization.id,
        actorUserId: owner,
        action: "organization.created",
        resourceType: "organization",
        resourceId: organization.id,
        metadata: { slug: "acme-realty" },
      }),
    ]);
  });

  it("refuses a blank name and writes nothing", async () => {
    const { deps, orgs, owner } = await setup();
    const createWithOwner = vi.spyOn(deps.repos.organizations, "createWithOwner");
    await expect(orgs.createOrganization(owner, { name: " \t " })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Organization name is required",
    });
    expect(createWithOwner).not.toHaveBeenCalled();
    expect(await deps.repos.memberships.listByUser(owner)).toEqual([]);
    expect(organizationAudit(deps)).toEqual([]);
  });

  it("takes the next free slug for a name already in use", async () => {
    const { orgs, owner } = await setup();
    const slugs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      slugs.push((await orgs.createOrganization(owner, { name: "Acme" })).organization.slug);
    }
    expect(slugs).toEqual(["acme", "acme-1", "acme-2"]);
  });
});

describe("a slug taken meanwhile", () => {
  it("is looked for again: two organizations of one name made at once both get made", async () => {
    const { deps, orgs, owner } = await setup();
    const createWithOwner = vi.spyOn(deps.repos.organizations, "createWithOwner");
    // Both find "acme" free before either writes, so the second is refused once.
    const made = await Promise.all([
      orgs.createOrganization(owner, { name: "Acme" }),
      orgs.createOrganization(owner, { name: "Acme" }),
    ]);
    expect(made.map(({ organization }) => organization.slug).sort()).toEqual(["acme", "acme-1"]);
    expect(createWithOwner).toHaveBeenCalledTimes(3);
    expect(await deps.repos.memberships.listByUser(owner)).toHaveLength(2);
    expect(organizationAudit(deps).map(({ metadata }) => metadata).sort()).toEqual([
      { slug: "acme" },
      { slug: "acme-1" },
    ]);
  });

  it(`is looked for afresh on each of ${ORGANIZATION_SLUG_ATTEMPTS} attempts, each its own organization`, async () => {
    const { deps, orgs, owner } = await setup();
    const repo = deps.repos.organizations;
    const real = repo.createWithOwner.bind(repo);
    const tried: { id: string; slug: string; audited: unknown }[] = [];
    let refusals = ORGANIZATION_SLUG_ATTEMPTS - 1;
    // Another organization of the same name takes each slug first, until the last attempt.
    vi.spyOn(repo, "createWithOwner").mockImplementation(async (input) => {
      tried.push({ id: input.organization.id, slug: input.organization.slug, audited: input.audit.organizationId });
      if (refusals === 0) return real(input);
      refusals -= 1;
      await repo.create({ ...input.organization, id: `org_rival_${refusals}` });
      return { outcome: "SLUG_TAKEN" };
    });

    const { organization } = await orgs.createOrganization(owner, { name: "Acme" });

    expect(tried.map(({ slug }) => slug)).toEqual(["acme", "acme-1", "acme-2"]);
    expect(new Set(tried.map(({ id }) => id)).size).toBe(ORGANIZATION_SLUG_ATTEMPTS);
    for (const { id, audited } of tried) expect(audited).toBe(id);
    expect(organization).toMatchObject({ id: tried.at(-1)?.id, slug: "acme-2" });
  });

  it(`gives up after ${ORGANIZATION_SLUG_ATTEMPTS} attempts, having written nothing`, async () => {
    const { deps, orgs, owner } = await setup();
    const createWithOwner = vi
      .spyOn(deps.repos.organizations, "createWithOwner")
      .mockResolvedValue({ outcome: "SLUG_TAKEN" });
    await expect(orgs.createOrganization(owner, { name: "Acme" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Other organizations of the same name were being created at the same moment; try again",
    });
    expect(createWithOwner).toHaveBeenCalledTimes(ORGANIZATION_SLUG_ATTEMPTS);
    expect(await deps.repos.memberships.listByUser(owner)).toEqual([]);
    expect(organizationAudit(deps)).toEqual([]);
  });
});

describe("the in-memory repository", () => {
  it("refuses a taken slug as the unique key does, writing nothing", async () => {
    const { deps, owner } = await setup();
    await deps.repos.organizations.create({ id: "org_first", name: "Acme", slug: "acme", status: "ACTIVE" });
    const outcome = await deps.repos.organizations.createWithOwner({
      organization: { id: "org_second", name: "Acme", slug: "acme", status: "ACTIVE" },
      ownerUserId: owner,
      audit: {
        organizationId: "org_second",
        actorUserId: owner,
        action: "organization.created",
        resourceType: "organization",
        resourceId: "org_second",
        metadata: { slug: "acme" },
      },
    });
    expect(outcome).toEqual({ outcome: "SLUG_TAKEN" });
    expect(await deps.repos.organizations.findById("org_second")).toBeNull();
    expect(await deps.repos.memberships.listByUser(owner)).toEqual([]);
    expect(organizationAudit(deps)).toEqual([]);
  });
});

describe("shape", () => {
  /** Comments stripped, so prose naming a call is not mistaken for making it. */
  function code(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  }

  function productFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        return ["node_modules", ".next", "dist", "testing"].includes(entry.name) ? [] : productFiles(full);
      }
      return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [full] : [];
    });
  }

  function matching(pattern: RegExp): string[] {
    return ["apps", "packages"]
      .flatMap((dir) => productFiles(join(REPO_ROOT, dir)))
      .filter((file) => pattern.test(code(readFileSync(file, "utf8"))))
      .map((file) => file.slice(REPO_ROOT.length + 1));
  }

  it("creates an organization or a membership by no other call (ADR-0127)", () => {
    expect(matching(/\b(?:organizations|memberships)\.create\(/)).toEqual([]);
    expect(matching(/\.createWithOwner\(/)).toEqual(["packages/domain/src/identity/organization-service.ts"]);
    // The scan reaches the code that creates one.
    expect(matching(/createOrganization\(/)).toContain("apps/web/src/app/api/organizations/route.ts");
  });
});
