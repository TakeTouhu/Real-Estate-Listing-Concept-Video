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
import { hotp } from "@app/shared";

/**
 * Route tests for creating a Property from the home page with its responsible
 * user and group (AT-10b, ADR-0145): a same-origin form post, signed in,
 * reaches the Property service, which decides by the creator's role and audits
 * a refusal; an error goes back to the home page. Only the cookie store, the
 * environment and the identity and Property wiring are stubbed.
 */
const PASSWORD = "password-123456";
const MFA_KEY = "7b".repeat(32);
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

const { POST: create } = await import("@/app/api/properties/route");
const { ASSIGNMENT_ID_MAX_LENGTH } = await import("@/lib/property-assignment");

let deps: TestDeps;
let auth: AuthService;
let repo: InMemoryPropertyRepository;
let orgId: string;
let ids: Record<Role, string>;
let east: string;
let west: string;

beforeEach(async () => {
  deps = createTestDeps();
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  identity.value = { deps, auth, organizations: new OrganizationService(deps) };
  env.value = { NODE_ENV: "test", USER_SESSION_TTL_SECONDS: 3600, MFA_SECRET_KEY: MFA_KEY };
  repo = new InMemoryPropertyRepository(deps.clock, deps.repos);
  property.value = {
    properties: new PropertyService({
      identity: deps,
      properties: repo,
      assets: new InMemoryMediaAssetRepository(deps.clock),
      clock: deps.clock,
      ids: deps.ids,
    }),
  };
  const ownerId = await register("owner");
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
  await groups.create(ownerId, orgId, "North");
  for (const groupId of [east, west]) await groups.addMember(ownerId, orgId, groupId, ids.MANAGER);
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

/** A post of the "Add a property" form, with `fields` over a complete one choosing none. */
const creating = (fields: Record<string, string> = {}, headers: Record<string, string> = { origin: SITE }) =>
  create(
    new Request(`${SITE}/api/properties`, {
      method: "POST",
      headers: { host: "app.vtavision.test", "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({
        organizationId: orgId,
        name: "Harbor View",
        propertyType: "APARTMENT",
        rightsConfirmed: "yes",
        responsibleUserId: "",
        groupId: "",
        ...fields,
      }).toString(),
    }),
  );

/** The Properties created, with their assignments. */
const created = async () =>
  (await repo.listReachable({ scope: "ORGANIZATION", organizationId: orgId })).map(
    ({ id, responsibleUserId, groupId }) => ({ id, responsibleUserId, groupId }),
  );

/** Where a 303 lands: the new Property's page, or the home page with an error. */
function landing(response: Response): string {
  expect(response.status).toBe(303);
  const url = new URL(response.headers.get("location")!);
  expect(url.origin).toBe(SITE);
  return `${url.pathname}${url.search ? ` ${url.searchParams.get("error")}` : ""}`;
}

const audited = (action: string) => deps.repos.auditLogs.all().filter((entry) => entry.action === action);

const INELIGIBLE = "/ The responsible user must be a member of this organization who is not BILLING";
const NOT_A_GROUP = "/ The group must be a group of this organization";

describe("creating a Property with its assignment", () => {
  it.each(["OWNER", "ADMIN"] as const)("lets an %s choose its responsible user and group", async (role) => {
    if (role === "ADMIN") await signIn("admin");
    const response = await creating({ responsibleUserId: ids.VIEWER, groupId: east });
    const [only] = await created();
    expect(landing(response)).toBe(`/properties/${only?.id}`);
    expect(only).toMatchObject({ responsibleUserId: ids.VIEWER, groupId: east });
    expect(audited("property.created")[0]?.metadata).toMatchObject({ responsibleUserId: ids.VIEWER, groupId: east });
  });

  it("leaves both unset when an owner chooses none, as before", async () => {
    landing(await creating());
    expect(await created()).toEqual([expect.objectContaining({ responsibleUserId: null, groupId: null })]);
  });

  it("refuses a responsible user who handles billing or is no member, and an unknown group", async () => {
    const outsider = await register("outsider");
    expect(landing(await creating({ responsibleUserId: ids.BILLING }))).toBe(INELIGIBLE);
    expect(landing(await creating({ responsibleUserId: outsider }))).toBe(INELIGIBLE);
    expect(landing(await creating({ groupId: "grp_missing" }))).toBe(NOT_A_GROUP);
    expect(await created()).toEqual([]);
  });

  it("puts a MANAGER's Property in the one of its groups it chose, with it responsible", async () => {
    await signIn("manager");
    landing(await creating({ groupId: west }));
    expect(await created()).toEqual([expect.objectContaining({ responsibleUserId: ids.MANAGER, groupId: west })]);
  });

  it("makes a MANAGER in several groups choose one, creating nothing until it does", async () => {
    await signIn("manager");
    expect(landing(await creating())).toBe("/ Choose which of your groups this property belongs to");
    expect(await created()).toEqual([]);
  });

  it("refuses, and audits, a MANAGER choosing a group it is not in or another responsible user", async () => {
    await signIn("manager");
    const refused = "/ Role MANAGER may not choose this property's responsible user or group";
    const north = (await deps.repos.groups.listByOrganization(orgId)).find(({ name }) => name === "North")!.id;
    expect(landing(await creating({ groupId: north }))).toBe(refused);
    expect(landing(await creating({ groupId: east, responsibleUserId: ids.CREATOR }))).toBe(refused);
    expect(await created()).toEqual([]);
    expect(audited("property.assignment_refused").map(({ metadata }) => metadata)).toEqual([
      expect.objectContaining({ operation: "create", reason: "group_not_own", groupId: north }),
      expect.objectContaining({ reason: "responsible_user_fixed", responsibleUserId: ids.CREATOR }),
    ]);
  });

  it("makes a CREATOR responsible, ungrouped, and refuses its choosing a group", async () => {
    await signIn("creator");
    landing(await creating());
    expect(await created()).toEqual([expect.objectContaining({ responsibleUserId: ids.CREATOR, groupId: null })]);
    const refused = "/ Role CREATOR may not choose this property's responsible user or group";
    expect(landing(await creating({ groupId: east }))).toBe(refused);
    expect(audited("property.assignment_refused")).toHaveLength(1);
  });

  it("refuses a VIEWER, who may create no Property", async () => {
    await signIn("viewer");
    expect(landing(await creating())).toBe("/ Role VIEWER lacks permission 'property.create'");
    expect(await created()).toEqual([]);
  });

  it("refuses ids longer than any this product makes, so they never reach the audit log", async () => {
    await signIn("manager");
    const longest = "x".repeat(ASSIGNMENT_ID_MAX_LENGTH);
    expect(landing(await creating({ groupId: `${longest}x` }))).toBe(NOT_A_GROUP);
    expect(landing(await creating({ responsibleUserId: `${longest}x`, groupId: east }))).toBe(
      "/ The responsible user must be a member of this organization",
    );
    expect(audited("property.assignment_refused")).toEqual([]);
    expect(landing(await creating({ groupId: longest }))).toMatch(/^\/ Role MANAGER may not choose/);
    expect(audited("property.assignment_refused").map(({ metadata }) => metadata.groupId)).toEqual([longest]);
    expect(await created()).toEqual([]);
  });

  it.each([
    ["no origin", {}],
    ["another site", { origin: "https://evil.example.net" }],
  ])("refuses a post from %s before reading anything", async (_what, headers) => {
    expect((await creating({}, headers)).status).toBe(403);
    expect(await created()).toEqual([]);
  });

  it("sends a signed-out visitor to sign in, creating nothing", async () => {
    cookie.value = undefined;
    expect(new URL((await creating()).headers.get("location")!).pathname).toBe("/login");
    expect(await created()).toEqual([]);
  });
});
