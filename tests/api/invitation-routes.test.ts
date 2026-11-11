import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthService,
  MfaService,
  OrganizationService,
  createMfaSecretCipher,
  systemMfaRandom,
  totpStep,
  type Role,
} from "@app/domain";
import { InMemoryUnitsReader, createTestDeps, markEmailVerified, type TestDeps } from "@app/domain/testing";
import { hotp } from "@app/shared";
import { readDevelopmentEmailOutbox } from "@app/storage";

/**
 * Route tests for inviting and cancelling from the members page (AT-6b,
 * ADR-0136): a same-origin form post, signed in, reaches the membership
 * service, which decides; the answer is the members page with a fixed code,
 * never the address or the token; the link is mailed on the configured base
 * address. Only the cookie store, the environment, the identity wiring and the
 * subscriptions are stubbed: the session gate, the domain services and the
 * development outbox run for real.
 */
const PASSWORD = "password-123456";
const MFA_KEY = "77".repeat(32);
const BASE = "http://localhost:3210";
const SITE = "https://app.vtavision.test";

const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));
const subscriptions = vi.hoisted(() => ({ value: null as unknown }));

// `next` is installed for the web app only, so its module is named by its resolved path.
const nextHeaders = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  return createRequire(new URL("../../apps/web/package.json", import.meta.url)).resolve("next/headers");
});

vi.mock(nextHeaders, () => ({
  cookies: () => Promise.resolve({ get: () => (cookie.value ? { value: cookie.value } : undefined) }),
}));
vi.mock("@/lib/env", () => ({ getServerEnv: () => env.value }));
vi.mock("@/lib/identity", () => ({ getIdentityServices: () => identity.value }));
vi.mock("@app/database", () => ({
  createSubscriptionRepository: () => subscriptions.value,
  getPrismaClient: () => ({}),
}));

const { POST: invite } = await import("@/app/api/organizations/[organizationId]/invitations/route");
const { POST: cancel } = await import(
  "@/app/api/organizations/[organizationId]/invitations/[invitationId]/cancel/route"
);
const { cancelMemberInvitation, inviteMember } = await import("@/lib/members");

let deps: TestDeps;
let auth: AuthService;
let reader: InMemoryUnitsReader;
let outbox: string;
let orgId: string;

beforeEach(async () => {
  deps = createTestDeps();
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  identity.value = { deps, auth, organizations: new OrganizationService(deps) };
  reader = new InMemoryUnitsReader();
  subscriptions.value = reader;
  outbox = mkdtempSync(join(tmpdir(), "vtavision-outbox-invite-"));
  env.value = {
    NODE_ENV: "test",
    USER_SESSION_TTL_SECONDS: 3600,
    MFA_SECRET_KEY: MFA_KEY,
    EMAIL_OUTBOX_DIR: outbox,
    APP_BASE_URL: BASE,
  };
  const owner = await register("owner");
  ({ organization: { id: orgId } } = await new OrganizationService(deps).createOrganization(owner, {
    name: "Studio Kanda",
  }));
  subscribe();
  await signInAs("OWNER");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  rmSync(outbox, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function register(name: string): Promise<string> {
  const userId = (await auth.register({ email: `${name}@example.com`, name, password: PASSWORD })).id;
  markEmailVerified(deps, userId);
  return userId;
}

function subscribe(planKey: "standard" | "premium" = "standard"): void {
  reader.subscriptions.set(orgId, {
    id: `sub_${orgId}`,
    organizationId: orgId,
    planKey,
    channel: "SALES_ASSISTED",
    anchorAt: new Date("2026-10-15T00:00:00.000Z"),
    commercialReference: "VT-1",
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
  });
}

function decodeBase32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...text].map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

/** Sign in as the owner, or as a new member holding `role`, with MFA set up. */
async function signInAs(role: Role): Promise<void> {
  const email = role === "OWNER" ? "owner@example.com" : `${role.toLowerCase()}@example.com`;
  if (role !== "OWNER") {
    const userId = await register(role.toLowerCase());
    await deps.repos.memberships.create({ organizationId: orgId, userId, role });
  }
  const { token, session } = await auth.login(email, PASSWORD);
  const mfa = new MfaService({ ...deps, cipher: createMfaSecretCipher(MFA_KEY), random: systemMfaRandom });
  const { secret } = await mfa.beginSetup(session);
  await mfa.confirmSetup(session, hotp(decodeBase32(secret), totpStep(deps.clock.now())));
  cookie.value = token;
}

function post(path: string, fields: Record<string, string>, headers: Record<string, string> = { origin: SITE }) {
  return new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { host: "app.vtavision.test", "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

const inviting = (fields: Record<string, string>, headers?: Record<string, string>) =>
  invite(post(`/api/organizations/${orgId}/invitations`, fields, headers), {
    params: Promise.resolve({ organizationId: orgId }),
  });

const cancelling = (invitationId: string, organizationId = orgId, headers?: Record<string, string>) =>
  cancel(post(`/api/organizations/${organizationId}/invitations/${invitationId}/cancel`, {}, headers), {
    params: Promise.resolve({ organizationId, invitationId }),
  });

/** Where a 303 lands: the members page with one code, and nothing else in the address. */
function landing(response: Response): string {
  expect(response.status).toBe(303);
  const url = new URL(response.headers.get("location")!);
  expect(url.origin).toBe(SITE);
  expect(url.pathname).toBe(`/organizations/${orgId}/members`);
  const entries = [...url.searchParams.entries()];
  expect(entries).toHaveLength(1);
  return entries.map(([key, value]) => `${key}=${value}`).join("");
}

const pending = async () =>
  (await deps.repos.invitations.listByOrganization(orgId))
    .filter(({ status }) => status === "PENDING")
    .map(({ email, role }) => `${email} ${role}`);

describe("inviting", () => {
  it("keeps the invitation and mails its link on the configured address; the answer names neither", async () => {
    expect(landing(await inviting({ email: "New.Hire@Example.com", role: "CREATOR" }))).toBe("notice=invited");
    expect(await pending()).toEqual(["new.hire@example.com CREATOR"]);
    const mail = await readDevelopmentEmailOutbox(outbox);
    expect(mail.map(({ kind, to }) => `${kind} ${to}`)).toEqual(["INVITATION new.hire@example.com"]);
    const link = mail[0]?.text.split("\n").find((line) => line.startsWith(`${BASE}/accept-invitation?token=`));
    const token = new URL(link!).searchParams.get("token")!;
    const [stored] = await deps.repos.invitations.listByOrganization(orgId);
    expect(stored?.tokenHash).toBe(deps.tokens.hash(token));
  });

  it.each([
    [{ email: "a@example.com" }, "role"],
    [{ email: "a@example.com", role: "" }, "role"],
    [{ email: "a@example.com", role: "REVIEWER" }, "role"],
    [{ email: "a@example.com", role: "owner" }, "role"],
    [{ email: "not-an-address", role: "VIEWER" }, "email"],
    [{ role: "VIEWER" }, "email"],
    [{ email: "owner@example.com", role: "VIEWER" }, "already-member"],
  ])("refuses %o as %s, writing and mailing nothing", async (fields, code) => {
    expect(landing(await inviting(fields))).toBe(`error=${code}`);
    expect(await pending()).toEqual([]);
    expect(await readDevelopmentEmailOutbox(outbox)).toEqual([]);
  });

  it("refuses a second invitation of an address, and one past the seats", async () => {
    await inviting({ email: "one@example.com", role: "VIEWER" });
    expect(landing(await inviting({ email: "ONE@example.com", role: "CREATOR" }))).toBe("error=already-invited");
    await inviting({ email: "two@example.com", role: "VIEWER" });
    expect(landing(await inviting({ email: "three@example.com", role: "VIEWER" }))).toBe("error=no-seat");
    expect(await pending()).toEqual(["one@example.com VIEWER", "two@example.com VIEWER"]);
  });

  it("refuses an organization with no plan", async () => {
    reader.subscriptions.delete(orgId);
    expect(landing(await inviting({ email: "a@example.com", role: "VIEWER" }))).toBe("error=no-plan");
    expect(await pending()).toEqual([]);
  });

  it.each([
    ["ADMIN", "ADMIN"],
    ["ADMIN", "BILLING"],
    ["MANAGER", "VIEWER"],
  ] as const)("refuses a %s inviting a %s, and audits it", async (actor, role) => {
    subscribe("premium");
    await signInAs(actor);
    expect(landing(await inviting({ email: "a@example.com", role }))).toBe("error=may-not-invite");
    expect(await pending()).toEqual([]);
    const refused = deps.repos.auditLogs.all().filter(({ action }) => action === "member.role_change_refused");
    expect(refused.map(({ metadata }) => metadata["operation"])).toEqual(["invite"]);
  });

  it("writes nothing when invitations cannot be mailed here", async () => {
    env.value = { ...env.value, APP_BASE_URL: undefined };
    expect(landing(await inviting({ email: "a@example.com", role: "VIEWER" }))).toBe("error=unavailable");
    env.value = { ...env.value, APP_BASE_URL: BASE, EMAIL_OUTBOX_DIR: undefined };
    expect(landing(await inviting({ email: "a@example.com", role: "VIEWER" }))).toBe("error=unavailable");
    expect(await pending()).toEqual([]);
  });

  it("says the email may not have gone when the outbox refuses it, and logs the code alone", async () => {
    const notAFolder = join(outbox, "file");
    writeFileSync(notAFolder, "");
    env.value = { ...env.value, EMAIL_OUTBOX_DIR: notAFolder };
    const logged: unknown[] = [];
    const outcome = await inviteMember(
      (await auth.login("owner@example.com", PASSWORD)).session.userId,
      orgId,
      { email: "a@example.com", role: "VIEWER" },
      { error: (message, fields) => logged.push({ message, fields }) },
    );
    expect(outcome).toEqual({ error: "invite-failed" });
    expect(logged).toEqual([
      { message: "An invitation was kept, but its email could not be sent", fields: { code: "CONFIGURATION_ERROR" } },
    ]);
    expect(await pending()).toEqual(["a@example.com VIEWER"]);
  });

  it("logs a failure before anything is kept by its code alone, inviting no one", async () => {
    subscriptions.value = {
      findByOrganization: () => Promise.reject(new Error("connection to a@example.com lost")),
    };
    const logged: unknown[] = [];
    const outcome = await inviteMember(
      (await auth.login("owner@example.com", PASSWORD)).session.userId,
      orgId,
      { email: "a@example.com", role: "VIEWER" },
      { error: (message, fields) => logged.push({ message, fields }) },
    );
    expect(outcome).toEqual({ error: "invite-failed" });
    expect(logged).toEqual([{ message: "An invitation could not be sent", fields: { code: "UNEXPECTED" } }]);
    expect(await pending()).toEqual([]);
  });

  it.each([
    ["no origin", {}],
    ["another site", { origin: "https://evil.example.net" }],
    ["another origin of the same site", { origin: "https://files.vtavision.test" }],
  ])("refuses a post from %s before reading anything", async (_what, headers) => {
    const response = await inviting({ email: "a@example.com", role: "VIEWER" }, headers);
    expect(response.status).toBe(403);
    expect(await pending()).toEqual([]);
  });

  it("sends a signed-out visitor to sign in, inviting no one", async () => {
    cookie.value = undefined;
    const response = await inviting({ email: "a@example.com", role: "VIEWER" });
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    expect(await pending()).toEqual([]);
  });
});

describe("cancelling", () => {
  async function invited(email: string, role: Role): Promise<string> {
    await inviting({ email, role });
    const invitation = (await deps.repos.invitations.listByOrganization(orgId)).find((i) => i.email === email);
    return invitation!.id;
  }

  it("revokes the invitation, audits it and frees its seat", async () => {
    const id = await invited("gone@example.com", "MANAGER");
    await invited("kept@example.com", "VIEWER");
    expect(landing(await cancelling(id))).toBe("notice=cancelled");
    expect(await pending()).toEqual(["kept@example.com VIEWER"]);
    expect(deps.repos.auditLogs.all().filter(({ action }) => action === "invitation.revoked")).toHaveLength(1);
    expect(landing(await inviting({ email: "next@example.com", role: "VIEWER" }))).toBe("notice=invited");
  });

  it("refuses an ADMIN cancelling an ADMIN's invitation", async () => {
    subscribe("premium");
    const id = await invited("boss@example.com", "ADMIN");
    await signInAs("ADMIN");
    expect(landing(await cancelling(id))).toBe("error=may-not-cancel");
    expect(await pending()).toEqual(["boss@example.com ADMIN"]);
  });

  it("finds no invitation that is gone, unknown, or another organization's", async () => {
    const id = await invited("a@example.com", "VIEWER");
    expect(landing(await cancelling(id))).toBe("notice=cancelled");
    expect(landing(await cancelling(id))).toBe("error=gone");
    expect(landing(await cancelling("inv_unknown"))).toBe("error=gone");
    const other = await invited("b@example.com", "VIEWER");
    const { organization } = await new OrganizationService(deps).createOrganization(
      (await auth.login("owner@example.com", PASSWORD)).session.userId,
      { name: "Elsewhere" },
    );
    const elsewhere = await cancelling(other, organization.id);
    expect(new URL(elsewhere.headers.get("location")!).searchParams.get("error")).toBe("gone");
    expect(await pending()).toEqual(["b@example.com VIEWER"]);
  });

  it("logs a failure by its code alone, and says to check the list", async () => {
    const id = await invited("a@example.com", "VIEWER");
    vi.spyOn(deps.repos.invitations, "revoke").mockRejectedValue(new Error(`lost a@example.com ${id}`));
    const logged: unknown[] = [];
    const outcome = await cancelMemberInvitation(
      (await auth.login("owner@example.com", PASSWORD)).session.userId,
      orgId,
      id,
      { error: (message, fields) => logged.push({ message, fields }) },
    );
    expect(outcome).toEqual({ error: "cancel-failed" });
    expect(logged).toEqual([{ message: "An invitation could not be cancelled", fields: { code: "UNEXPECTED" } }]);
    expect(await pending()).toEqual(["a@example.com VIEWER"]);
  });

  it.each([
    ["no origin", {}],
    ["another site", { origin: "https://evil.example.net" }],
  ])("refuses a post from %s before reading anything", async (_what, headers) => {
    const id = await invited("a@example.com", "VIEWER");
    expect((await cancelling(id, orgId, headers)).status).toBe(403);
    expect(await pending()).toEqual(["a@example.com VIEWER"]);
  });

  it("sends a signed-out visitor to sign in, cancelling nothing", async () => {
    const id = await invited("a@example.com", "VIEWER");
    cookie.value = undefined;
    const response = await cancelling(id);
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    expect(await pending()).toEqual(["a@example.com VIEWER"]);
  });
});
