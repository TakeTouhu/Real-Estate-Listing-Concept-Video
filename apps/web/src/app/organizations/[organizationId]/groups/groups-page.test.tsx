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
  type GroupsOverviewGroup,
  type Permission,
  type Role,
} from "@app/domain";
import { createTestDeps, markEmailVerified, type TestDeps } from "@app/domain/testing";
import { AppError, hotp } from "@app/shared";

/**
 * The groups page (AT-9a, ADR-0141): a holder of `group.view` sees the groups,
 * who belongs to each and what each gives its members (AT-11c, ADR-0148);
 * anyone else is refused alike. A holder of `group.manage` creates and renames
 * a group, and one who is also an `OWNER` or `ADMIN` deletes one (AT-9b,
 * ADR-0142); a holder of `permission.manage` gives a group a permission or
 * takes one back, where the overview says it may. The page says what a fixed
 * code in its address names, and nothing else. The dashboard links each
 * organization to it.
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
vi.mock("@/lib/property", () => ({
  getPropertyServices: () => ({
    properties: { list: () => Promise.resolve([]), creationChoices: () => Promise.resolve(null) },
  }),
}));

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

async function group(
  name: string,
  memberIds: readonly string[] = [],
  permissions: readonly Permission[] = [],
): Promise<string> {
  const created = await groups.create(ownerId, orgId, name);
  for (const userId of memberIds) await groups.addMember(ownerId, orgId, created.id, userId);
  for (const permission of permissions) await groups.grantPermission(ownerId, orgId, created.id, permission);
  return created.id;
}

/** A group as the overview gives it, with nothing to change unless `shown` says so. */
function shownGroup(
  shown: Partial<GroupsOverviewGroup> & Pick<GroupsOverviewGroup, "id" | "name">,
): GroupsOverviewGroup {
  return { members: [], addable: [], permissions: [], givable: [], revocable: [], mayDelete: false, ...shown };
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

/** A group's rename form: where it posts, the name it carries as shown, and its name field, labelled and named. */
function renameForm(name: string): string | null {
  const button = screen.queryByRole("button", { name: `Rename group ${name}` });
  if (button === null) return null;
  const form = button.closest("form")!;
  const shown = form.querySelector<HTMLInputElement>('input[type="hidden"]');
  const field = form.querySelector<HTMLInputElement>('input[type="text"]')!;
  const label = `${form.querySelector(`label[for="${field.id}"]`)?.textContent} (${field.getAttribute("aria-label")})`;
  const attributes = `name=${field.name} value=${field.value} maxLength=${field.maxLength} required=${field.required}`;
  const carried = `${shown?.name}=${shown?.value}`;
  return `${form.getAttribute("method")} ${form.getAttribute("action")} (${carried}; ${label}: ${attributes})`;
}

/** A group's delete form: where it posts, that it carries no field, and what its button is described by. */
function deleteForm(name: string): string | null {
  const button = screen.queryByRole("button", { name: `Delete group ${name}` });
  if (button === null) return null;
  const form = button.closest("form")!;
  const description = document.getElementById(button.getAttribute("aria-describedby") ?? "");
  const said = description?.textContent?.replace(/\s+/g, " ");
  const fields = form.querySelectorAll("input").length;
  return `${form.getAttribute("method")} ${form.getAttribute("action")} (${fields}) ${said}`;
}

/** A group's add form: where it posts, its list, labelled and named, and the members it offers. */
function addForm(group: string): string | null {
  const button = screen.queryByRole("button", { name: `Add to group ${group}` });
  if (button === null) return null;
  const form = button.closest("form")!;
  const list = form.querySelector("select")!;
  const label = `${form.querySelector(`label[for="${list.id}"]`)?.textContent} (${list.getAttribute("aria-label")})`;
  const offered = [...list.options].map(({ value, textContent, disabled }) =>
    disabled ? `${textContent} (none)` : `${textContent} = ${value}`,
  );
  const attributes = `${label}: name=${list.name} value=${list.value} required=${list.required}`;
  return `${form.getAttribute("method")} ${form.getAttribute("action")} (${attributes}) ${offered.join(" | ")}`;
}

/** A group member's remove form: where it posts, that it carries no field, and what its button is described by. */
function removeForm(who: string, group: string): string | null {
  const button = screen.queryByRole("button", { name: `Remove from group ${group}: ${who}` });
  if (button === null) return null;
  const form = button.closest("form")!;
  const description = document.getElementById(button.getAttribute("aria-describedby") ?? "");
  const said = description?.textContent?.replace(/\s+/g, " ");
  const fields = form.querySelectorAll("input").length;
  return `${form.getAttribute("method")} ${form.getAttribute("action")} (${fields}) ${said}`;
}

/** A group's give form: where it posts, its list, labelled and named, what it offers, and its button's description. */
function giveForm(group: string): string | null {
  const button = screen.queryByRole("button", { name: `Give to group ${group}` });
  if (button === null) return null;
  const form = button.closest("form")!;
  const list = form.querySelector("select")!;
  const label = `${form.querySelector(`label[for="${list.id}"]`)?.textContent} (${list.getAttribute("aria-label")})`;
  const offered = [...list.options].map(({ value, textContent, disabled }) =>
    disabled ? `${textContent} (none)` : `${textContent} = ${value}`,
  );
  const said = document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent;
  const attributes = `${label}: name=${list.name} value=${list.value} required=${list.required}`;
  const where = `${form.getAttribute("method")} ${form.getAttribute("action")}`;
  return `${where} (${attributes}) ${offered.join(" | ")} -- ${said}`;
}

/** A group's take-back forms, each as where it posts and the permission it carries. */
function takeBackForms(group: string): string[] {
  return screen
    .queryAllByRole("button", { name: new RegExp(`^Take back from ${group} the permission: `) })
    .map((button) => {
      const form = button.closest("form")!;
      const carried = form.querySelector<HTMLInputElement>('input[type="hidden"][name="permission"]')?.value;
      return `${form.getAttribute("method")} ${form.getAttribute("action")} ${carried}`;
    });
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
    const none = "It gives its members no permissions.";
    const owner = "Aiko Owner · owner@example.com · Owner";
    expect(screen.getAllByRole("listitem").map((item) => item.textContent?.replace(/\s+/g, " "))).toEqual([
      `East · 2 members${owner}Ken MANAGER · ken.manager@example.com · Manager${none}`,
      "Aiko Owner · owner@example.com · Owner",
      "Ken MANAGER · ken.manager@example.com · Manager",
      `Empty · 0 members${none}`,
      `West · 2 members${owner}Sora Creator · sora.creator@example.com · Creator${none}`,
      "Aiko Owner · owner@example.com · Owner",
      "Sora Creator · sora.creator@example.com · Creator",
    ]);
    expect(createForm()).toBeNull();
    expect(renameForm("East")).toBeNull();
    expect(deleteForm("East")).toBeNull();
    expect(addForm("East")).toBeNull();
    expect(screen.queryByText("Remove…")).toBeNull();
  });

  it("names a member without an address when the overview gives none", async () => {
    // The overview's own tests hold when it gives one: to a viewer holding member.view too.
    await signInAs("MANAGER");
    const member = { userId: ownerId, name: "Aiko Owner", email: null, role: "OWNER" as const, mayRemove: false };
    const groupsShown = [shownGroup({ id: "grp_1", name: "East", members: [member] })];
    overview.value = { overview: () => Promise.resolve({ groups: groupsShown, mayManage: false }) };
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
    overview.value = { overview: () => Promise.resolve({ groups: [], mayManage: true }) };
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
    const field = (name: string) =>
      `New name (New name for ${name}): name=name value=${name} maxLength=100 required=true`;
    expect(renameForm("East")).toBe(`post ${path}/${east}/rename (from=East; ${field("East")})`);
    expect(renameForm("West")).toBe(`post ${path}/${west}/rename (from=West; ${field("West")})`);
    expect(deleteForm("West")).toBe(
      `post ${path}/${west}/delete (0) West will be deleted. Its members stay in the organization with their roles, ` +
        "and lose only what this group gave them. Properties assigned to it are left with no group, so no Manager " +
        "reaches them. Nothing else is deleted, and this cannot be undone.",
    );
    expect(deleteForm("East")).toMatch(`post ${path}/${east}/delete (0) East will be deleted.`);
    // Both closed until opened, each named for its group.
    expect(screen.getByText("Rename…", { selector: `summary[aria-label="Rename East…"]` })).toBeTruthy();
    expect(screen.getByText("Delete…", { selector: `summary[aria-label="Delete East…"]` })).toBeTruthy();
    expect(document.querySelectorAll("details[open]")).toHaveLength(0);
  });

  it("offers renaming to whoever may manage groups, and deleting only where the overview says it may", async () => {
    // A manager granted group.manage: the overview's own tests hold it may not delete (ADR-0052 Decision 11).
    await signInAs("MANAGER");
    const groupsShown = [shownGroup({ id: "grp_1", name: "East" })];
    overview.value = { overview: () => Promise.resolve({ groups: groupsShown, mayManage: true }) };
    await renderGroups();
    expect(renameForm("East")).toMatch(`post /api/organizations/${orgId}/groups/grp_1/rename (from=East;`);
    expect(deleteForm("East")).toBeNull();
  });

  it("lets an admin add a member whose role it may assign, and remove one, each form named for its group", async () => {
    const creatorId = await joined("Sora Creator", "CREATOR");
    const viewerId = await joined("Mio Viewer", "VIEWER");
    await group("West", [creatorId, ownerId]);
    await signInAs("ADMIN");
    await renderGroups();
    const [west] = (await deps.repos.groups.listByOrganization(orgId)).map(({ id }) => id);
    const path = `/api/organizations/${orgId}/groups/${west}/members`;
    expect(addForm("West")).toBe(
      `post ${path} (Member (Member to add to West): name=userId value= required=true) Choose a member (none) | ` +
        `Mio Viewer · mio.viewer@example.com · Viewer = ${viewerId}`,
    );
    expect(removeForm("Sora Creator (sora.creator@example.com)", "West")).toBe(
      `post ${path}/${creatorId}/remove (0) Sora Creator will leave West and lose only what this group gave them, ` +
        "so a Manager no longer reaches the Properties assigned to it. They stay in the organization with their role.",
    );
    // An admin may not assign an owner's role, so it may not remove one from a group.
    expect(removeForm("Aiko Owner (owner@example.com)", "West")).toBeNull();
    const adder = `summary[aria-label="Add member to West…"]`;
    expect(screen.getByText("Add member…", { selector: adder })).toBeTruthy();
    const summary = `summary[aria-label="Remove Sora Creator (sora.creator@example.com) from West…"]`;
    expect(screen.getByText("Remove…", { selector: summary })).toBeTruthy();
    expect(document.querySelectorAll("details[open]")).toHaveLength(0);
  });

  it("offers no add form when the overview gives no one to add, and names a member without an address", async () => {
    await signInAs("OWNER");
    const member = { userId: ownerId, name: "Aiko Owner", email: null, role: "OWNER" as const, mayRemove: true };
    const groupsShown = [shownGroup({ id: "grp_1", name: "East", members: [member], mayDelete: true })];
    overview.value = { overview: () => Promise.resolve({ groups: groupsShown, mayManage: true }) };
    await renderGroups();
    expect(addForm("East")).toBeNull();
    expect(removeForm("Aiko Owner", "East")).toMatch(`/groups/grp_1/members/${ownerId}/remove (0) Aiko Owner will`);
  });

  it("names a group's forms by its id in the address, encoded", async () => {
    await signInAs("OWNER");
    const member = { userId: "usr/1?y", name: "Mio", email: null, role: "VIEWER" as const };
    const groupsShown = [
      shownGroup({
        id: "grp/1?x",
        name: "East",
        members: [{ ...member, mayRemove: true }],
        addable: [{ ...member, name: "Rin" }],
        permissions: ["unit.view"],
        givable: ["video.view"],
        revocable: ["unit.view"],
        mayDelete: true,
      }),
    ];
    overview.value = { overview: () => Promise.resolve({ groups: groupsShown, mayManage: true }) };
    await renderGroups();
    expect(renameForm("East")).toMatch(`/groups/grp%2F1%3Fx/rename (`);
    expect(deleteForm("East")).toMatch(`/groups/grp%2F1%3Fx/delete (`);
    expect(addForm("East")).toMatch(`/groups/grp%2F1%3Fx/members (`);
    expect(removeForm("Mio", "East")).toMatch(`/groups/grp%2F1%3Fx/members/usr%2F1%3Fy/remove (`);
    expect(giveForm("East")).toMatch(`/groups/grp%2F1%3Fx/permissions/grant (`);
    expect(takeBackForms("East")).toEqual([
      `post /api/organizations/${orgId}/groups/grp%2F1%3Fx/permissions/revoke unit.view`,
    ]);
  });

  it("shows what each group gives its members, by name, and a manager nothing to change", async () => {
    await group("East", [ownerId], ["video.download", "audit.view", "unit.view"]);
    await signInAs("MANAGER");
    const text = await renderGroups();
    expect(text).toContain(
      "East · 1 memberAiko Owner · owner@example.com · OwnerIt gives each of its members:Download videos" +
        "See UnitsSee the audit log (nothing in VTaVision uses it yet)",
    );
    expect(giveForm("East")).toBeNull();
    expect(takeBackForms("East")).toEqual([]);
  });

  it("lets an owner take back what a group gives, and give it another, saying what that brings", async () => {
    const east = await group("East", [ownerId], ["unit.view", "billing.manage"]);
    await signInAs("OWNER");
    await renderGroups();
    const path = `/api/organizations/${orgId}/groups/${east}/permissions`;
    expect(takeBackForms("East")).toEqual([`post ${path}/revoke unit.view`, `post ${path}/revoke billing.manage`]);
    expect(screen.getByRole("button", { name: "Take back from East the permission: Buy Units" }).textContent).toBe(
      "Take back",
    );
    const form = giveForm("East");
    const list = "Permission (Permission to give East): name=permission value= required=true";
    expect(form).toMatch(`post ${path}/grant (${list})`);
    expect(form).toContain("Choose a permission (none) | See the organization (nothing in VTaVision uses it yet) = ");
    expect(form).toContain(" | Add Properties = property.create | ");
    expect(form).not.toContain("disclosure.none");
    expect(form).not.toContain("= unit.view");
    expect(form?.split(" -- ")[1]?.replace(/\s+/g, " ")).toBe(
      "Each member of East will hold it, and so will anyone added to the group later. It never widens which " +
        'Properties they reach. "Add Properties" is never in effect for a Viewer or Billing member. Whoever holds ' +
        "\"Change members' roles and permissions, and groups' permissions\" must use two-step sign-in. Whatever a " +
        "group gives, only an Owner or Admin can act on other members.",
    );
    const summary = `summary[aria-label="Give East a permission…"]`;
    expect(screen.getByText("Give a permission…", { selector: summary })).toBeTruthy();
    expect(document.querySelectorAll("details[open]")).toHaveLength(0);
  });

  it("says only what applies to what may be given", async () => {
    await signInAs("ADMIN");
    const groupsShown = [shownGroup({ id: "grp_1", name: "East", givable: ["video.view", "unit.view"] })];
    overview.value = { overview: () => Promise.resolve({ groups: groupsShown, mayManage: true }) };
    await renderGroups();
    expect(giveForm("East")?.split(" -- ")[1]?.replace(/\s+/g, " ")).toBe(
      "Each member of East will hold it, and so will anyone added to the group later. It never widens which " +
        "Properties they reach.",
    );
  });

  it("offers an admin no change of what a group with an owner gives, nor deleting it once it gives any", async () => {
    const creatorId = await joined("Sora Creator", "CREATOR");
    await group("Owners", [ownerId, creatorId], ["unit.view"]);
    await signInAs("ADMIN");
    await renderGroups();
    expect(giveForm("Owners")).toBeNull();
    expect(takeBackForms("Owners")).toEqual([]);
    expect(deleteForm("Owners")).toBeNull();
    // The admin holds what the group gives, so it may still remove the creator.
    expect(removeForm("Sora Creator (sora.creator@example.com)", "Owners")).not.toBeNull();
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
    [{ notice: "group-member-added" }, "status", "The member is in the group."],
    [
      { notice: "group-member-removed" },
      "status",
      "The member was removed from the group. They stay in the organization with their role.",
    ],
    [{ error: "group-member-gone" }, "alert", "That person is no longer a member of this organization."],
    [{ error: "group-members-changed" }, "alert", "That group or member changed meanwhile. Check below and try again."],
    [{ error: "not-in-group" }, "alert", "That member is no longer in this group."],
    [{ error: "may-not-add-group-member" }, "alert", "You cannot add that member to this group."],
    [{ error: "add-group-member-failed" }, "alert", `${WENT_WRONG} Check below whether the member was added.`],
    [{ error: "may-not-remove-group-member" }, "alert", "You cannot remove that member from this group."],
    [{ error: "remove-group-member-failed" }, "alert", `${WENT_WRONG} Check below whether the member was removed.`],
    [{ notice: "group-permission-granted" }, "status", "The group gives that permission now, to each of its members."],
    [
      { notice: "group-permission-revoked" },
      "status",
      "The group no longer gives that permission. A member keeps it only if their role, an individual grant or " +
        "another group gives it.",
    ],
    [{ error: "group-permission" }, "alert", "That permission cannot be given to a group or taken back here."],
    [{ error: "may-not-grant-group-permission" }, "alert", "You cannot give that permission to this group."],
    [{ error: "may-not-revoke-group-permission" }, "alert", "You cannot take that permission back from this group."],
    [
      { error: "group-permission-not-granted" },
      "alert",
      "The group does not give that permission, so there was nothing to take back.",
    ],
    [
      { error: "grant-group-permission-failed" },
      "alert",
      `${WENT_WRONG} Check below whether the group gives that permission.`,
    ],
    [
      { error: "revoke-group-permission-failed" },
      "alert",
      `${WENT_WRONG} Check below whether the group still gives that permission.`,
    ],
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
