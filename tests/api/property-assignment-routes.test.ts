import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthService,
  GroupService,
  MfaService,
  OrganizationService,
  PropertyService,
  createMfaSecretCipher,
  systemMfaRandom,
  totpStep,
  type Role,
} from "@app/domain";
import {
  InMemoryMediaAssetRepository,
  InMemoryPropertyRepository,
  createTestDeps,
  markEmailVerified,
  type TestDeps,
} from "@app/domain/testing";
import { AppError, hotp } from "@app/shared";

/**
 * Route tests for changing a Property's responsible user and group from the
 * Property page (AT-10a, ADR-0144): a same-origin form post, signed in,
 * reaches the Property service, which decides and audits; the answer is the
 * Property page with a fixed code, never a name. Only the cookie store, the
 * environment and the identity and Property wiring are stubbed: the session
 * gate and the domain services run for real.
 */
const PASSWORD = "password-123456";
const MFA_KEY = "7a".repeat(32);
const SITE = "https://app.vtavision.test";

const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));
const property = vi.hoisted(() => ({ value: null as unknown }));

// `next` is installed for the web app only, so its module is named by its resolved path.
const nextHeaders = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  return createRequire(new URL("../../apps/web/package.json", import.meta.url)).resolve("next/headers");
});

vi.mock(nextHeaders, () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (name === "rev_session" && cookie.value ? { value: cookie.value } : undefined),
    }),
}));
vi.mock("@/lib/env", () => ({ getServerEnv: () => env.value }));
vi.mock("@/lib/identity", () => ({ getIdentityServices: () => identity.value }));
vi.mock("@/lib/property", () => ({ getPropertyServices: () => property.value }));

const { POST: assign } = await import(
  "@/app/api/organizations/[organizationId]/properties/[propertyId]/assignment/route"
);
const { ASSIGNMENT_ID_MAX_LENGTH, assignProperty } = await import("@/lib/property-assignment");

let deps: TestDeps;
let auth: AuthService;
let properties: PropertyService;
let repo: InMemoryPropertyRepository;
let orgId: string;
let ownerId: string;
let ids: Record<Role, string>;
let east: string;
let west: string;
let propertyId: string;

beforeEach(async () => {
  deps = createTestDeps();
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  identity.value = { deps, auth, organizations: new OrganizationService(deps) };
  env.value = { NODE_ENV: "test", USER_SESSION_TTL_SECONDS: 3600, MFA_SECRET_KEY: MFA_KEY };
  repo = new InMemoryPropertyRepository(deps.clock, deps.repos);
  properties = new PropertyService({
    identity: deps,
    properties: repo,
    assets: new InMemoryMediaAssetRepository(deps.clock),
    clock: deps.clock,
    ids: deps.ids,
  });
  property.value = { properties };
  ownerId = await register("owner");
  ({ organization: { id: orgId } } = await new OrganizationService(deps).createOrganization(ownerId, {
    name: "Studio Kanda",
  }));
  ids = { OWNER: ownerId } as Record<Role, string>;
  for (const role of ["ADMIN", "MANAGER", "CREATOR", "VIEWER", "BILLING"] as const) {
    ids[role] = await register(role.toLowerCase());
    await deps.repos.memberships.create({ organizationId: orgId, userId: ids[role], role });
  }
  const groups = new GroupService(deps);
  east = (await groups.create(ownerId, orgId, "East")).id;
  west = (await groups.create(ownerId, orgId, "West")).id;
  propertyId = (await newProperty(orgId, { responsibleUserId: ids.CREATOR, groupId: east })).id;
  await signIn("owner");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function register(name: string): Promise<string> {
  const userId = (await auth.register({ email: `${name}@example.com`, name, password: PASSWORD })).id;
  markEmailVerified(deps, userId);
  return userId;
}

function newProperty(organizationId: string, choice: { responsibleUserId?: string; groupId?: string } = {}) {
  return properties.create(ownerId, {
    organizationId,
    name: "Harbor View",
    propertyType: "APARTMENT",
    rightsConfirmed: true,
    ...choice,
  });
}

function decodeBase32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...text].map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

/** Sign in as `name`, with MFA set up. */
async function signIn(name: string): Promise<void> {
  const { token, session } = await auth.login(`${name}@example.com`, PASSWORD);
  const mfa = new MfaService({ ...deps, cipher: createMfaSecretCipher(MFA_KEY), random: systemMfaRandom });
  const { secret } = await mfa.beginSetup(session);
  await mfa.confirmSetup(session, hotp(decodeBase32(secret), totpStep(deps.clock.now())));
  cookie.value = token;
}

/** The Property's assignment as the page showed it at the start of each test. */
const shownAtStart = () => ({ shownResponsibleUserId: ids.CREATOR, shownGroupId: east });

/** A post of the assignment form: `fields` over the assignment shown at the start, choosing it again. */
const assigning = (
  fields: Record<string, string> = {},
  target = propertyId,
  organizationId = orgId,
  headers: Record<string, string> = { origin: SITE },
) =>
  assign(
    new Request(
      `${SITE}/api/organizations/${organizationId}/properties/${encodeURIComponent(target)}/assignment`,
      {
        method: "POST",
        headers: { host: "app.vtavision.test", "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams({
          responsibleUserId: ids.CREATOR,
          groupId: east,
          ...shownAtStart(),
          ...fields,
        }).toString(),
      },
    ),
    { params: Promise.resolve({ organizationId, propertyId: target }) },
  );

/** Where a 303 lands: the Property page with one code, and nothing else in the address. */
function landing(response: Response, target = propertyId): string {
  expect(response.status).toBe(303);
  const url = new URL(response.headers.get("location")!);
  expect(url.origin).toBe(SITE);
  expect(url.pathname).toBe(`/properties/${encodeURIComponent(target)}`);
  const entries = [...url.searchParams.entries()];
  expect(entries).toHaveLength(1);
  return entries.map(([key, value]) => `${key}=${value}`).join("");
}

/** The Property's assignment as stored. */
const stored = async (target = propertyId, organizationId = orgId) => {
  const found = await repo.findById(organizationId, target);
  return { responsibleUserId: found?.responsibleUserId ?? null, groupId: found?.groupId ?? null };
};

const AT_START = () => ({ responsibleUserId: ids.CREATOR, groupId: east });

const audited = (action: string) => deps.repos.auditLogs.all().filter((entry) => entry.action === action);

describe("changing a Property's assignment", () => {
  it("changes the responsible user and the group, and audits both, previous and new", async () => {
    expect(landing(await assigning({ responsibleUserId: ids.VIEWER, groupId: west }))).toBe("notice=assignment-saved");
    expect(await stored()).toEqual({ responsibleUserId: ids.VIEWER, groupId: west });
    expect(audited("property.assignment_changed").map(({ actorUserId, resourceId, metadata }) => ({
      actorUserId,
      resourceId,
      metadata,
    }))).toEqual([
      {
        actorUserId: ownerId,
        resourceId: propertyId,
        metadata: {
          actorRole: "OWNER",
          previousResponsibleUserId: ids.CREATOR,
          responsibleUserId: ids.VIEWER,
          previousGroupId: east,
          groupId: west,
        },
      },
    ]);
  });

  it("lets an admin unset both, an empty field meaning none", async () => {
    await signIn("admin");
    expect(landing(await assigning({ responsibleUserId: "", groupId: "" }))).toBe("notice=assignment-saved");
    expect(await stored()).toEqual({ responsibleUserId: null, groupId: null });
    // The page then shows none, and choosing none again changes nothing.
    const shown = { shownResponsibleUserId: "", shownGroupId: "" };
    expect(landing(await assigning({ responsibleUserId: "", groupId: "", ...shown }))).toBe(
      "notice=assignment-unchanged",
    );
  });

  it("says a choice of the assignment shown changes nothing, writing nothing", async () => {
    expect(landing(await assigning())).toBe("notice=assignment-unchanged");
    expect(await stored()).toEqual(AT_START());
    expect(audited("property.assignment_changed")).toEqual([]);
  });

  it("changes nothing when someone changed the assignment since the page was shown", async () => {
    await properties.assign(ids.ADMIN, orgId, propertyId, { responsibleUserId: ids.MANAGER });
    expect(landing(await assigning({ groupId: west }))).toBe("error=assignment-changed");
    expect(await stored()).toEqual({ responsibleUserId: ids.MANAGER, groupId: east });
    expect(audited("property.assignment_changed")).toHaveLength(1);
  });

  it.each(["MANAGER", "CREATOR", "VIEWER", "BILLING"] as const)(
    "refuses a %s, whose role may change no assignment, and audits it",
    async (role) => {
      await signIn(role.toLowerCase());
      expect(landing(await assigning({ groupId: west }))).toBe("error=may-not-assign");
      expect(await stored()).toEqual(AT_START());
      const refusals = audited("property.assignment_refused").map((entry) => [entry.actorUserId, entry.metadata]);
      const choice = { responsibleUserId: ids.CREATOR, groupId: west };
      expect(refusals).toEqual([
        [ids[role], { operation: "assign", reason: "reassignment_role", actorRole: role, ...choice }],
      ]);
    },
  );

  it("refuses an organization the poster is no member of, writing nothing there", async () => {
    const outsider = await register("outsider");
    const { organization } = await new OrganizationService(deps).createOrganization(outsider, { name: "Elsewhere" });
    const theirs = (await properties.create(outsider, {
      organizationId: organization.id,
      name: "Theirs",
      propertyType: "HOUSE",
      rightsConfirmed: true,
    })).id;
    expect(landing(await assigning({ responsibleUserId: "" }, theirs, organization.id), theirs)).toBe(
      "error=may-not-assign",
    );
    expect(await stored(theirs, organization.id)).toEqual({ responsibleUserId: null, groupId: null });
    expect(audited("property.assignment_refused")).toEqual([]);
  });

  it("says a responsible user can no longer be chosen when they handle billing or are no member", async () => {
    const outsider = await register("outsider");
    for (const responsibleUserId of [ids.BILLING, outsider, "usr_missing"]) {
      expect(landing(await assigning({ responsibleUserId }))).toBe("error=responsible-user-gone");
    }
    expect(await stored()).toEqual(AT_START());
  });

  it("says a group no longer exists when it was deleted or is another organization's", async () => {
    const { organization } = await new OrganizationService(deps).createOrganization(ownerId, { name: "Other" });
    const elsewhere = (await new GroupService(deps).create(ownerId, organization.id, "North")).id;
    await new GroupService(deps).delete(ownerId, orgId, west);
    for (const groupId of [west, elsewhere]) {
      expect(landing(await assigning({ groupId }))).toBe("error=assignment-group-gone");
    }
    expect(await stored()).toEqual(AT_START());
  });

  it("finds no missing, deleted or other organization's Property", async () => {
    expect(landing(await assigning({}, "prp_missing"), "prp_missing")).toBe("error=property-gone");
    // An id that is no Property's still lands on its own page, its every character encoded.
    expect(landing(await assigning({}, "prp a/b?c#d"), "prp a/b?c#d")).toBe("error=property-gone");
    const { organization } = await new OrganizationService(deps).createOrganization(ownerId, { name: "Other" });
    const elsewhere = (await newProperty(organization.id)).id;
    expect(landing(await assigning({}, elsewhere), elsewhere)).toBe("error=property-gone");
    await properties.remove(ownerId, orgId, propertyId);
    expect(landing(await assigning({ groupId: west }))).toBe("error=property-gone");
    expect(audited("property.assignment_changed")).toEqual([]);
  });

  it("refuses ids longer than any unread, so they never reach the audit log", async () => {
    await signIn("manager");
    const longest = "x".repeat(ASSIGNMENT_ID_MAX_LENGTH);
    expect(landing(await assigning({}, `${longest}x`), `${longest}x`)).toBe("error=property-gone");
    expect(landing(await assigning({ responsibleUserId: `${longest}x` }))).toBe("error=responsible-user-gone");
    expect(landing(await assigning({ groupId: `${longest}x` }))).toBe("error=assignment-group-gone");
    expect(audited("property.assignment_refused")).toEqual([]);
    expect(landing(await assigning({ responsibleUserId: longest, groupId: longest }, longest), longest)).toBe(
      "error=may-not-assign",
    );
    expect(audited("property.assignment_refused").map(({ resourceId, metadata }) => [resourceId, metadata])).toEqual([
      [longest, expect.objectContaining({ responsibleUserId: longest, groupId: longest })],
    ]);
  });

  it("answers a reason it does not know, or a reason on another error, as a failure", async () => {
    const spy = vi.spyOn(repo, "assign");
    spy.mockRejectedValueOnce(new AppError("VALIDATION_FAILED", "Odd", { details: { reason: "hasOwnProperty" } }));
    expect(landing(await assigning({ groupId: west }))).toBe("error=assign-failed");
    spy.mockRejectedValueOnce(new AppError("INTERNAL_ERROR", "Lost", { details: { reason: "STALE" } }));
    expect(landing(await assigning({ groupId: west }))).toBe("error=assign-failed");
  });

  it("logs a failure by its code alone, and says to check the page", async () => {
    vi.spyOn(repo, "assign").mockRejectedValue(new Error("lost owner@example.com"));
    const logged: unknown[] = [];
    const form = { responsibleUserId: ids.VIEWER, groupId: west, ...shownAtStart() };
    const outcome = await assignProperty(ownerId, orgId, propertyId, form, {
      error: (message, fields) => logged.push({ message, fields }),
    });
    expect(outcome).toEqual({ error: "assign-failed" });
    const message = "A Property's assignment could not be changed";
    expect(logged).toEqual([{ message, fields: { code: "UNEXPECTED" } }]);
  });

  it.each([
    ["no origin", {}],
    ["another site", { origin: "https://evil.example.net" }],
  ])("refuses a post from %s before reading anything", async (_what, headers) => {
    expect((await assigning({ groupId: west }, propertyId, orgId, headers)).status).toBe(403);
    expect(await stored()).toEqual(AT_START());
  });

  it("sends a signed-out visitor to sign in, changing nothing", async () => {
    cookie.value = undefined;
    const response = await assigning({ groupId: west });
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    expect(await stored()).toEqual(AT_START());
  });
});
