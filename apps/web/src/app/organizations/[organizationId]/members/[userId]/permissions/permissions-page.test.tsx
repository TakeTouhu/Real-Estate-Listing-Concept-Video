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
 * it comes from, in words; anyone else is refused alike. The identity
 * services run for real, on in-memory repositories, except where a test sets
 * the sources it words.
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
vi.mock("@/lib/member-permissions", () => ({ getMemberPermissionsService: () => permissions.value }));

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

const page = (userId: string) =>
  PermissionsPage({ params: Promise.resolve({ organizationId: orgId, userId }) }) as Promise<ReactElement>;

/** Render, as `viewer`, the permissions page of the member `userId`. */
async function renderAs(viewer: Role | "outsider", userId: string): Promise<void> {
  await signIn(viewer.toLowerCase());
  render(await page(userId));
}

/** Each permission's line, by its key. */
function lines(): Map<string, string> {
  return new Map(
    screen.getAllByRole("listitem").map((item) => {
      const text = (item.textContent ?? "").replace(/\s+/g, " ");
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
      "Change members' roles and permissions (permission.manage): Yes, from their role.",
    );
    expect(shown.get("billing.manage")).toBe("Buy Units and manage billing (billing.manage): No.");
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
        "Yes, from an individual grant and the groups East and West.",
    );
    expect(shown.get("property.view")).toBe(
      "See Properties (property.view): Yes, from their role, an individual grant and the group East.",
    );
    cleanup();
    await answering("OWNER", ids.VIEWER, { "property.create": { groupCount: 1, groupNames: ["East"] } });
    render(await page(ids.VIEWER));
    expect(lines().get("property.create")).toBe(
      "Add Properties (property.create): " +
        "No, although it comes from the group East: it is never in effect for a Viewer.",
    );
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
