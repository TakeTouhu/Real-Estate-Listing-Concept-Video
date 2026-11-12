// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import {
  AuthService,
  MembersOverviewService,
  MfaService,
  OrganizationService,
  createMfaSecretCipher,
  systemMfaRandom,
  totpStep,
  type Role,
} from "@app/domain";
import { InMemoryUnitsReader, createTestDeps, markEmailVerified, type TestDeps } from "@app/domain/testing";
import { AppError, hotp } from "@app/shared";

/**
 * The members page (AT-5, ADR-0134): a holder of `member.view` sees the seats,
 * the members and the pending invitations; anyone else is refused alike. The
 * dashboard links each organization to it. A holder of `member.manage` invites
 * with the roles it may assign and cancels those roles' invitations, and the
 * page says what a fixed code in its address names, and nothing else (AT-6b,
 * ADR-0136). A holder of `permission.manage` gives other members the roles its
 * ceiling allows (AT-8a, ADR-0139).
 */
const PASSWORD = "password-123456";
const KEY = "55".repeat(32);

const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));
const members = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("next/headers", () => ({
  // The session cookie only: an invitation waiting in the browser is another cookie (ADR-0138).
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
vi.mock("@/lib/members", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/members")>()),
  getMembersOverviewService: () => members.value,
}));
vi.mock("@/lib/property", () => ({ getPropertyServices: () => ({ properties: { list: () => Promise.resolve([]) } }) }));

const { default: MembersPage } = await import("./page");
const { default: DashboardPage } = await import("../../../page");

const iso = (value: string) => new Date(value);

let deps: TestDeps;
let auth: AuthService;
let reader: InMemoryUnitsReader;
let orgId: string;
let ownerId: string;

beforeEach(async () => {
  deps = createTestDeps();
  deps.clock.set(iso("2026-11-10T03:00:00.000Z"));
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const organizations = new OrganizationService(deps);
  identity.value = { deps, auth, organizations };
  reader = new InMemoryUnitsReader();
  members.value = new MembersOverviewService({ identity: deps, subscriptions: reader });
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

/** Sign in a new user, as a member holding `role` or as no member at all, with MFA set up. */
async function signInAs(role: Role | null): Promise<void> {
  const email = `ken.${(role ?? "outsider").toLowerCase()}@example.com`;
  const userId = (await auth.register({ email, name: `Ken ${role ?? "Outsider"}`, password: PASSWORD })).id;
  markEmailVerified(deps, userId);
  if (role !== null) await deps.repos.memberships.create({ organizationId: orgId, userId, role });
  const { token, session } = await auth.login(email, PASSWORD);
  const mfa = new MfaService({ ...deps, cipher: createMfaSecretCipher(KEY), random: systemMfaRandom });
  const { secret } = await mfa.beginSetup(session);
  await mfa.confirmSetup(session, hotp(decodeBase32(secret), totpStep(deps.clock.now())));
  cookie.value = token;
}

type Query = Record<string, string | string[]>;

async function renderMembers(role: Role | null, query: Query = {}): Promise<string> {
  await signInAs(role);
  const { container } = render(
    (await MembersPage({
      params: Promise.resolve({ organizationId: orgId }),
      searchParams: Promise.resolve(query),
    })) as ReactElement,
  );
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

function invited(id: string, email: string, role: Role): void {
  deps.repos.invitations.put({
    id,
    organizationId: orgId,
    email,
    role,
    tokenHash: `hash:${id}`,
    status: "PENDING",
    invitedByUserId: ownerId,
    expiresAt: iso("2026-11-17T03:00:00.000Z"),
    acceptedAt: null,
    createdAt: iso("2026-11-10T03:00:00.000Z"),
  });
}

/** The role options the invite form offers, by their names. */
function offeredRoles(): (string | null)[] {
  const select = screen.getByLabelText("Role");
  return [...select.querySelectorAll("option:not([disabled])")].map((option) => option.textContent);
}

/** The addresses whose invitations have a cancel button, and where each posts. */
function cancelButtons(): string[] {
  return screen
    .queryAllByRole("button", { name: /^Cancel the invitation of / })
    .map((button) => `${button.getAttribute("aria-label")} -> ${button.closest("form")?.getAttribute("action")}`);
}

/** A member of the organization, by name, holding `role`; returns its account's id. */
async function joined(name: string, role: Role): Promise<string> {
  const email = `${name.toLowerCase().replace(" ", ".")}@example.com`;
  const userId = (await auth.register({ email, name, password: PASSWORD })).id;
  await deps.repos.memberships.create({ organizationId: orgId, userId, role });
  return userId;
}

/** Each role form: the member it names, the roles it offers, the role it shows, and where it posts. */
function roleForms(): string[] {
  return screen.queryAllByRole("combobox", { name: /^New role for / }).map((select) => {
    const offered = [...select.querySelectorAll("option:not([disabled])")].map((option) => option.textContent);
    const form = select.closest("form");
    const button = form?.querySelector("button")?.getAttribute("aria-label");
    const from = form?.querySelector<HTMLInputElement>('input[type="hidden"][name="from"]')?.value;
    const action = form?.getAttribute("action");
    return `${select.getAttribute("aria-label")}: ${offered.join(", ")} from ${from} (${button}) -> ${action}`;
  });
}

function subscribe(planKey: "standard" | "premium" | "enterprise"): void {
  reader.subscriptions.set(orgId, {
    id: `sub_${orgId}`,
    organizationId: orgId,
    planKey,
    channel: "SALES_ASSISTED",
    anchorAt: iso("2026-10-15T00:00:00.000Z"),
    commercialReference: "VT-1",
    createdAt: iso("2026-10-01T00:00:00.000Z"),
  });
}

describe("the members page", () => {
  it("sends a signed-out visitor to sign in", async () => {
    cookie.value = undefined;
    await expect(MembersPage({ params: Promise.resolve({ organizationId: orgId }) })).rejects.toThrow(
      "redirect /login",
    );
  });

  it.each([["CREATOR" as const], [null]])("refuses %s alike, without the organization's name", async (role) => {
    subscribe("standard");
    const text = await renderMembers(role);
    expect(screen.getByRole("alert").textContent).toBe("You cannot view this organization's members.");
    expect(text).not.toContain("Studio Kanda");
    expect(text).not.toContain("owner@example.com");
    expect(text).not.toContain("Seats");
  });

  it("does not pass off an unexpected failure as a refusal", async () => {
    await signInAs("OWNER");
    members.value = { overview: () => Promise.reject(new AppError("INTERNAL_ERROR", "unreadable members")) };
    await expect(MembersPage({ params: Promise.resolve({ organizationId: orgId }) })).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });

  it("says when the organization has no plan, and so no seats, yet", async () => {
    const text = await renderMembers("MANAGER");
    expect(text).toContain("Studio Kanda");
    expect(text).toContain(
      "This organization has no plan yet. Its seats come with the plan, which VTaVision sets up when your contract " +
        "starts.",
    );
    expect(text).not.toContain(" taken.");
  });

  it("shows the seats taken, the members and the pending invitations, in Japan time", async () => {
    subscribe("standard");
    invited("inv_1", "new.hire@example.com", "VIEWER");
    deps.clock.set(iso("2026-11-10T05:00:00.000Z"));
    const text = await renderMembers("BILLING");

    expect(text).toContain("3 of 3 taken.");
    expect(text).toContain(
      "Every member takes a seat, the owner included, and so does an invitation until it is accepted or expires.",
    );
    expect(screen.getByRole("heading", { name: "Members (2)" })).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent?.replace(/\s+/g, " "))).toEqual([
      "Aiko Owner · owner@example.com · Owner · joined 10 Nov 2026, 12:00 JST",
      "Ken BILLING (you) · ken.billing@example.com · Billing · joined 10 Nov 2026, 14:00 JST",
      "new.hire@example.com · Viewer · invited 10 Nov 2026, 12:00 JST, expires 17 Nov 2026, 12:00 JST",
    ]);
    expect(screen.getByRole("heading", { name: "Pending invitations (1)" })).toBeTruthy();
  });

  it("says when no invitation is pending", async () => {
    subscribe("premium");
    const text = await renderMembers("ADMIN");
    expect(text).toContain("2 of 10 taken.");
    expect(screen.getByRole("heading", { name: "Pending invitations (0)" })).toBeTruthy();
    expect(text).toContain("No pending invitations.");
  });
});

describe("inviting and cancelling on the members page", () => {
  it("offers an owner every role, and posts the form to the organization's invitations", async () => {
    subscribe("premium");
    const text = await renderMembers("OWNER");
    expect(offeredRoles()).toEqual(["Owner", "Admin", "Manager", "Creator", "Viewer", "Billing"]);
    expect(text).toContain("We email the address a link that works for 7 days.");
    const form = screen.getByRole("button", { name: "Send invitation" }).closest("form");
    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.getAttribute("action")).toBe(`/api/organizations/${orgId}/invitations`);
    expect((screen.getByLabelText("Email address") as HTMLInputElement).required).toBe(true);
    expect((screen.getByLabelText("Role") as HTMLSelectElement).value).toBe("");
  });

  it("offers an admin only the roles below its ceiling, and cancels only those roles' invitations", async () => {
    subscribe("premium");
    invited("inv_admin", "second.admin@example.com", "ADMIN");
    invited("inv_viewer", "viewer@example.com", "VIEWER");
    await renderMembers("ADMIN");
    expect(offeredRoles()).toEqual(["Manager", "Creator", "Viewer"]);
    expect(cancelButtons()).toEqual([
      `Cancel the invitation of viewer@example.com -> /api/organizations/${orgId}/invitations/inv_viewer/cancel`,
    ]);
  });

  it.each([["MANAGER" as const], ["BILLING" as const]])(
    "shows %s neither the form nor a cancel button",
    async (role) => {
      subscribe("premium");
      invited("inv_viewer", "viewer@example.com", "VIEWER");
      const text = await renderMembers(role);
      expect(text).not.toContain("Invite someone");
      expect(screen.queryByRole("button")).toBeNull();
    },
  );

  it("says inviting waits for the plan, without a form", async () => {
    const text = await renderMembers("OWNER");
    expect(screen.getByRole("heading", { name: "Invite someone" })).toBeTruthy();
    expect(text).toContain("You can invite people once the plan is set up.");
    expect(screen.queryByRole("button", { name: "Send invitation" })).toBeNull();
  });

  it("says when every seat is taken, without a form, and still offers to cancel", async () => {
    subscribe("standard");
    invited("inv_viewer", "viewer@example.com", "VIEWER");
    const text = await renderMembers("OWNER");
    expect(text).toContain("3 of 3 taken.");
    expect(screen.getByRole("heading", { name: "Invite someone" })).toBeTruthy();
    expect(text).toContain(
      "Every seat is taken by a member or a pending invitation. Inviting never adds a seat: a member who manages " +
        "billing must buy one, or an invitation can be cancelled.",
    );
    expect(screen.queryByRole("button", { name: "Send invitation" })).toBeNull();
    expect(cancelButtons()).toHaveLength(1);
  });

  it.each([
    [{ notice: "invited" }, "status", "The invitation was sent. Its link works for 7 days."],
    [
      { notice: "cancelled" },
      "status",
      "The invitation was cancelled. Its link no longer works, and its seat is free.",
    ],
    [
      { error: "already-invited" },
      "alert",
      "That email address already has a pending invitation. Cancel it to invite the address again.",
    ],
    [{ error: "gone" }, "alert", "That invitation is no longer pending: it was accepted, cancelled, or it expired."],
  ] as const)("says what %o names", async (query, role, sentence) => {
    subscribe("premium");
    await renderMembers("OWNER", query);
    expect(screen.getByRole(role).textContent).toBe(sentence);
  });

  it.each([
    [{ notice: "<b>hello</b>" }],
    [{ error: "constructor" }],
    [{ notice: ["invited", "cancelled"] }],
    [{ error: ["gone"] }],
  ])("ignores %o, showing nothing it carries", async (query) => {
    subscribe("premium");
    const text = await renderMembers("OWNER", query);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(text).not.toContain("hello");
  });
});

describe("changing a role on the members page", () => {
  it("lets an owner give every other member any other role, but not change its own", async () => {
    const adminId = await joined("Mika Admin", "ADMIN");
    const creatorId = await joined("Sora Creator", "CREATOR");
    const text = await renderMembers("OWNER");
    expect(text).toContain(
      "A member's role decides what they can do and which Properties they reach. Changing it keeps their " +
        "individual permissions, groups and Property assignments. Owners, Admins and Billing members, and anyone " +
        "allowed to manage permissions or billing, must use two-step sign-in. You cannot change your own role here.",
    );
    const members = `/api/organizations/${orgId}/members`;
    expect(roleForms()).toEqual([
      `New role for owner@example.com: Admin, Manager, Creator, Viewer, Billing from OWNER ` +
        `(Change the role of owner@example.com) -> ${members}/${ownerId}/role`,
      `New role for mika.admin@example.com: Owner, Manager, Creator, Viewer, Billing from ADMIN ` +
        `(Change the role of mika.admin@example.com) -> ${members}/${adminId}/role`,
      `New role for sora.creator@example.com: Owner, Admin, Manager, Viewer, Billing from CREATOR ` +
        `(Change the role of sora.creator@example.com) -> ${members}/${creatorId}/role`,
    ]);
    const select = screen.getByRole("combobox", { name: "New role for sora.creator@example.com" });
    expect((select as HTMLSelectElement).value).toBe("");
    expect((select as HTMLSelectElement).required).toBe(true);
    expect(select.closest("form")?.getAttribute("method")).toBe("post");
    expect(screen.queryByRole("combobox", { name: "New role for ken.owner@example.com" })).toBeNull();
  });

  it("lets an admin move only the members below its ceiling, among those roles", async () => {
    await joined("Mika Admin", "ADMIN");
    const managerId = await joined("Ren Manager", "MANAGER");
    const viewerId = await joined("Yui Viewer", "VIEWER");
    await joined("Kai Billing", "BILLING");
    await renderMembers("ADMIN");
    const members = `/api/organizations/${orgId}/members`;
    expect(roleForms()).toEqual([
      `New role for ren.manager@example.com: Creator, Viewer from MANAGER ` +
        `(Change the role of ren.manager@example.com) -> ${members}/${managerId}/role`,
      `New role for yui.viewer@example.com: Manager, Creator from VIEWER ` +
        `(Change the role of yui.viewer@example.com) -> ${members}/${viewerId}/role`,
    ]);
  });

  it.each([["MANAGER" as const], ["BILLING" as const]])("gives %s no role form, and no word of one", async (role) => {
    await joined("Sora Creator", "CREATOR");
    const text = await renderMembers(role);
    expect(roleForms()).toEqual([]);
    expect(text).not.toContain("Changing it keeps");
  });

  it.each([
    [
      { notice: "role-changed" },
      "status",
      "The member's role was changed. What they can do, and which Properties they reach, follow the new role now.",
    ],
    [{ error: "new-role" }, "alert", "Choose the member's new role."],
    [{ error: "may-not-change-role" }, "alert", "You cannot give that member that role."],
    [{ error: "not-a-member" }, "alert", "That person is not a member of this organization."],
    [{ error: "last-owner" }, "alert", "The organization must keep an Owner. Make another member an Owner first."],
    [
      { error: "member-changed" },
      "alert",
      "That member's role changed meanwhile. Check it below, and change it again if you still need to.",
    ],
    [{ error: "role-change-failed" }, "alert", "Something went wrong. Check below whether the member's role changed."],
  ] as const)("says what %o names", async (query, role, sentence) => {
    await renderMembers("OWNER", query);
    expect(screen.getByRole(role).textContent).toBe(sentence);
  });
});

describe("the dashboard", () => {
  it("links each organization to its members page", async () => {
    await signInAs("MANAGER");
    render((await DashboardPage({ searchParams: Promise.resolve({}) })) as ReactElement);
    expect(screen.getByRole("link", { name: "Members" }).getAttribute("href")).toBe(`/organizations/${orgId}/members`);
  });
});
