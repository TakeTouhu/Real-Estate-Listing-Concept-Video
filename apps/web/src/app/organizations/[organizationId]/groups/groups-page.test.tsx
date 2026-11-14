// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import {
  AuthService,
  GroupService,
  GroupsOverviewService,
  MfaService,
  OrganizationService,
  createMfaSecretCipher,
  systemMfaRandom,
  totpStep,
  type Role,
} from "@app/domain";
import { createTestDeps, markEmailVerified, type TestDeps } from "@app/domain/testing";
import { AppError, hotp } from "@app/shared";

/**
 * The groups page (AT-9a, ADR-0141): a holder of `group.view` sees the groups
 * and who belongs to each; anyone else is refused alike. A holder of
 * `group.manage` creates and renames a group, and one who is also an `OWNER`
 * or `ADMIN` deletes one (AT-9b, ADR-0142). The page says what a fixed code in
 * its address names, and nothing else. The dashboard links each organization
 * to it.
 */
const PASSWORD = "password-123456";
const WENT_WRONG = "Something went wrong.";
const KEY = "56".repeat(32);

const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));
const overview = vi.hoisted(() => ({ value: null as unknown }));

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
vi.mock("@/lib/groups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/groups")>()),
  getGroupsOverviewService: () => overview.value,
}));
vi.mock("@/lib/property", () => ({ getPropertyServices: () => ({ properties: { list: () => Promise.resolve([]) } }) }));

const { default: GroupsPage } = await import("./page");
const { default: DashboardPage } = await import("../../../page");

let deps: TestDeps;
let auth: AuthService;
let groups: GroupService;
let orgId: string;
let ownerId: string;

beforeEach(async () => {
  deps = createTestDeps();
  deps.clock.set(new Date("2026-11-10T03:00:00.000Z"));
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const organizations = new OrganizationService(deps);
  identity.value = { deps, auth, organizations };
  overview.value = new GroupsOverviewService(deps);
  groups = new GroupService(deps);
  env.value = { NODE_ENV: "test", MFA_SECRET_KEY: KEY };
  ownerId = (await auth.register({ email: "owner@example.com", name: "Aiko Owner", password: PASSWORD })).id;
  markEmailVerified(deps, ownerId);
  ({ organization: { id: orgId } } = await organizations.createOrganization(ownerId, { name: "Studio Kanda" }));
});

afterEach(cleanup);

function decodeBase32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of text) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

/** Sign in a new user, as a member holding `role` or as no member at all, with MFA set up; returns its id. */
async function signInAs(role: Role | null): Promise<string> {
  const email = `ken.${(role ?? "outsider").toLowerCase()}@example.com`;
  const userId = (await auth.register({ email, name: `Ken ${role ?? "Outsider"}`, password: PASSWORD })).id;
  markEmailVerified(deps, userId);
  if (role !== null) await deps.repos.memberships.create({ organizationId: orgId, userId, role });
  const { token, session } = await auth.login(email, PASSWORD);
  const mfa = new MfaService({ ...deps, cipher: createMfaSecretCipher(KEY), random: systemMfaRandom });
  const { secret } = await mfa.beginSetup(session);
  await mfa.confirmSetup(session, hotp(decodeBase32(secret), totpStep(deps.clock.now())));
  cookie.value = token;
  return userId;
}

type Query = Record<string, string | string[]>;

async function renderGroups(query: Query = {}): Promise<string> {
  const { container } = render(
    (await GroupsPage({
      params: Promise.resolve({ organizationId: orgId }),
      searchParams: Promise.resolve(query),
    })) as ReactElement,
  );
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

/** A member of the organization, by name, holding `role`; returns its account's id. */
async function joined(name: string, role: Role): Promise<string> {
  const email = `${name.toLowerCase().replace(" ", ".")}@example.com`;
  const userId = (await auth.register({ email, name, password: PASSWORD })).id;
  await deps.repos.memberships.create({ organizationId: orgId, userId, role });
  return userId;
}

async function group(name: string, memberIds: readonly string[] = []): Promise<void> {
  const created = await groups.create(ownerId, orgId, name);
  for (const userId of memberIds) await groups.addMember(ownerId, orgId, created.id, userId);
}

/** The create form: where and how it posts, and its name field. */
function createForm(): string | null {
  const button = screen.queryByRole("button", { name: "Create group" });
  if (button === null) return null;
  const form = button.closest("form");
  const field = screen.getByLabelText<HTMLInputElement>("Group name");
  const attributes = `name=${field.name} maxLength=${field.maxLength} required=${field.required}`;
  return `${form?.getAttribute("method")} ${form?.getAttribute("action")} (${attributes})`;
}

/** A group's rename form: where it posts, the name it carries as shown, and its name field. */
function renameForm(name: string): string | null {
  const button = screen.queryByRole("button", { name: `Rename group ${name}` });
  if (button === null) return null;
  const form = button.closest("form")!;
  const shown = form.querySelector<HTMLInputElement>('input[type="hidden"]');
  const field = form.querySelector<HTMLInputElement>('input[type="text"]')!;
  const label = form.querySelector(`label[for="${field.id}"]`)?.textContent;
  const attributes = `name=${field.name} value=${field.value} maxLength=${field.maxLength} required=${field.required}`;
  const carried = `${shown?.name}=${shown?.value}`;
  return `${form.getAttribute("method")} ${form.getAttribute("action")} (${carried}; ${label}: ${attributes})`;
}

/** A group's delete form: where it posts, what it says, and that it carries no field. */
function deleteForm(name: string): string | null {
  const button = screen.queryByRole("button", { name: `Delete group ${name}` });
  if (button === null) return null;
  const form = button.closest("form")!;
  const said = form.querySelector("p")?.textContent?.replace(/\s+/g, " ");
  const fields = form.querySelectorAll("input").length;
  return `${form.getAttribute("method")} ${form.getAttribute("action")} (${fields}) ${said}`;
}

describe("the groups page", () => {
  it("sends a signed-out visitor to sign in", async () => {
    await expect(GroupsPage({ params: Promise.resolve({ organizationId: orgId }) })).rejects.toThrow(
      "redirect /login",
    );
  });

  it.each([["CREATOR" as const], ["VIEWER" as const], ["BILLING" as const], [null]])(
    "refuses %s alike, without the organization's name or its groups",
    async (role) => {
      await group("East office", [ownerId]);
      await signInAs(role);
      const text = await renderGroups();
      expect(screen.getByRole("alert").textContent).toBe("You cannot view this organization's groups.");
      expect(text).not.toContain("Studio Kanda");
      expect(text).not.toContain("East office");
      expect(text).not.toContain("owner@example.com");
    },
  );

  it("does not pass off an unexpected failure as a refusal", async () => {
    await signInAs("OWNER");
    overview.value = { overview: () => Promise.reject(new AppError("INTERNAL_ERROR", "unreadable groups")) };
    await expect(GroupsPage({ params: Promise.resolve({ organizationId: orgId }) })).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });

  it("shows a manager the groups by name, with their members, and no create form", async () => {
    const creatorId = await joined("Sora Creator", "CREATOR");
    await group("West", [creatorId, ownerId]);
    await group("East", [ownerId]);
    await group("Empty");
    const managerId = await signInAs("MANAGER");
    await groups.addMember(ownerId, orgId, (await deps.repos.groups.listByOrganization(orgId))[0]!.id, managerId);
    const text = await renderGroups();

    expect(text).toContain("Studio Kanda");
    expect(text).toContain("A Manager reaches the Properties assigned to the groups they belong to.");
    expect(screen.getByRole("heading", { name: "Groups (3)" })).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent?.replace(/\s+/g, " "))).toEqual([
      "East · 2 membersAiko Owner · owner@example.com · OwnerKen MANAGER · ken.manager@example.com · Manager",
      "Aiko Owner · owner@example.com · Owner",
      "Ken MANAGER · ken.manager@example.com · Manager",
      "Empty · 0 members",
      "West · 2 membersAiko Owner · owner@example.com · OwnerSora Creator · sora.creator@example.com · Creator",
      "Aiko Owner · owner@example.com · Owner",
      "Sora Creator · sora.creator@example.com · Creator",
    ]);
    expect(createForm()).toBeNull();
    expect(renameForm("East")).toBeNull();
    expect(deleteForm("East")).toBeNull();
  });

  it("names a member without an address when the overview gives none", async () => {
    // The overview's own tests hold when it gives one: to a viewer holding member.view too.
    await signInAs("MANAGER");
    const member = { userId: ownerId, name: "Aiko Owner", email: null, role: "OWNER" as const };
    const groupsShown = [{ id: "grp_1", name: "East", members: [member] }];
    overview.value = { overview: () => Promise.resolve({ groups: groupsShown, mayManage: false, mayDelete: false }) };
    const text = await renderGroups();
    expect(text).toContain("East · 1 memberAiko Owner · Owner");
    expect(text).not.toContain("owner@example.com");
  });

  it("says so when there are no groups, and says one member in the singular", async () => {
    await signInAs("ADMIN");
    await renderGroups();
    expect(screen.getByRole("heading", { name: "Groups (0)" })).toBeTruthy();
    expect(screen.getByText("No groups yet.")).toBeTruthy();
    cleanup();
    await group("Solo", [ownerId]);
    const text = await renderGroups();
    expect(text).toContain("Solo · 1 member");
  });

  it.each(["OWNER", "ADMIN"] as const)("lets a %s create a group, posting a name", async (role) => {
    await signInAs(role);
    await renderGroups();
    expect(createForm()).toBe(`post /api/organizations/${orgId}/groups (name=name maxLength=100 required=true)`);
  });

  it("offers the form to whoever the overview says may manage groups, as a manager granted group.manage", async () => {
    // The overview's own tests hold that such a grant is what it says (ADR-0058).
    await signInAs("MANAGER");
    overview.value = { overview: () => Promise.resolve({ groups: [], mayManage: true, mayDelete: false }) };
    await renderGroups();
    expect(createForm()).toBe(`post /api/organizations/${orgId}/groups (name=name maxLength=100 required=true)`);
  });

  it.each(["OWNER", "ADMIN"] as const)("lets a %s rename and delete each group", async (role) => {
    await group("East");
    await group("West", [ownerId]);
    await signInAs(role);
    await renderGroups();
    const [east, west] = (await deps.repos.groups.listByOrganization(orgId)).map(({ id }) => id);
    const path = `/api/organizations/${orgId}/groups`;
    const field = (name: string) => `New name: name=name value=${name} maxLength=100 required=true`;
    expect(renameForm("East")).toBe(`post ${path}/${east}/rename (from=East; ${field("East")})`);
    expect(renameForm("West")).toBe(`post ${path}/${west}/rename (from=West; ${field("West")})`);
    expect(deleteForm("West")).toBe(
      `post ${path}/${west}/delete (0) West will be deleted. Its members stay in the organization with their roles, ` +
        "and lose only what this group gave them. Properties assigned to it are left with no group, so no Manager " +
        "reaches them through it. Nothing else is deleted, and this cannot be undone.",
    );
    expect(deleteForm("East")).toMatch(`post ${path}/${east}/delete (0) East will be deleted.`);
    // Both closed until opened, each named for its group.
    expect(screen.getByText("Rename…", { selector: `summary[aria-label="Rename East…"]` })).toBeTruthy();
    expect(screen.getByText("Delete…", { selector: `summary[aria-label="Delete East…"]` })).toBeTruthy();
    expect(document.querySelectorAll("details[open]")).toHaveLength(0);
  });

  it("offers renaming to whoever may manage groups, and deleting only to whoever the overview says may", async () => {
    // A manager granted group.manage: the overview's own tests hold it may not delete (ADR-0052 Decision 11).
    await signInAs("MANAGER");
    const groupsShown = [{ id: "grp_1", name: "East", members: [] }];
    overview.value = { overview: () => Promise.resolve({ groups: groupsShown, mayManage: true, mayDelete: false }) };
    await renderGroups();
    expect(renameForm("East")).toMatch(`post /api/organizations/${orgId}/groups/grp_1/rename (from=East;`);
    expect(deleteForm("East")).toBeNull();
  });

  it("names a group's forms by its id in the address, encoded", async () => {
    await signInAs("OWNER");
    const groupsShown = [{ id: "grp/1?x", name: "East", members: [] }];
    overview.value = { overview: () => Promise.resolve({ groups: groupsShown, mayManage: true, mayDelete: true }) };
    await renderGroups();
    expect(renameForm("East")).toMatch(`/groups/grp%2F1%3Fx/rename (`);
    expect(deleteForm("East")).toMatch(`/groups/grp%2F1%3Fx/delete (`);
  });

  it("links to the members page", async () => {
    await signInAs("OWNER");
    await renderGroups();
    expect(screen.getByRole("link", { name: "Members" }).getAttribute("href")).toBe(
      `/organizations/${orgId}/members`,
    );
  });

  it.each([
    [{ notice: "group-created" }, "status", "The group was created."],
    [{ error: "group-name" }, "alert", "Enter a group name of 1 to 100 characters."],
    [{ error: "group-name-taken" }, "alert", "Another group of this organization already has that name."],
    [{ error: "may-not-create-group" }, "alert", "You cannot create groups in this organization."],
    [{ error: "create-group-failed" }, "alert", "Something went wrong. Check below whether the group was created."],
    [{ notice: "group-renamed" }, "status", "The group's name was saved."],
    [{ notice: "group-deleted" }, "status", "The group was deleted."],
    [{ error: "group-gone" }, "alert", "That group no longer exists."],
    [{ error: "group-changed" }, "alert", "That group was renamed or deleted meanwhile. Check below and try again."],
    [{ error: "may-not-rename-group" }, "alert", "You cannot rename groups in this organization."],
    [{ error: "rename-group-failed" }, "alert", `${WENT_WRONG} Check below whether the group was renamed.`],
    [{ error: "may-not-delete-group" }, "alert", "You cannot delete this group."],
    [{ error: "delete-group-failed" }, "alert", `${WENT_WRONG} Check below whether the group was deleted.`],
  ] as const)("says what %o names", async (query, role, sentence) => {
    await signInAs("OWNER");
    await renderGroups(query);
    expect(screen.getByRole(role).textContent).toBe(sentence);
  });

  it.each([
    [{ notice: "<b>hello</b>" }],
    [{ error: "constructor" }],
    [{ notice: ["group-created", "group-created"] }],
    [{ error: ["group-name"] }],
  ])("ignores %o, showing nothing it carries", async (query) => {
    await signInAs("OWNER");
    const text = await renderGroups(query);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(text).not.toContain("hello");
  });
});

describe("the dashboard", () => {
  it("links each organization to its groups page", async () => {
    await signInAs("MANAGER");
    render((await DashboardPage({ searchParams: Promise.resolve({}) })) as ReactElement);
    expect(screen.getByRole("link", { name: "Groups" }).getAttribute("href")).toBe(`/organizations/${orgId}/groups`);
  });
});
