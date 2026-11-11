import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Invitation, InvitationCreation, NewInvitation } from "@app/domain";
import { createPrismaIdentityRepositories } from "@app/database";

/**
 * Inviting within the seats against PostgreSQL (AT-6a, ADR-0135): the
 * invitation commits with its audit entry or not at all; an expired one is
 * marked EXPIRED and frees its address; members and pending invitations not
 * expired are counted against the seats; two invitations racing for one seat
 * or one address make one; migration 34's index admits one pending invitation
 * per address, and an invitation it refuses is answered ALREADY_INVITED; a
 * cancellation commits with its audit entry, once. Accepting (AT-7a,
 * ADR-0137) counts the members only, under the organization's lock: two
 * acceptances racing for the last seat make one member.
 */

const ORG = "org_itest_invites";
const OTHER_ORG = "org_itest_invites_other";
const OWNER = "usr_itest_invites_owner";
const MEMBER = "usr_itest_invites_member";
// Accounts that accept, members of no organization until they do.
const ONE = "usr_itest_invites_one";
const TWO = "usr_itest_invites_two";
const USERS = [OWNER, MEMBER, ONE, TWO];
// An audit entry naming an organization that does not exist breaks its foreign
// key, so it cannot be written.
const UNWRITABLE = "org_itest_invites_missing";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const LATER = new Date("2030-01-08T00:00:00.000Z");

/** Opt-in suite: without a test database it must skip, not fail in a hook. */
const HAS_DB = Boolean(process.env.DATABASE_URL);

/** Room for a lock holder, two contenders and the poll, whatever the host's default pool. */
function pooled(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("connection_limit", "8");
  return parsed.toString();
}

const prisma = new PrismaClient(
  HAS_DB ? { datasources: { db: { url: pooled(process.env.DATABASE_URL ?? "") } } } : undefined,
);
const invitations = createPrismaIdentityRepositories(prisma).invitations;

async function cleanup(): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: [ORG, OTHER_ORG] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  await prisma.user.deleteMany({ where: { id: { in: USERS } } });
}

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.user.create({ data: { id: OWNER, email: "owner@itest-invites.example", name: OWNER } });
  await prisma.user.create({ data: { id: MEMBER, email: "member@itest-invites.example", name: MEMBER } });
  for (const id of [ONE, TWO]) {
    await prisma.user.create({ data: { id, email: `${id}@itest-invites.example`, name: id } });
  }
  for (const id of [ORG, OTHER_ORG]) await prisma.organization.create({ data: { id, name: id, slug: `slug-${id}` } });
  await prisma.membership.createMany({
    data: [
      { organizationId: ORG, userId: OWNER, role: "OWNER" },
      { organizationId: ORG, userId: MEMBER, role: "CREATOR" },
    ],
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

let sequence = 0;

function invitation(email: string, organizationId = ORG): NewInvitation {
  sequence += 1;
  return {
    id: `inv_itest_invites_${sequence}`,
    organizationId,
    email,
    role: "VIEWER",
    tokenHash: `hash:itest_invites_${sequence}`,
    invitedByUserId: OWNER,
    expiresAt: LATER,
  };
}

const audit = (action: string, organizationId = ORG) => ({
  organizationId,
  actorUserId: OWNER,
  action,
  resourceType: "invitation",
  resourceId: "inv_itest_invites",
  metadata: {},
});

function invite(email: string, includedSeats = 5, now = NOW): Promise<InvitationCreation> {
  return invitations.create(invitation(email), audit("invitation.created"), { includedSeats, now });
}

async function statuses(): Promise<string[]> {
  const rows = await prisma.invitation.findMany({ where: { organizationId: ORG }, orderBy: { id: "asc" } });
  return rows.map(({ email, status }) => `${email} ${status}`);
}

/** A clock that stays at `instant`. */
const at = (instant: Date) => ({ now: () => instant });

const auditCount = (action: string) => prisma.auditLog.count({ where: { organizationId: ORG, action } });

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the contenders never all waited on the lock holder");
}

const holdOrganization = (tx: Prisma.TransactionClient) =>
  tx.$queryRaw`SELECT 1 FROM "organizations" WHERE "id" = ${ORG} FOR NO KEY UPDATE`;

/**
 * Start `contenders` while another transaction holds what `hold` locks (the
 * organization's row unless said otherwise), and release them only once every
 * contender is waiting for a lock: the interleaving a race needs, made
 * deterministic. The holder then commits. (The suite's files run one at a
 * time, so no other session waits on a lock meanwhile.)
 */
async function contend(
  contenders: (() => Promise<unknown>)[],
  hold: (tx: Prisma.TransactionClient) => Promise<unknown> = holdOrganization,
  beforeRelease: () => void = () => undefined,
): Promise<PromiseSettledResult<unknown>[]> {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  let signalHeld = (): void => undefined;
  const held = new Promise<void>((resolve) => (signalHeld = resolve));
  const holder = prisma.$transaction(
    async (tx) => {
      await hold(tx);
      signalHeld();
      await released;
    },
    { timeout: 30_000 },
  );
  await Promise.race([held, holder]);
  const settled = Promise.allSettled(contenders.map((run) => run()));
  try {
    await until(async () => {
      const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`;
      return (row?.waiting ?? 0) >= contenders.length;
    });
  } finally {
    beforeRelease();
    release();
  }
  await holder;
  return settled;
}

const outcomes = (results: PromiseSettledResult<unknown>[]) =>
  results.map((r) => (r.status === "fulfilled" ? (r.value as InvitationCreation).outcome : "rejected")).sort();

describe.skipIf(!HAS_DB)("inviting within the seats", () => {
  it("writes the pending invitation with its audit entry", async () => {
    const created = await invite("new@itest-invites.example");
    expect(created).toMatchObject({
      outcome: "CREATED",
      invitation: { email: "new@itest-invites.example", status: "PENDING", acceptedAt: null, expiresAt: LATER },
    });
    expect(await statuses()).toEqual(["new@itest-invites.example PENDING"]);
    expect(await auditCount("invitation.created")).toBe(1);
  });

  it("commits no invitation whose audit entry cannot be written, nor the expired mark", async () => {
    await invite("again@itest-invites.example");
    await expect(
      invitations.create(invitation("again@itest-invites.example"), audit("invitation.created", UNWRITABLE), {
        includedSeats: 5,
        now: LATER,
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await statuses()).toEqual(["again@itest-invites.example PENDING"]);
  });

  it("answers an id or a token used twice as an error, not as a refusal", async () => {
    const first = invitation("first@itest-invites.example");
    const seats = { includedSeats: 5, now: NOW };
    await invitations.create(first, audit("invitation.created"), seats);
    const reused = [
      { ...invitation("second@itest-invites.example"), id: first.id },
      { ...invitation("third@itest-invites.example"), tokenHash: first.tokenHash },
    ];
    for (const input of reused) {
      await expect(invitations.create(input, audit("invitation.created"), seats)).rejects.toMatchObject({
        code: "P2002",
      });
    }
    expect(await statuses()).toEqual(["first@itest-invites.example PENDING"]);
  });

  it("refuses the address of a pending invitation, and of a member", async () => {
    await invite("twice@itest-invites.example");
    expect(await invite("twice@itest-invites.example")).toEqual({ outcome: "ALREADY_INVITED" });
    expect(await invite("member@itest-invites.example")).toEqual({ outcome: "ALREADY_MEMBER" });
    expect(await statuses()).toEqual(["twice@itest-invites.example PENDING"]);
    expect(await auditCount("invitation.created")).toBe(1);
  });

  it("marks an expired invitation EXPIRED, then invites its address again", async () => {
    await invite("again@itest-invites.example");
    expect(await invite("again@itest-invites.example", 5, LATER)).toMatchObject({ outcome: "CREATED" });
    expect(await statuses()).toEqual(["again@itest-invites.example EXPIRED", "again@itest-invites.example PENDING"]);
  });

  it("counts the members and the pending invitations not expired, and no other invitation", async () => {
    await invite("first@itest-invites.example");
    expect(await invite("second@itest-invites.example", 3)).toEqual({ outcome: "NO_SEAT" });
    await prisma.invitation.updateMany({ where: { organizationId: ORG }, data: { status: "REVOKED" } });
    await prisma.invitation.create({ data: { ...invitation("lapsed@itest-invites.example"), expiresAt: NOW } });
    await prisma.invitation.create({ data: { ...invitation("elsewhere@itest-invites.example", OTHER_ORG) } });
    expect(await invite("second@itest-invites.example", 3)).toMatchObject({ outcome: "CREATED" });
    expect(await invite("third@itest-invites.example", 3)).toEqual({ outcome: "NO_SEAT" });
  });

  it("makes one of two invitations racing for the last seat", async () => {
    const results = await contend([
      () => invite("one@itest-invites.example", 3),
      () => invite("two@itest-invites.example", 3),
    ]);
    expect(outcomes(results)).toEqual(["CREATED", "NO_SEAT"]);
    expect(await prisma.invitation.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await auditCount("invitation.created")).toBe(1);
  });

  it("makes one of two invitations of one address racing", async () => {
    const results = await contend([
      () => invite("same@itest-invites.example"),
      () => invite("same@itest-invites.example"),
    ]);
    expect(outcomes(results)).toEqual(["ALREADY_INVITED", "CREATED"]);
    expect(await statuses()).toEqual(["same@itest-invites.example PENDING"]);
  });

  it("answers ALREADY_INVITED when the index refuses a row another path was writing", async () => {
    const raced = "raced@itest-invites.example";
    const results = await contend([() => invite(raced)], (tx) => tx.invitation.create({ data: invitation(raced) }));
    expect(outcomes(results)).toEqual(["ALREADY_INVITED"]);
    expect(await statuses()).toEqual([`${raced} PENDING`]);
    expect(await auditCount("invitation.created")).toBe(0);
  });

  it("holds one pending invitation per address in an organization at the index, whatever path writes", async () => {
    const indexed = "indexed@itest-invites.example";
    await prisma.invitation.create({ data: invitation(indexed) });
    await expect(prisma.invitation.create({ data: invitation(indexed) })).rejects.toMatchObject({ code: "P2002" });
    await prisma.invitation.create({ data: { ...invitation(indexed), status: "EXPIRED" } });
    await prisma.invitation.create({ data: invitation(indexed, OTHER_ORG) });
  });
});

describe.skipIf(!HAS_DB)("cancelling an invitation", () => {
  async function pending(email = "cancel@itest-invites.example"): Promise<string> {
    const created = await invite(email);
    if (created.outcome !== "CREATED") throw new Error(created.outcome);
    return created.invitation.id;
  }

  it("revokes a pending invitation with its audit entry, once", async () => {
    const id = await pending();
    expect(await invitations.revoke(ORG, id, NOW, audit("invitation.revoked"))).toBe("REVOKED");
    expect(await invitations.revoke(ORG, id, NOW, audit("invitation.revoked"))).toBe("STALE");
    expect(await statuses()).toEqual(["cancel@itest-invites.example REVOKED"]);
    expect(await auditCount("invitation.revoked")).toBe(1);
  });

  it("writes nothing for an expired invitation, another organization's, or an unwritable audit entry", async () => {
    const id = await pending();
    expect(await invitations.revoke(ORG, id, LATER, audit("invitation.revoked"))).toBe("STALE");
    expect(await invitations.revoke(OTHER_ORG, id, NOW, audit("invitation.revoked", OTHER_ORG))).toBe("STALE");
    await expect(invitations.revoke(ORG, id, NOW, audit("invitation.revoked", UNWRITABLE))).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    expect(await statuses()).toEqual(["cancel@itest-invites.example PENDING"]);
    expect(await invitations.find(OTHER_ORG, id)).toBeNull();
    expect(await invitations.find(ORG, id)).toMatchObject({ id, status: "PENDING" });
  });

  it("lets one of a cancellation and an acceptance racing win", async () => {
    const id = await pending();
    const found = await invitations.find(ORG, id);
    if (!found) throw new Error("no invitation");
    const newcomer = "usr_itest_invites_newcomer";
    await prisma.user.create({ data: { id: newcomer, email: "cancel@itest-invites.example", name: newcomer } });
    try {
      const settled = await contend(
        [
          () => invitations.revoke(ORG, id, NOW, audit("invitation.revoked")),
          () => invitations.accept(found, newcomer, audit("invitation.accepted"), { includedSeats: 5, clock: at(NOW) }),
        ],
        (tx) => tx.$queryRaw`SELECT 1 FROM "invitations" WHERE "id" = ${id} FOR UPDATE`,
      );
      expect(settled.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
      const [revoked, accepted] = settled.map((result) => (result.status === "fulfilled" ? result.value : null));
      const won = [revoked === "REVOKED", (accepted as { outcome?: string } | null)?.outcome === "ACCEPTED"];
      expect(won.filter(Boolean)).toHaveLength(1);
      expect(await statuses()).toEqual([`cancel@itest-invites.example ${won[0] ? "REVOKED" : "ACCEPTED"}`]);
    } finally {
      await prisma.user.delete({ where: { id: newcomer } });
    }
  });
});

describe.skipIf(!HAS_DB)("accepting within the seats", () => {
  async function pending(email: string): Promise<Invitation> {
    const created = await invite(email);
    if (created.outcome !== "CREATED") throw new Error(created.outcome);
    return created.invitation;
  }

  const accept = (found: Invitation, userId: string, includedSeats = 5, now = NOW) =>
    invitations.accept(found, userId, audit("invitation.accepted"), { includedSeats, clock: at(now) });

  const membersOf = async () =>
    (await prisma.membership.findMany({ where: { organizationId: ORG }, orderBy: { userId: "asc" } })).map(
      ({ userId, role }) => `${userId} ${role}`,
    );

  it("writes the membership, the invitation accepted at now, and its audit entry", async () => {
    const found = await pending("one@itest-invites.example");
    expect(await accept(found, ONE)).toMatchObject({
      outcome: "ACCEPTED",
      membership: { organizationId: ORG, userId: ONE, role: "VIEWER" },
    });
    expect(await prisma.invitation.findUnique({ where: { id: found.id } })).toMatchObject({
      status: "ACCEPTED",
      acceptedAt: NOW,
    });
    expect(await membersOf()).toContain(`${ONE} VIEWER`);
    expect(await auditCount("invitation.accepted")).toBe(1);
  });

  it("writes nothing for an invitation expired by now, or no longer pending, even with no seat free", async () => {
    const found = await pending("one@itest-invites.example");
    expect(await accept(found, ONE, 5, LATER)).toEqual({ outcome: "STALE" });
    await invitations.revoke(ORG, found.id, NOW, audit("invitation.revoked"));
    expect(await accept(found, ONE, 2)).toEqual({ outcome: "STALE" });
    expect(await statuses()).toEqual(["one@itest-invites.example REVOKED"]);
    expect(await membersOf()).toEqual([`${MEMBER} CREATOR`, `${OWNER} OWNER`]);
    expect(await auditCount("invitation.accepted")).toBe(0);
  });

  it("counts the members only, and refuses at the seats, leaving the invitation pending", async () => {
    const [one, two] = [await pending("one@itest-invites.example"), await pending("two@itest-invites.example")];
    expect((await accept(one, ONE, 3)).outcome).toBe("ACCEPTED");
    expect(await accept(two, TWO, 3)).toEqual({ outcome: "NO_SEAT" });
    expect((await statuses()).sort()).toEqual([
      "one@itest-invites.example ACCEPTED",
      "two@itest-invites.example PENDING",
    ]);
    expect(await membersOf()).not.toContain(`${TWO} VIEWER`);
    expect(await auditCount("invitation.accepted")).toBe(1);
    expect(await accept(one, ONE, 3)).toEqual({ outcome: "STALE" });
  });

  it("makes one member of two acceptances racing for the last seat", async () => {
    const [one, two] = [await pending("one@itest-invites.example"), await pending("two@itest-invites.example")];
    const results = await contend([() => accept(one, ONE, 3), () => accept(two, TWO, 3)]);
    expect(outcomes(results)).toEqual(["ACCEPTED", "NO_SEAT"]);
    expect(await prisma.membership.count({ where: { organizationId: ORG } })).toBe(3);
    expect((await statuses()).map((row) => row.split(" ")[1]).sort()).toEqual(["ACCEPTED", "PENDING"]);
    expect(await auditCount("invitation.accepted")).toBe(1);
  });

  it("lets an acceptance and an invitation racing for the last seat each wait on the lock", async () => {
    const one = await pending("one@itest-invites.example");
    const results = await contend([() => accept(one, ONE, 3), () => invite("two@itest-invites.example", 3)]);
    expect(outcomes(results)).toEqual(["ACCEPTED", "NO_SEAT"]);
    expect(await statuses()).toEqual(["one@itest-invites.example ACCEPTED"]);
  });

  it("judges an acceptance that waited on the lock at the instant it holds it", async () => {
    const one = await pending("one@itest-invites.example");
    let released = false;
    const clock = { now: () => (released ? LATER : NOW) };
    const results = await contend(
      [() => invitations.accept(one, ONE, audit("invitation.accepted"), { includedSeats: 5, clock })],
      holdOrganization,
      () => (released = true),
    );
    expect(outcomes(results)).toEqual(["STALE"]);
    expect(await statuses()).toEqual(["one@itest-invites.example PENDING"]);
  });
});
