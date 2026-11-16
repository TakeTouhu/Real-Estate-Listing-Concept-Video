// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import {
  AuthService,
  GRANTABLE_PERMISSIONS,
  MemberPermissionsService,
  MfaService,
  OrganizationService,
  PermissionGrantService,
  createMfaSecretCipher,
  systemMfaRandom,
  totpStep,
  type MemberPermission,
  type Permission,
  type Role,
} from "@app/domain";
import { createTestDeps, markEmailVerified, type TestDeps } from "@app/domain/testing";
import { AppError, hotp } from "@app/shared";

/**
 * A member's permissions page (AT-11a, ADR-0146): a holder of `member.view`
 * sees every permission a member can hold, whether it is in effect and where
 * it comes from, in words; anyone else is refused alike. A viewer the grant
 * ceiling allows is offered to give what the member cannot do yet and to take
 * back what was given individually (AT-11b, ADR-0147). The identity services
 * run for real, on in-memory repositories, except where a test sets the
 * sources it words.
 */
const PASSWORD = "password-123456";
const KEY = "4d".repeat(32);

const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));
const permissions = vi.hoisted(() => ({ value: null as unknown }));

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
vi.mock("@/lib/member-permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/member-permissions")>()),
  getMemberPermissionsService: () => permissions.value,
}));

const { default: PermissionsPage } = await import("./page");

let deps: TestDeps;
let auth: AuthService;
let orgId: string;
let ids: Record<Role | "outsider", string>;

beforeEach(async () => {
  deps = createTestDeps();
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const organizations = new OrganizationService(deps);
  identity.value = { deps, auth, organizations };
  permissions.value = new MemberPermissionsService(deps);
  env.value = { NODE_ENV: "test", MFA_SECRET_KEY: KEY };
  const ownerId = await register("owner");
  ({ organization: { id: orgId } } = await organizations.createOrganization(ownerId, { name: "Studio Kanda" }));
  ids = { OWNER: ownerId } as Record<Role | "outsider", string>;
  for (const role of ["ADMIN", "MANAGER", "CREATOR", "VIEWER", "BILLING"] as const) {
    ids[role] = await register(role.toLowerCase());
    await deps.repos.memberships.create({ organizationId: orgId, userId: ids[role], role });
  }
  ids.outsider = await register("outsider");
});

afterEach(cleanup);

async function register(name: string): Promise<string> {
  const userId = (await auth.register({ email: `${name}@example.com`, name: `${name} san`, password: PASSWORD })).id;
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
  const mfa = new MfaService({ ...deps, cipher: createMfaSecretCipher(KEY), random: systemMfaRandom });
  const { secret } = await mfa.beginSetup(session);
  await mfa.confirmSetup(session, hotp(decodeBase32(secret), totpStep(deps.clock.now())));
  cookie.value = token;
}

const page = (userId: string, query: Record<string, string> = {}) =>
  PermissionsPage({
    params: Promise.resolve({ organizationId: orgId, userId }),
    searchParams: Promise.resolve(query),
  }) as Promise<ReactElement>;

/** Render, as `viewer`, the permissions page of the member `userId`. */
async function renderAs(viewer: Role | "outsider", userId: string): Promise<void> {
  await signIn(viewer.toLowerCase());
  render(await page(userId));
}

/** Each permission's line, by its key, without its forms. */
function lines(): Map<string, string> {
  return new Map(
    screen.getAllByRole("listitem").map((item) => {
      const line = item.cloneNode(true) as HTMLElement;
      line.querySelectorAll("form").forEach((form) => form.remove());
      const text = (line.textContent ?? "").replace(/\s+/g, " ");
      return [/\(([a-z.]+)\)/.exec(text)?.[1] ?? "", text];
    }),
  );
}

/**
 * Have the service answer, once, what `viewer` sees of `memberId` with
 * `sources` over its rows. Where each source comes from is the domain's to
 * work out, and its own test's to prove; this page only words it.
 */
async function answering(
  viewer: Role,
  memberId: string,
  sources: Partial<Record<Permission, Partial<MemberPermission>>>,
): Promise<void> {
  const service = permissions.value as MemberPermissionsService;
  const view = await service.view(ids[viewer], orgId, memberId);
  vi.spyOn(service, "view").mockResolvedValueOnce({
    ...view,
    permissions: view.permissions.map((row) => ({ ...row, ...sources[row.permission] })),
  });
}

describe("a member's permissions page", () => {
  it("names the member and says what their role gives, area by area", async () => {
    await renderAs("OWNER", ids.ADMIN);
    expect(screen.getByRole("heading", { level: 1, name: "Permissions" })).toBeTruthy();
    expect(screen.getByText("Studio Kanda")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "admin san" })).toBeTruthy();
    expect(screen.getByText("admin@example.com · Admin")).toBeTruthy();
    expect(screen.getByText(/apply to every Property of the organization, which their role decides\.$/)).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map(({ textContent }) => textContent)).toEqual([
      "admin san",
      "Organization and team",
      "Properties and photos",
      "Videos",
      "Units and billing",
      "Audit log",
    ]);
    const shown = lines();
    expect(shown.get("permission.manage")).toBe(
      "Change members' roles and permissions, and groups' permissions (permission.manage): Yes, from their role.",
    );
    expect(shown.get("member.manage")).toBe("Invite and remove members (member.manage): Yes, from their role.");
    expect(shown.get("billing.manage")).toBe("Buy Units (billing.manage): No.");
    expect(shown.get("audit.view")).toBe(
      "See the audit log (audit.view): Yes, from their role. Nothing in VTaVision uses it yet.",
    );
    expect(screen.getByRole("link", { name: "Back to members" }).getAttribute("href")).toBe(
      `/organizations/${orgId}/members`,
    );
  });

  it("lists every permission a member can hold once, in order, and marks those nothing uses yet", async () => {
    await renderAs("OWNER", ids.OWNER);
    const shown = lines();
    expect([...shown.keys()]).toEqual(GRANTABLE_PERMISSIONS);
    expect(screen.getAllByRole("listitem")).toHaveLength(GRANTABLE_PERMISSIONS.length);
    const areas = [...document.querySelectorAll(".card")].slice(1).map((card) => [
      card.querySelector("h2")?.textContent,
      [...card.querySelectorAll("li")].map((item) => /\(([a-z.]+)\)/.exec(item.textContent ?? "")?.[1]),
    ]);
    expect(areas.map(([title, keys]) => `${title}: ${(keys as string[]).join(" ")}`)).toEqual([
      "Organization and team: organization.view organization.manage member.view member.manage group.view " +
        "group.manage permission.manage",
      "Properties and photos: property.view property.create property.edit property.delete asset.upload " +
        "asset.delete analysis.review",
      "Videos: video.view video.generate video.regenerate video.download disclosure.change disclosure.none",
      "Units and billing: unit.consume unit.view billing.view billing.manage",
      "Audit log: audit.view audit.export",
    ]);
    expect([...shown].filter(([, text]) => text.endsWith("Nothing in VTaVision uses it yet.")).map(([key]) => key))
      .toEqual([
        "organization.view",
        "organization.manage",
        "video.regenerate",
        "disclosure.change",
        "disclosure.none",
        "audit.view",
        "audit.export",
      ]);
  });

  it("marks the viewer's own page, and says which Properties each role reaches", async () => {
    await renderAs("MANAGER", ids.MANAGER);
    expect(screen.getByRole("heading", { level: 2, name: "manager san (you)" })).toBeTruthy();
    expect(screen.getByText(/apply to the Properties of the groups they belong to, which their role/)).toBeTruthy();
    cleanup();
    render(await page(ids.CREATOR));
    expect(screen.getByText(/apply to the Properties they are responsible for, which their role/)).toBeTruthy();
  });

  it("words a permission from the role, an individual grant and the groups, naming the groups", async () => {
    await answering("OWNER", ids.CREATOR, {
      "member.view": { effective: true, granted: true, groupCount: 2, groupNames: ["East", "West"] },
      "property.view": { granted: true, groupCount: 1, groupNames: ["East"] },
    });
    await renderAs("OWNER", ids.CREATOR);
    const shown = lines();
    expect(shown.get("member.view")).toBe(
      "See the members and their permissions (member.view): " +
        'Yes, from an individual grant and the groups "East" and "West".',
    );
    expect(shown.get("property.view")).toBe(
      "See Properties, their photos and the photos' analysis (property.view): " +
        'Yes, from their role, an individual grant and the group "East".',
    );
    cleanup();
    await answering("OWNER", ids.VIEWER, { "property.create": { groupCount: 1, groupNames: ["East"] } });
    render(await page(ids.VIEWER));
    expect(lines().get("property.create")).toBe(
      "Add Properties (property.create): " +
        'No, although it comes from the group "East": it is never in effect for a Viewer member.',
    );
    cleanup();
    await answering("OWNER", ids.BILLING, { "property.create": { groupCount: 2, groupNames: ["East", "West"] } });
    render(await page(ids.BILLING));
    expect(lines().get("property.create")).toBe(
      "Add Properties (property.create): " +
        'No, although it comes from the groups "East" and "West": it is never in effect for a Billing member.',
    );
  });

  it("says only an Owner's or Admin's role lets team permissions reach another member", async () => {
    const held = { effective: true, granted: true };
    const team = { "member.manage": held, "group.manage": held, "permission.manage": held };
    await answering("OWNER", ids.MANAGER, team);
    await renderAs("OWNER", ids.MANAGER);
    const shown = lines();
    expect(shown.get("member.manage")).toBe(
      "Invite and remove members (member.manage): Yes, from an individual grant. " +
        "Their role lets them invite or remove no one.",
    );
    expect(shown.get("group.manage")).toMatch(
      /: Yes, from an individual grant\. Their role lets them add no one to a group, nor remove anyone\.$/,
    );
    expect(shown.get("permission.manage")).toMatch(
      /: Yes, from an individual grant\. Their role lets them change no one's role or permissions\.$/,
    );
    expect(shown.get("property.edit")).toMatch(/: Yes, from their role\.$/);
    cleanup();
    render(await page(ids.OWNER));
    expect(lines().get("permission.manage")).toMatch(/: Yes, from their role\.$/);
  });

  it("counts a member's groups without naming them for a viewer without group.view", async () => {
    await answering("BILLING", ids.MANAGER, {
      "audit.view": { effective: true, groupCount: 2 },
      "audit.export": { effective: true, groupCount: 1 },
    });
    await renderAs("BILLING", ids.MANAGER);
    const shown = lines();
    expect(shown.get("audit.view")).toMatch(/: Yes, from 2 of their groups\./);
    expect(shown.get("audit.export")).toMatch(/: Yes, from one of their groups\./);
    expect(shown.get("video.view")).toMatch(/: Yes, from their role\.$/);
  });
});

/** The page's forms, in order: what each posts to, of which permission. */
function changes(): string[] {
  return [...document.querySelectorAll("li form")].map((form) => {
    const permission = form.querySelector<HTMLInputElement>('input[type="hidden"][name="permission"]')?.value;
    return `${form.getAttribute("action")?.split("/").at(-1)} ${permission}`;
  });
}

describe("giving and taking back individual permissions (AT-11b, ADR-0147)", () => {
  it("offers an Owner to give what the member cannot do yet, and to take back what was given", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.MANAGER, "audit.view");
    await renderAs("OWNER", ids.MANAGER);
    expect(changes()).toEqual([
      "grant organization.manage",
      "grant member.manage",
      "grant group.manage",
      "grant permission.manage",
      "grant billing.view",
      "grant billing.manage",
      "revoke audit.view",
      "grant audit.export",
    ]);
    const forms = [...document.querySelectorAll("li form")];
    expect(new Set(forms.map((form) => form.getAttribute("method")))).toEqual(new Set(["post"]));
    expect(forms[0]?.getAttribute("action")).toBe(
      `/api/organizations/${orgId}/members/${ids.MANAGER}/permissions/grant`,
    );
    expect(forms[6]?.getAttribute("action")).toBe(
      `/api/organizations/${orgId}/members/${ids.MANAGER}/permissions/revoke`,
    );
    expect(screen.getByRole("button", { name: "Give manager@example.com the permission: Buy Units" }).textContent).toBe(
      "Give",
    );
    expect(
      screen.getByRole("button", { name: "Take back from manager@example.com the permission: See the audit log" })
        .textContent,
    ).toBe("Take back");
    expect(screen.getByText(/^You can give them a permission they do not have, or take back one given/)).toBeTruthy();
  });

  it("says what holding a permission brings, and what the member's role still keeps them from", async () => {
    await renderAs("OWNER", ids.MANAGER);
    const said = (permission: string) =>
      document.querySelector(`form:has(input[value="${permission}"])`)?.textContent?.replace(/\s+/g, " ");
    expect(said("permission.manage")).toBe(
      "Whoever holds it must use two-step sign-in. Their role lets them change no one's role or permissions. Give",
    );
    expect(said("billing.manage")).toBe("Whoever holds it must use two-step sign-in. Give");
    expect(said("member.manage")).toBe("Their role lets them invite or remove no one. Give");
    expect(said("billing.view")).toBe("Give");
    // A screen reader reads the notes with the button.
    const describedBy = (label: string) => {
      const id = screen.getByRole("button", { name: `Give manager@example.com the permission: ${label}` })
        .getAttribute("aria-describedby");
      return id === null ? null : document.getElementById(id)?.textContent?.trim();
    };
    expect(describedBy("Buy Units")).toBe("Whoever holds it must use two-step sign-in.");
    expect(describedBy("Invite and remove members")).toBe("Their role lets them invite or remove no one.");
    expect(describedBy("See the plan's billing details on the Units page")).toBeNull();
  });

  it("offers an Admin only what the ceiling allows it, and nothing at all for an Owner", async () => {
    await renderAs("ADMIN", ids.CREATOR);
    expect(changes()).toEqual(
      [
        "organization.manage",
        "member.view",
        "member.manage",
        "group.view",
        "group.manage",
        "billing.view",
        "audit.view",
        "audit.export",
      ].map((permission) => `grant ${permission}`),
    );
    cleanup();
    render(await page(ids.OWNER));
    expect(changes()).toEqual([]);
    expect(screen.queryByText(/^You can give them/)).toBeNull();
  });

  it("offers nothing to a viewer without permission.manage, nor on the viewer's own page as an Admin", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.MANAGER, "audit.view");
    await renderAs("BILLING", ids.MANAGER);
    expect(changes()).toEqual([]);
    cleanup();
    await renderAs("ADMIN", ids.ADMIN);
    expect(changes()).toEqual([]);
  });

  it("never offers to give disclosure.none, yet offers to take back a grant of it", async () => {
    await renderAs("OWNER", ids.ADMIN);
    expect(changes()).toEqual(["grant billing.manage"]);
    cleanup();
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.ADMIN, "disclosure.none");
    render(await page(ids.ADMIN));
    expect(changes()).toEqual(["revoke disclosure.none", "grant billing.manage"]);
  });

  it("offers an Owner only to take back its own individual grant, and says what giving does", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.OWNER, "disclosure.none");
    await renderAs("OWNER", ids.OWNER);
    expect(changes()).toEqual(["revoke disclosure.none"]);
    expect(screen.getByText(/^You can give them a permission they do not have, or take back one given/)).toBeTruthy();
  });

  it("says what a route sent back, and nothing for a code it does not know", async () => {
    await signIn("owner");
    render(await page(ids.CREATOR, { notice: "granted" }));
    expect(screen.getByRole("status").textContent).toBe(
      "The permission was given to them individually. What they can do now is shown below.",
    );
    cleanup();
    render(await page(ids.CREATOR, { error: "not-granted" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "They do not hold that permission individually, so there was nothing to take back.",
    );
    cleanup();
    render(await page(ids.CREATOR, { notice: "constructor", error: "role-changed" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("who may open a member's permissions page", () => {
  it.each(["CREATOR", "outsider"] as const)("refuses a %s, without the organization's name", async (viewer) => {
    await renderAs(viewer, ids.OWNER);
    expect(screen.getByRole("alert").textContent).toBe("You cannot view this organization's members.");
    expect(screen.getByRole("link", { name: "Back to organizations" }).getAttribute("href")).toBe("/");
    expect(screen.queryByText("Studio Kanda")).toBeNull();
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("says when the person is no member, and leads back to the members", async () => {
    await renderAs("OWNER", ids.outsider);
    expect(screen.getByRole("alert").textContent).toBe("That person is not a member of this organization.");
    expect(screen.getByRole("link", { name: "Back to members" }).getAttribute("href")).toBe(
      `/organizations/${orgId}/members`,
    );
    expect(screen.queryByText("outsider@example.com")).toBeNull();
  });

  it("still fails on an error that is not a refusal", async () => {
    vi.spyOn(permissions.value as MemberPermissionsService, "view").mockRejectedValueOnce(
      new AppError("INTERNAL_ERROR", "Lost"),
    );
    await signIn("owner");
    await expect(page(ids.ADMIN)).rejects.toThrow("Lost");
  });

  it("sends a signed-out visitor to sign in", async () => {
    cookie.value = undefined;
    await expect(page(ids.ADMIN)).rejects.toThrow("redirect /login");
  });
});
