// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { AuthService, OrganizationService, type InvitationStatus, type Role } from "@app/domain";
import { InMemoryUnitsReader, createTestDeps, markEmailVerified, type TestDeps } from "@app/domain/testing";

/**
 * The invitation page (AT-7b, ADR-0138): opened from its link, it shows what
 * the invitation offers and asks for one press, never naming the invited
 * address; without a token, it shows the invitation waiting in the browser
 * once the sign-in is complete, and says why accepting was refused. The
 * organizations page sends a sign-in to a waiting invitation and names the
 * organization joined; the sign-in page says an invitation waits. The
 * session gate and the domain services run for real over in-memory
 * repositories; invitations are stored as inviting keeps them, so no test
 * here invites, accepts or cancels through the service.
 */
const PASSWORD = "password-123456";
const WAITING = "rev_invitation";

class Redirect extends Error {}

const jar = vi.hoisted(() => ({ value: {} as Record<string, string> }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));
const subscriptions = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({ get: (name: string) => (name in jar.value ? { value: jar.value[name] } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Redirect(path);
  },
}));
vi.mock("@/lib/env", () => ({ getServerEnv: () => env.value }));
vi.mock("@/lib/identity", () => ({ getIdentityServices: () => identity.value }));
vi.mock("@/lib/property", () => ({ getPropertyServices: () => ({ properties: { list: () => Promise.resolve([]) } }) }));
vi.mock("@app/database", () => ({
  createSubscriptionRepository: () => subscriptions.value,
  getPrismaClient: () => ({}),
}));

const { default: AcceptInvitationPage } = await import("./accept-invitation/page");
const { default: DashboardPage } = await import("./page");
const { default: LoginPage } = await import("./login/page");

let deps: TestDeps;
let auth: AuthService;
let ownerId: string;
let orgId: string;

beforeEach(async () => {
  deps = createTestDeps();
  auth = new AuthService(deps, { sessionTtlSeconds: 86_400 });
  const organizations = new OrganizationService(deps);
  identity.value = { deps, auth, organizations };
  subscriptions.value = new InMemoryUnitsReader();
  env.value = { NODE_ENV: "test" };
  jar.value = {};
  ownerId = await register("owner");
  ({ organization: { id: orgId } } = await organizations.createOrganization(ownerId, { name: "Studio Kanda" }));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function register(name: string, verified = true): Promise<string> {
  const userId = (await auth.register({ email: `${name}@example.com`, name, password: PASSWORD })).id;
  if (verified) markEmailVerified(deps, userId);
  return userId;
}

async function signIn(name: string): Promise<void> {
  jar.value["rev_session"] = (await auth.login(`${name}@example.com`, PASSWORD)).token;
}

/** An invitation of `invitee@example.com`, stored as inviting keeps it, for an hour; its token. */
function invite(role: Role = "VIEWER", status: InvitationStatus = "PENDING"): string {
  const token = `tok_${role}_${status}`;
  deps.repos.invitations.put({
    id: `inv_${token}`,
    organizationId: orgId,
    email: "invitee@example.com",
    role,
    tokenHash: deps.tokens.hash(token),
    status,
    invitedByUserId: ownerId,
    expiresAt: new Date(deps.clock.now().getTime() + 3_600_000),
    acceptedAt: null,
    createdAt: deps.clock.now(),
  });
  return token;
}

type Params = { token?: string | string[]; error?: string | string[]; joined?: string };
const search = (params: Params = {}) => ({ searchParams: Promise.resolve(params) });
/** The organizations and sign-in pages' query. */
const query = (params: { error?: string; joined?: string } = {}) => ({ searchParams: Promise.resolve(params) });

async function redirectOf(page: Promise<ReactElement>): Promise<string> {
  const thrown = await page.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(thrown instanceof Redirect)) throw new Error("expected a redirect");
  return thrown.message;
}

const formOf = (button: string) => screen.getByRole("button", { name: button }).closest("form")!;

describe("opened from its link", () => {
  it("shows the offer and asks a browser signed in to nothing to continue, posting the token", async () => {
    const token = invite();
    const { container } = render(await AcceptInvitationPage(search({ token })));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Join Studio Kanda");
    expect(container.textContent).toContain("You are invited to join Studio Kanda on VTaVision as a Viewer.");
    expect(container.textContent).toContain("Sign in, or create an account, with the email address");
    const form = formOf("Continue");
    expect([form.getAttribute("method"), form.getAttribute("action")]).toEqual(["post", "/api/invitations/accept"]);
    expect(form.querySelector<HTMLInputElement>('input[name="token"]')!.value).toBe(token);
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
    expect(container.textContent).not.toContain("invitee@example.com");
  });

  it("asks a complete sign-in to accept, naming its own address, with Not now and Sign out", async () => {
    const token = invite();
    await register("someone");
    await signIn("someone");
    const { container } = render(await AcceptInvitationPage(search({ token })));
    expect(container.textContent).toContain("You are signed in as someone@example.com.");
    expect(formOf("Accept invitation").querySelector<HTMLInputElement>('input[name="token"]')!.value).toBe(token);
    expect(formOf("Not now").getAttribute("action")).toBe("/api/invitations/dismiss");
    expect(formOf("Sign out").getAttribute("action")).toBe("/api/auth/logout");
    expect(container.textContent).not.toContain("invitee@example.com");
  });

  it("asks a sign-in that owes a step to continue, as it does a browser signed in to nothing", async () => {
    const token = invite();
    await register("unverified", false);
    await signIn("unverified");
    render(await AcceptInvitationPage(search({ token })));
    expect(formOf("Continue").querySelector<HTMLInputElement>('input[name="token"]')!.value).toBe(token);
  });

  it("shows no form for a token of no open invitation, one too long, or more than one", async () => {
    const used = ["ACCEPTED", "REVOKED", "EXPIRED"].map((status) => invite("VIEWER", status as InvitationStatus));
    const open = invite();
    deps.clock.set(new Date(deps.clock.now().getTime() + 3_600_000));
    for (const value of [...used, open, "unknown", "x".repeat(129), [open, open]]) {
      render(await AcceptInvitationPage(search({ token: value })));
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Link not valid");
      expect(screen.queryByRole("button")).toBeNull();
      cleanup();
    }
  });
});

describe("the invitation waiting in the browser", () => {
  it("is shown to a complete sign-in with no token in the form, and the refusal it met", async () => {
    jar.value[WAITING] = invite("CREATOR");
    await register("someone");
    await signIn("someone");
    const { container } = render(await AcceptInvitationPage(search({ error: "wrong-account" })));
    expect(screen.getByRole("alert").textContent).toContain("This invitation was sent to another email address.");
    expect(container.textContent).toContain("as a Creator.");
    expect(formOf("Accept invitation").querySelector('input[name="token"]')).toBeNull();
  });

  it("is offered to a sign-in that owes a step only to continue, the token staying in the cookie", async () => {
    jar.value[WAITING] = invite();
    await register("unverified", false);
    await signIn("unverified");
    render(await AcceptInvitationPage(search()));
    expect(formOf("Continue").querySelector('input[name="token"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept invitation" })).toBeNull();
  });

  it("is gone after a refusal that ended it: the page says why, and offers nothing to press", async () => {
    await register("someone");
    await signIn("someone");
    render(await AcceptInvitationPage(search({ error: "expired" })));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Invitation not accepted");
    expect(screen.getByRole("alert").textContent).toBe(
      "This invitation has expired. Ask whoever invited you to invite you again.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says nothing waits, whatever an unknown code in the address says", async () => {
    for (const error of [undefined, "<b>hacked</b>", "toString"]) {
      const { container } = render(await AcceptInvitationPage(search({ error })));
      expect(container.textContent).toContain("No invitation is waiting here.");
      expect(container.textContent).not.toContain("hacked");
      cleanup();
    }
  });
});

describe("the organizations page", () => {
  it("sends a complete sign-in to the invitation waiting, while it is open", async () => {
    await register("someone");
    await signIn("someone");
    jar.value[WAITING] = invite();
    expect(await redirectOf(DashboardPage(query()))).toBe("/accept-invitation");
    const [invitation] = await deps.repos.invitations.listByOrganization(orgId);
    deps.repos.invitations.put({ ...invitation!, status: "REVOKED" });
    render(await DashboardPage(query()));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Organizations");
  });

  it("names the organization joined, and nothing for one the account is not in", async () => {
    const invitee = await register("invitee");
    await deps.repos.memberships.create({ organizationId: orgId, userId: invitee, role: "CREATOR" });
    await signIn("invitee");
    render(await DashboardPage(query({ joined: orgId })));
    expect(screen.getByRole("status").textContent).toBe("You joined Studio Kanda as CREATOR.");
    cleanup();
    render(await DashboardPage(query({ joined: "org_other" })));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

it("tells a browser signed in to nothing that an open invitation waits", async () => {
  render(await LoginPage(query()));
  expect(screen.queryByRole("status")).toBeNull();
  cleanup();
  jar.value[WAITING] = invite();
  render(await LoginPage(query()));
  expect(screen.getByRole("status").textContent).toBe(
    "To join Studio Kanda, sign in or create an account with the email address your invitation was sent to.",
  );
});
