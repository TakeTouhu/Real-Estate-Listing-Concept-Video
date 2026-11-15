// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { Property, PropertyAssignmentChoices } from "@app/domain";

/**
 * The Property page's assignment (AT-10a, ADR-0144): an `OWNER` or `ADMIN`
 * sees the responsible user and group and a closed form that changes them,
 * carrying the assignment shown; anyone else sees neither. The page says what
 * a fixed code in its address names, and nothing else. The services are
 * stubbed: what they decide is tested with them and through the route.
 */
const ORG = "org_kanda";
const PROPERTY = "prp_harbor";

const choices = vi.hoisted(() => ({ value: null as PropertyAssignmentChoices | null }));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect ${path}`);
  },
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: () => Promise.resolve({ user: { id: "usr_viewer" } }) }));
vi.mock("@/lib/identity", () => ({
  getIdentityServices: () => ({
    organizations: { listForUser: () => Promise.resolve([{ organization: { id: ORG, name: "Studio Kanda" } }]) },
  }),
}));
vi.mock("@/lib/property", () => ({
  getPropertyServices: () => ({
    properties: {
      get: (_actor: string, _org: string, propertyId: string) =>
        Promise.resolve({ id: propertyId, name: "Harbor View", propertyType: "APARTMENT" } as Property),
      assignmentChoices: () => Promise.resolve(choices.value),
    },
    assets: { list: () => Promise.resolve([]), countsTowardLimit: () => false },
  }),
}));
vi.mock("./upload-panel", () => ({ UploadPanel: () => null }));

const { default: PropertyPage } = await import("./page");

const ASSIGNED: PropertyAssignmentChoices = {
  responsibleUserId: "usr_sora",
  groupId: "grp_east",
  members: [
    { userId: "usr_aiko", name: "Aiko Owner", email: "owner@example.com", role: "OWNER" },
    { userId: "usr_sora", name: "Sora Creator", email: "sora@example.com", role: "CREATOR" },
  ],
  groups: [
    { id: "grp_east", name: "East office" },
    { id: "grp_west", name: "West office" },
  ],
};

beforeEach(() => {
  choices.value = ASSIGNED;
});

afterEach(() => {
  cleanup();
});

async function show(query: Record<string, string | string[]> = {}, propertyId = PROPERTY): Promise<void> {
  const page = (await PropertyPage({
    params: Promise.resolve({ propertyId }),
    searchParams: Promise.resolve(query),
  })) as ReactElement;
  render(page);
}

/** The assignment form: where it posts, the assignment it carries as shown, and each list's choice and options. */
function assignmentForm(): string | null {
  const button = screen.queryByRole("button", { name: "Save assignment" });
  if (button === null) return null;
  const form = button.closest("form")!;
  const hidden = [...form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map(
    ({ name, value }) => `${name}=${value}`,
  );
  const lists = [...form.querySelectorAll("select")].map((list) => {
    const label = form.querySelector(`label[for="${list.id}"]`)?.textContent;
    const options = [...list.options].map(({ value, textContent }) => `${textContent} = ${value}`);
    return `${label} [${list.name}: ${list.value}] ${options.join(" | ")}`;
  });
  return [`${form.getAttribute("method")} ${form.getAttribute("action")}`, ...hidden, ...lists].join("\n");
}

describe("the Property page's assignment", () => {
  it("shows an owner or admin the assignment, and a closed form that carries it as shown", async () => {
    await show();
    expect(screen.getByRole("heading", { name: "Assignment" })).toBeTruthy();
    expect(screen.getByText("Responsible user: Sora Creator · sora@example.com · Creator")).toBeTruthy();
    expect(screen.getByText("Group: East office")).toBeTruthy();
    expect(screen.getByText("Change assignment…", { selector: "summary" })).toBeTruthy();
    expect(document.querySelectorAll("details[open]")).toHaveLength(0);
    expect(assignmentForm()).toBe(
      [
        `post /api/organizations/${ORG}/properties/${PROPERTY}/assignment`,
        "shownResponsibleUserId=usr_sora",
        "shownGroupId=grp_east",
        "Responsible user [responsibleUserId: usr_sora] None =  | " +
          "Aiko Owner · owner@example.com · Owner = usr_aiko | " +
          "Sora Creator · sora@example.com · Creator = usr_sora",
        "Group [groupId: grp_east] None =  | East office = grp_east | West office = grp_west",
      ].join("\n"),
    );
  });

  it("says none for an unset assignment, and the form carries none as shown", async () => {
    choices.value = { ...ASSIGNED, responsibleUserId: null, groupId: null, members: [], groups: [] };
    await show();
    expect(screen.getByText("Responsible user: None")).toBeTruthy();
    expect(screen.getByText("Group: None")).toBeTruthy();
    expect(assignmentForm()).toBe(
      [
        `post /api/organizations/${ORG}/properties/${PROPERTY}/assignment`,
        "shownResponsibleUserId=",
        "shownGroupId=",
        "Responsible user [responsibleUserId: ] None = ",
        "Group [groupId: ] None = ",
      ].join("\n"),
    );
  });

  it("names a member without an address by name and role", async () => {
    choices.value = {
      ...ASSIGNED,
      members: [{ userId: "usr_sora", name: "Sora Creator", email: null, role: "CREATOR" }],
    };
    await show();
    expect(screen.getByText("Responsible user: Sora Creator · Creator")).toBeTruthy();
  });

  it("shows anyone else neither the assignment nor the form", async () => {
    choices.value = null;
    await show();
    expect(screen.getByRole("heading", { name: "Harbor View" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Assignment" })).toBeNull();
    expect(assignmentForm()).toBeNull();
  });

  it("encodes the Property's id in the form's address", async () => {
    await show({}, "prp a/b");
    expect(assignmentForm()?.split("\n")[0]).toBe(`post /api/organizations/${ORG}/properties/prp%20a%2Fb/assignment`);
  });

  it.each([
    ["notice", "assignment-saved", "status", "The responsible user and group were saved."],
    ["notice", "assignment-unchanged", "status", "Nothing changed: that is the Property's assignment already."],
    ["error", "property-gone", "alert", "That Property no longer exists."],
    [
      "error",
      "responsible-user-gone",
      "alert",
      "That person can no longer be made responsible: they left the organization or now handle its billing.",
    ],
    ["error", "assignment-group-gone", "alert", "That group no longer exists."],
    [
      "error",
      "assignment-changed",
      "alert",
      "Someone changed this Property's assignment meanwhile. Check it below and try again.",
    ],
    [
      "error",
      "may-not-assign",
      "alert",
      "Only an Owner or an Admin can change a Property's responsible user and group.",
    ],
    ["error", "assign-failed", "alert", "Something went wrong. Check below whether the assignment was saved."],
  ] as const)("says what %s=%s names", async (key, code, role, sentence) => {
    await show({ [key]: code });
    expect(screen.getByRole(role).textContent).toBe(sentence);
  });

  it.each([
    ["an unknown code", { error: "<b>Stolen</b>" }],
    ["a name every object inherits", { notice: "constructor" }],
    ["a repeated code", { notice: ["assignment-saved", "assignment-saved"] }],
  ])("says nothing for %s", async (_what, query) => {
    await show(query);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
