import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService, MembershipService, OrganizationService, includedSeatsFrom, type Role } from "@app/domain";
import {
  InMemoryUnitsReader,
  createTestDeps,
  markEmailVerified,
  membershipTestOptions,
  type TestDeps,
} from "@app/domain/testing";

/**
 * Route tests for opening and accepting an invitation (AT-7b, ADR-0138): a
 * same-origin form post accepts for a complete sign-in, with the token from
 * the form or else the one waiting in the browser; any other sign-in, or
 * none, leaves the invitation waiting in an HttpOnly cookie and goes on to
 * sign in. The answer is a fixed code, never the invited address or the
 * token. Only the cookie store, the environment, the identity wiring and the
 * subscriptions are stubbed: the session gate and the domain services run for
 * real.
 */
const PASSWORD = "password-123456";
const SITE = "https://app.vtavision.test";
const WAITING = "rev_invitation";

const jar = vi.hoisted(() => ({ value: {} as Record<string, string> }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));
const subscriptions = vi.hoisted(() => ({ value: null as unknown }));

// `next` is installed for the web app only, so its module is named by its resolved path.
const nextHeaders = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  return createRequire(new URL("../../apps/web/package.json", import.meta.url)).resolve("next/headers");
});

vi.mock(nextHeaders, () => ({
  cookies: () =>
    Promise.resolve({ get: (name: string) => (name in jar.value ? { value: jar.value[name] } : undefined) }),
}));
vi.mock("@/lib/env", () => ({ getServerEnv: () => env.value }));
vi.mock("@/lib/identity", () => ({ getIdentityServices: () => identity.value }));
vi.mock("@app/database", () => ({
  createSubscriptionRepository: () => subscriptions.value,
  getPrismaClient: () => ({}),
}));

const { POST: acceptRoute } = await import("@/app/api/invitations/accept/route");
const { POST: dismissRoute } = await import("@/app/api/invitations/dismiss/route");
const { acceptError, openInvitation, waitingInvitation } = await import("@/lib/invitations");

let deps: TestDeps;
let auth: AuthService;
let members: MembershipService;
let reader: InMemoryUnitsReader;
let ownerId: string;
let orgId: string;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  deps = createTestDeps();
  // A session outlives the invitations, which last an hour here.
  auth = new AuthService(deps, { sessionTtlSeconds: 86_400 });
  identity.value = { deps, auth, organizations: new OrganizationService(deps) };
  reader = new InMemoryUnitsReader();
  subscriptions.value = reader;
  members = new MembershipService(deps, membershipTestOptions({ includedSeats: includedSeatsFrom(reader) }));
  env.value = { NODE_ENV: "test", USER_SESSION_TTL_SECONDS: 3600 };
  jar.value = {};
  ownerId = await register("owner");
  ({ organization: { id: orgId } } = await new OrganizationService(deps).createOrganization(ownerId, {
    name: "Studio Kanda",
  }));
  reader.subscriptions.set(orgId, {
    id: `sub_${orgId}`,
    organizationId: orgId,
    planKey: "standard",
    channel: "SALES_ASSISTED",
    anchorAt: new Date("2025-12-15T00:00:00.000Z"),
    commercialReference: "VT-1",
    createdAt: new Date("2025-12-01T00:00:00.000Z"),
  });
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function register(name: string, verified = true): Promise<string> {
  const userId = (await auth.register({ email: `${name}@example.com`, name, password: PASSWORD })).id;
  if (verified) markEmailVerified(deps, userId);
  return userId;
}

/** Sign this browser in as `name`, with the password only. */
async function signIn(name: string): Promise<void> {
  jar.value["rev_session"] = (await auth.login(`${name}@example.com`, PASSWORD)).token;
}

async function invite(name: string, role: Role = "CREATOR", actor = ownerId): Promise<string> {
  return (await members.invite(actor, { organizationId: orgId, email: `${name}@example.com`, role })).token;
}

function post(path: string, fields: Record<string, string>, headers: Record<string, string> = { origin: SITE }) {
  return new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { host: "app.vtavision.test", "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

const accepting = (fields: Record<string, string> = {}, headers?: Record<string, string>) =>
  acceptRoute(post("/api/invitations/accept", fields, headers));

/** Where a 303 lands on this site: its path and query. */
function landing(response: Response): string {
  expect(response.status).toBe(303);
  const url = new URL(response.headers.get("location")!);
  expect(url.origin).toBe(SITE);
  return `${url.pathname}${url.search}`;
}

/** What the answer leaves waiting in the browser: the token, `none` once deleted, or `unchanged`. */
function waiting(response: Awaited<ReturnType<typeof acceptRoute>>): string {
  const cookie = response.cookies.get(WAITING);
  if (cookie === undefined) return "unchanged";
  return cookie.value === "" ? "none" : cookie.value;
}

const roleOf = async (userId: string) => (await deps.repos.memberships.find(orgId, userId))?.role;
const statuses = async () => (await deps.repos.invitations.listByOrganization(orgId)).map(({ status }) => status);

describe("before the sign-in is complete", () => {
  it("leaves the invitation waiting in an HttpOnly cookie for a day, and goes on to sign in", async () => {
    const token = await invite("invitee");
    const response = await accepting({ token });
    expect(landing(response)).toBe("/login");
    expect(response.cookies.get(WAITING)).toMatchObject({
      value: token,
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      maxAge: 86_400,
    });
    expect(await statuses()).toEqual(["PENDING"]);
  });

  it("sends a sign-in that owes a step to the sign-in page, which sends it on, the invitation waiting", async () => {
    const token = await invite("invitee");
    await register("invitee", false);
    await signIn("invitee");
    const response = await accepting({ token });
    expect(landing(response)).toBe("/login");
    expect(waiting(response)).toBe(token);
    expect(await statuses()).toEqual(["PENDING"]);
  });

  it("is secure in production", async () => {
    env.value = { ...env.value, NODE_ENV: "production" };
    const response = await accepting({ token: await invite("invitee") });
    expect(response.cookies.get(WAITING)).toMatchObject({ secure: true });
  });
});

describe("signed in", () => {
  it("joins the invited account with the invited role, naming the organization, and stops it waiting", async () => {
    const token = await invite("invitee", "VIEWER");
    const invitee = await register("invitee");
    await signIn("invitee");
    const response = await accepting({ token });
    expect(landing(response)).toBe(`/?joined=${orgId}`);
    expect(waiting(response)).toBe("none");
    expect(await roleOf(invitee)).toBe("VIEWER");
    expect(await statuses()).toEqual(["ACCEPTED"]);
  });

  it("accepts the invitation waiting in the browser when the form has none, the form's first", async () => {
    const invitee = await register("invitee");
    await signIn("invitee");
    jar.value[WAITING] = await invite("invitee");
    expect(landing(await accepting())).toBe(`/?joined=${orgId}`);
    expect(await roleOf(invitee)).toBe("CREATOR");

    const other = await register("other");
    await signIn("other");
    jar.value[WAITING] = "not-a-token";
    expect(landing(await accepting({ token: await invite("other") }))).toBe(`/?joined=${orgId}`);
    expect(await roleOf(other)).toBe("CREATOR");
  });

  it("refuses another account and keeps the invitation waiting, for the invited one to sign in here", async () => {
    const token = await invite("invitee");
    const outsider = await register("outsider");
    await signIn("outsider");
    const response = await accepting({ token });
    expect(landing(response)).toBe("/accept-invitation?error=wrong-account");
    expect(waiting(response)).toBe(token);
    expect(await roleOf(outsider)).toBeUndefined();
    expect(await statuses()).toEqual(["PENDING"]);
  });

  /** Makes the refusal happen, given the invitation's token and the invitee; may name another token to post. */
  type Setup = (token: string, invitee: string) => Promise<string | void>;
  let adminId: string;
  const cancel = async () => {
    const [invitation] = await deps.repos.invitations.listByOrganization(orgId);
    await members.cancelInvitation(ownerId, orgId, invitation!.id);
  };
  const join = (userId: string) => deps.repos.memberships.create({ organizationId: orgId, userId, role: "VIEWER" });
  const fillSeats = async () => {
    // Standard includes 3: the owner and the admin, and one more.
    await join(await register("filler"));
  };
  const cases: [string, Setup, string][] = [
    ["a token of none", async () => "unknown", "invalid"],
    ["a cancelled invitation", cancel, "invalid"],
    ["an expired invitation", async () => deps.clock.set(new Date(deps.clock.now().getTime() + 3_600_000)), "expired"],
    ["a member", async (_, invitee) => void (await join(invitee)), "already-member"],
    ["an inviter past its ceiling", () => members.removeMember(ownerId, orgId, adminId), "withdrawn"],
    ["no plan", async () => void reader.subscriptions.delete(orgId), "no-plan"],
    ["every seat taken by members", fillSeats, "no-seat"],
  ];

  it.each(cases)("refuses %s, and the invitation stops waiting", async (_, setup, code) => {
    adminId = await register("admin");
    await deps.repos.memberships.create({ organizationId: orgId, userId: adminId, role: "ADMIN" });
    const invited = await invite("invitee", "VIEWER", adminId);
    const invitee = await register("invitee");
    await signIn("invitee");
    const token = (await setup(invited, invitee)) ?? invited;
    const response = await accepting({ token });
    expect(landing(response)).toBe(`/accept-invitation?error=${code}`);
    expect(waiting(response)).toBe("none");
    expect(await roleOf(invitee)).toBe(code === "already-member" ? "VIEWER" : undefined);
  });

  it("refuses a token too long to be one, unread, signed in or not", async () => {
    const spy = vi.spyOn(deps.repos.invitations, "findByTokenHash");
    expect(landing(await accepting({ token: "x".repeat(129) }))).toBe("/accept-invitation?error=invalid");
    await register("invitee");
    await signIn("invitee");
    const response = await accepting({ token: "x".repeat(129) });
    expect(landing(response)).toBe("/accept-invitation?error=invalid");
    expect(waiting(response)).toBe("none");
    expect(landing(await accepting())).toBe("/accept-invitation?error=invalid");
    expect(spy).not.toHaveBeenCalled();
    // The longest a token may be is read.
    expect(landing(await accepting({ token: "x".repeat(128) }))).toBe("/accept-invitation?error=invalid");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("answers a failure that is not a refusal with a fixed code, keeps it waiting, and logs no token", async () => {
    const token = await invite("invitee");
    await register("invitee");
    await signIn("invitee");
    vi.spyOn(deps.repos.invitations, "findByTokenHash").mockRejectedValueOnce(new Error(`db down ${token}`));
    const response = await accepting({ token });
    expect(landing(response)).toBe("/accept-invitation?error=failed");
    expect(waiting(response)).toBe(token);
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("An invitation could not be accepted"))).toBe(true);
    expect(lines.join("\n")).not.toContain(token);
  });
});

describe("from another site", () => {
  it.each([[{ origin: "https://evil.test" }], [{}]])("refuses a post with %o, changing nothing", async (headers) => {
    const token = await invite("invitee");
    await register("invitee");
    await signIn("invitee");
    for (const response of [await accepting({ token }, headers), await dismissRoute(post("/x", {}, headers))]) {
      expect(response.status).toBe(403);
      expect(waiting(response)).toBe("unchanged");
    }
    expect(await statuses()).toEqual(["PENDING"]);
  });
});

it("puts an invitation aside: it stops waiting, and stays pending", async () => {
  jar.value[WAITING] = await invite("invitee");
  const response = await dismissRoute(post("/api/invitations/dismiss", {}));
  expect(landing(response)).toBe("/");
  expect(waiting(response)).toBe("none");
  expect(await statuses()).toEqual(["PENDING"]);
});

describe("reading an invitation", () => {
  it("tells what an open one offers, and nothing for a token of none", async () => {
    const token = await invite("invitee", "VIEWER");
    expect(await openInvitation(token)).toEqual({
      state: "open",
      offer: { organizationName: "Studio Kanda", role: "VIEWER", invitedAs: "a Viewer" },
    });
    expect(await openInvitation("unknown")).toEqual({ state: "invalid" });
  });

  it("answers a failure to read with a state, logging its code and no token", async () => {
    const token = await invite("invitee");
    vi.spyOn(deps.repos.invitations, "findByTokenHash").mockRejectedValueOnce(new Error(`db down ${token}`));
    expect(await openInvitation(token)).toEqual({ state: "failed" });
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("An invitation could not be read"))).toBe(true);
    expect(lines.join("\n")).not.toContain(token);
  });

  it("finds the one waiting in the browser while it is open", async () => {
    expect(await waitingInvitation()).toBeNull();
    jar.value[WAITING] = await invite("invitee");
    expect(await waitingInvitation()).toMatchObject({ organizationName: "Studio Kanda" });
    await members.cancelInvitation(ownerId, orgId, (await deps.repos.invitations.listByOrganization(orgId))[0]!.id);
    expect(await waitingInvitation()).toBeNull();
  });
});

it("reads only the refusal codes it knows", () => {
  expect(acceptError("no-seat")).toBe("no-seat");
  for (const param of ["toString", "", undefined, ["no-seat"]]) expect(acceptError(param)).toBeNull();
});
