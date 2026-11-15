// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
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
 * The home page's "Add a property" form, by what the member's role lets it
 * choose for the new Property (AT-10b, ADR-0145). The identity and Property
 * services run for real, on in-memory repositories.
 */
const PASSWORD = "password-123456";
const KEY = "45".repeat(32);

const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));
const property = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (name === "rev_session" && cookie.value ? { value: cookie.value } : undefined),
    }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect ${path}`);
  },
}));
vi.mock("@/lib/env", () => ({ getServerEnv: () => env.value }));
vi.mock("@/lib/identity", () => ({ getIdentityServices: () => identity.value }));
vi.mock("@/lib/property", () => ({ getPropertyServices: () => property.value }));

const { default: DashboardPage } = await import("./page");

let deps: TestDeps;
let auth: AuthService;
let groups: GroupService;
let orgId: string;
let ownerId: string;
let east: string;
let west: string;

beforeEach(async () => {
  deps = createTestDeps();
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const organizations = new OrganizationService(deps);
  identity.value = { deps, auth, organizations };
  env.value = { NODE_ENV: "test", MFA_SECRET_KEY: KEY };
  const properties = new PropertyService({
    identity: deps,
    properties: new InMemoryPropertyRepository(deps.clock, deps.repos),
    assets: new InMemoryMediaAssetRepository(deps.clock),
    clock: deps.clock,
    ids: deps.ids,
  });
  property.value = { properties };
  ownerId = await register("owner");
  ({ organization: { id: orgId } } = await organizations.createOrganization(ownerId, { name: "Studio" }));
  groups = new GroupService(deps);
  west = (await groups.create(ownerId, orgId, "West")).id;
  east = (await groups.create(ownerId, orgId, "East")).id;
});

afterEach(() => {
  cleanup();
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

/** A new member holding `role`, in `groupIds`. */
async function member(role: Role, ...groupIds: string[]): Promise<string> {
  const userId = await register(role.toLowerCase());
  await deps.repos.memberships.create({ organizationId: orgId, userId, role });
  for (const groupId of groupIds) await groups.addMember(ownerId, orgId, groupId, userId);
  return userId;
}

/** Sign in as `name`, with MFA set up. */
async function signIn(name: string): Promise<void> {
  const { token, session } = await auth.login(`${name}@example.com`, PASSWORD);
  const mfa = new MfaService({ ...deps, cipher: createMfaSecretCipher(KEY), random: systemMfaRandom });
  const { secret } = await mfa.beginSetup(session);
  await mfa.confirmSetup(session, hotp(decodeBase32(secret), totpStep(deps.clock.now())));
  cookie.value = token;
}

/** Render the home page signed in as `name`. */
async function renderAs(name: string): Promise<void> {
  await signIn(name);
  render((await DashboardPage({ searchParams: Promise.resolve({}) })) as ReactElement);
}

const field = (name: string) => document.querySelector(`form[action="/api/properties"] [name="${name}"]`);

/** The form's list named `name`: its label, its options as `value=text`, which is selected, and whether one must be. */
function options(name: string) {
  const select = field(name) as HTMLSelectElement;
  return {
    label: document.querySelector(`label[for="${select.id}"]`)?.textContent,
    options: [...select.options].map(({ value, text, disabled }) => `${value}=${text}${disabled ? " (disabled)" : ""}`),
    selected: select.value,
    required: select.required,
  };
}

describe("the home page's Add a property form", () => {
  it.each(["OWNER", "ADMIN"] as const)(
    "lets an %s choose any member but a BILLING one and any group, each None unless chosen",
    async (role) => {
      const manager = await member("MANAGER");
      await member("BILLING");
      const admin = role === "ADMIN" ? await member("ADMIN") : undefined;
      await renderAs(role === "OWNER" ? "owner" : "admin");
      expect(options("responsibleUserId")).toEqual({
        options: [
          "=None",
          `${ownerId}=owner · owner@example.com · Owner`,
          ...(admin ? [`${admin}=admin · admin@example.com · Admin`] : []),
          `${manager}=manager · manager@example.com · Manager`,
        ],
        selected: "",
        required: false,
        label: "Responsible user (optional)",
      });
      const groupOptions = ["=None", `${east}=East`, `${west}=West`];
      const group = { options: groupOptions, selected: "", required: false, label: "Group (optional)" };
      expect(options("groupId")).toEqual(group);
    },
  );

  it("makes a MANAGER in several groups choose one of its own", async () => {
    const north = (await groups.create(ownerId, orgId, "North")).id;
    await member("MANAGER", west, north);
    await renderAs("manager");
    expect(field("responsibleUserId")).toBeNull();
    expect(screen.getByText("You will be responsible for this property.")).toBeTruthy();
    expect(options("groupId")).toEqual({
      options: ["=Choose one of your groups (disabled)", `${north}=North`, `${west}=West`],
      selected: "",
      required: true,
      label: "Group",
    });
  });

  it("chooses a MANAGER's only group for it", async () => {
    await member("MANAGER", east);
    await renderAs("manager");
    expect(options("groupId")).toEqual({ options: [`${east}=East`], selected: east, required: true, label: "Group" });
  });

  it("tells a MANAGER in no group why it cannot add a property, and offers no form", async () => {
    await member("MANAGER");
    await renderAs("manager");
    expect(screen.queryByText("Add a property")).toBeNull();
    expect(screen.getByText(/You cannot add a property yet: .* you belong to\s+none\./)).toBeTruthy();
  });

  it("tells a CREATOR it will be responsible, in no group, whatever its groups", async () => {
    await member("CREATOR", east);
    await renderAs("creator");
    expect(field("responsibleUserId")).toBeNull();
    expect(field("groupId")).toBeNull();
    expect(screen.getByText("You will be responsible for this property. It will belong to no group.")).toBeTruthy();
    expect(field("name")).not.toBeNull();
  });

  it("shows a BILLING member, whose role includes no Properties, neither a list nor a form", async () => {
    await member("BILLING");
    await renderAs("billing");
    expect(screen.getByRole("heading", { name: "Studio (BILLING)" })).toBeTruthy();
    expect(screen.getByText("Your role does not include Properties.")).toBeTruthy();
    expect(screen.queryByText("No properties yet.")).toBeNull();
    expect(screen.queryByText("Add a property")).toBeNull();
  });

  it("still fails on an error that is not a refusal of the list", async () => {
    const { properties } = property.value as { properties: PropertyService };
    vi.spyOn(properties, "list").mockRejectedValueOnce(new AppError("INTERNAL_ERROR", "Lost"));
    await signIn("owner");
    await expect(DashboardPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("Lost");
  });

  it("offers a VIEWER no form", async () => {
    await member("VIEWER", east);
    await renderAs("viewer");
    expect(screen.getByRole("heading", { name: "Studio (VIEWER)" })).toBeTruthy();
    expect(screen.queryByText("Add a property")).toBeNull();
  });
});
