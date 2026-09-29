import { createDeliverableValidationRepository } from "@app/database";
import {
  ISO_BMFF_CONTAINER,
  type DeliverableValidationPublicationTarget,
  type ManagedOutputMediaFacts,
} from "@app/domain";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { jobOf } from "./deliverable-composition-execution-fixture";
import {
  reservationOf,
  seedComposedDeliverable,
  validationOf,
} from "./deliverable-validation-fixture";
import { ctx, dropTenants, HAS_DB, seedTenants, wipeOrchestration } from "./orchestration-fixture";

/**
 * The races deliverable validation and Transaction G must not lose, against live
 * PostgreSQL.
 *
 * Three things are proved here that no unit test can prove:
 *
 * **Two claimers.** Exactly one takes the lease. The loser answers
 * `NOT_CLAIMABLE`, never a raw uniqueness error from the one-per-version index.
 *
 * **Two publishers.** Exactly one spends the unit. This is the race that costs
 * real money if it is wrong, so it is measured on the reservation row itself —
 * one `CONSUMED` event, one `stateVersion` increment, one `consumedAt`.
 *
 * **The lock order.** Transaction G takes the reservation *before* the job, the
 * same order Transaction H and Transaction I take. It is established against the
 * real publication path rather than a hand-written probe, because the aliases
 * after `FOR UPDATE OF` do not decide acquisition order and neither does the
 * `FROM` clause's text order — only the plan does.
 *
 * No `sleep` is used as a synchronization authority. Ordering is established with
 * a real row lock held by a third connection, and with `pg_stat_activity` showing
 * the contenders genuinely blocked before the barrier is released.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const repository = createDeliverableValidationRepository(prisma);

const NOW = Date.UTC(2026, 8, 27, 9, 0, 0);
const LEASE_MS = 15 * 60_000;

const FACTS: ManagedOutputMediaFacts = {
  container: ISO_BMFF_CONTAINER,
  durationMs: 10_000,
  videoWidth: 1920,
  videoHeight: 1080,
  videoStreamCount: 1,
  audioStreamCount: 0,
};

/** How many backends are currently waiting on a lock in this database. */
async function blockedBackends(client: PrismaClient): Promise<number> {
  const rows = await client.$queryRawUnsafe<{ wait_event_type: string | null }[]>(
    `SELECT wait_event_type FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`,
  );
  return rows.filter((r) => r.wait_event_type === "Lock").length;
}

async function waitForBlocked(client: PrismaClient, count: number): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if ((await blockedBackends(client)) >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/**
 * Hold one row exclusively on a connection of its own.
 *
 * The barrier every contender queues behind. Without it, one contender can
 * simply finish before the other begins and nothing was raced.
 */
async function rowBarrier(table: string, id: string) {
  const holder = new PrismaClient();
  let release: () => void = () => undefined;
  const mayFinish = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const done = holder
    .$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`, id);
        ready();
        await mayFinish;
      },
      { timeout: 30_000 },
    )
    .catch(() => undefined);
  await held;
  return {
    release: async () => {
      release();
      await done;
      await holder.$disconnect();
    },
  };
}

function settled<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

let leaseSeq = 0;

function claimOn(client: PrismaClient, organizationId: string, deliverableVersionId: string) {
  leaseSeq += 1;
  return createDeliverableValidationRepository(client).claimDeliverableValidation({
    organizationId,
    deliverableVersionId,
    now: NOW,
    leaseToken: `vlease_race_${leaseSeq}`,
    leaseExpiresAt: NOW + LEASE_MS,
  });
}

/** Validate a composed deliverable and return the publication Transaction G wants. */
async function validated(
  organizationId: string,
  deliverableVersionId: string,
): Promise<DeliverableValidationPublicationTarget> {
  leaseSeq += 1;
  const held = await repository.claimDeliverableValidation({
    organizationId,
    deliverableVersionId,
    now: NOW,
    leaseToken: `vlease_race_${leaseSeq}`,
    leaseExpiresAt: NOW + LEASE_MS,
  });
  if (held.kind !== "CLAIMED") throw new Error(`expected CLAIMED, got ${held.kind}`);
  const finalized = await repository.finalizeValid({
    claim: held.claim,
    facts: FACTS,
    validatedAt: NOW + 1_000,
    context: ctx(),
  });
  if (finalized.kind === "LEASE_LOST") throw new Error("expected a written verdict");
  return finalized.publication;
}

RUN("Phase 5C — validation and publication races", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  it("gives the lease to exactly one of two simultaneous claimers", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const first = new PrismaClient();
    const second = new PrismaClient();
    const barrier = await rowBarrier("generation_jobs", composed.jobId);

    const races = [
      settled(claimOn(first, composed.organizationId, composed.deliverableVersionId)),
      settled(claimOn(second, composed.organizationId, composed.deliverableVersionId)),
    ];
    expect(await waitForBlocked(prisma, 2)).toBe(true);
    await barrier.release();
    const outcomes = await Promise.all(races);

    // Both succeeded as calls. Exactly one holds the lease, and the loser learned
    // it through its own outcome union rather than a P2002 nobody handles.
    expect(outcomes.every((o) => o.ok)).toBe(true);
    const kinds = outcomes.map((o) => (o.ok ? o.value.kind : "threw")).sort();
    expect(kinds).toEqual(["CLAIMED", "NOT_CLAIMABLE"]);

    const row = await validationOf(prisma, composed.deliverableVersionId);
    expect(row?.status).toBe("RUNNING");
    expect(row?.attemptCount).toBe(1);
    expect(row?.version).toBe(1);
    expect(
      await prisma.generationDeliverableValidation.count({
        where: { deliverableVersionId: composed.deliverableVersionId },
      }),
    ).toBe(1);

    await first.$disconnect();
    await second.$disconnect();
  });

  it("spends exactly one unit when two publishers arrive together", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(
      composed.organizationId,
      composed.deliverableVersionId,
    );
    const first = new PrismaClient();
    const second = new PrismaClient();
    // The barrier is the *reservation*, because that is the row Transaction G
    // takes first. Queueing on it proves both contenders really are serialized
    // by the entitlement lock rather than by luck.
    const barrier = await rowBarrier("generation_reservations", composed.reservationId);

    const races = [first, second].map((client) =>
      settled(
        createDeliverableValidationRepository(client).publishDeliverable({
          publication,
          publishedAt: NOW + 2_000,
          context: ctx(),
        }),
      ),
    );
    expect(await waitForBlocked(prisma, 2)).toBe(true);
    await barrier.release();
    const outcomes = await Promise.all(races);

    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(outcomes.map((o) => (o.ok ? o.value.kind : "threw")).sort()).toEqual([
      "ALREADY_PUBLISHED",
      "PUBLISHED_AND_CONSUMED",
    ]);

    const reservation = await reservationOf(prisma, composed.reservationId);
    expect(reservation.state).toBe("CONSUMED");
    expect(reservation.stateVersion).toBe(1);
    expect(reservation.consumedAt?.getTime()).toBe(NOW + 2_000);
    expect(
      await prisma.generationTransitionEvent.count({
        where: { aggregateId: composed.reservationId, toState: "CONSUMED" },
      }),
    ).toBe(1);
    expect(
      await prisma.generationTransitionEvent.count({
        where: { aggregateId: composed.jobId, toState: "DELIVERABLE_READY" },
      }),
    ).toBe(1);
    expect((await jobOf(prisma, composed.jobId)).currentDeliverableVersionId).toBe(
      composed.deliverableVersionId,
    );

    await first.$disconnect();
    await second.$disconnect();
  });

  it("takes the reservation lock before the job lock", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(
      composed.organizationId,
      composed.deliverableVersionId,
    );
    const publisher = new PrismaClient();
    const third = new PrismaClient();

    // Holding the *reservation* blocks Transaction G, and a third session can
    // still acquire the job row: the publication has not reached it yet.
    const held = await rowBarrier("generation_reservations", composed.reservationId);
    const race = settled(
      createDeliverableValidationRepository(publisher).publishDeliverable({
        publication,
        publishedAt: NOW + 2_000,
        context: ctx(),
      }),
    );
    expect(await waitForBlocked(prisma, 1)).toBe(true);

    const jobAvailable = await third.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "generation_jobs"
         WHERE "id" = ${composed.jobId} FOR UPDATE NOWAIT
      `;
      return rows.length;
    });
    // Not held by the blocked publisher. If Transaction G took the job first,
    // this would raise rather than return the row.
    expect(jobAvailable).toBe(1);

    await held.release();
    const outcome = await race;
    expect(outcome.ok && outcome.value.kind).toBe("PUBLISHED_AND_CONSUMED");

    await publisher.$disconnect();
    await third.$disconnect();
  });

  it("holds the job row too, once it has the reservation", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(
      composed.organizationId,
      composed.deliverableVersionId,
    );
    const publisher = new PrismaClient();
    const third = new PrismaClient();

    // The mirror image: holding the *job* blocks Transaction G as well, so a
    // third session is refused the reservation the blocked publisher already
    // holds. Together the two directions pin the order rather than one of them
    // merely being consistent with it.
    const held = await rowBarrier("generation_jobs", composed.jobId);
    const race = settled(
      createDeliverableValidationRepository(publisher).publishDeliverable({
        publication,
        publishedAt: NOW + 2_000,
        context: ctx(),
      }),
    );
    expect(await waitForBlocked(prisma, 1)).toBe(true);

    await expect(
      third.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "generation_reservations"
           WHERE "id" = ${composed.reservationId} FOR UPDATE NOWAIT
        `;
      }),
    ).rejects.toThrow();

    await held.release();
    const outcome = await race;
    expect(outcome.ok && outcome.value.kind).toBe("PUBLISHED_AND_CONSUMED");

    await publisher.$disconnect();
    await third.$disconnect();
  });

  it("never lets a finalize and a reclaim both write a verdict", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const stale = await repository.claimDeliverableValidation({
      organizationId: composed.organizationId,
      deliverableVersionId: composed.deliverableVersionId,
      now: NOW,
      leaseToken: "vlease_race_stale",
      leaseExpiresAt: NOW + LEASE_MS,
    });
    if (stale.kind !== "CLAIMED") throw new Error(`expected CLAIMED, got ${stale.kind}`);

    const first = new PrismaClient();
    const second = new PrismaClient();
    const barrier = await rowBarrier("generation_jobs", composed.jobId);

    // One worker finalizes on the lease it holds; another reclaims the row
    // because the lease has expired. Whichever commits first, the other must not
    // write over it.
    const races = [
      settled(
        createDeliverableValidationRepository(first).finalizeValid({
          claim: stale.claim,
          facts: FACTS,
          validatedAt: NOW + 2_000,
          context: ctx(),
        }),
      ),
      settled(
        createDeliverableValidationRepository(second).claimDeliverableValidation({
          organizationId: composed.organizationId,
          deliverableVersionId: composed.deliverableVersionId,
          now: NOW + LEASE_MS,
          leaseToken: "vlease_race_reclaim",
          leaseExpiresAt: NOW + LEASE_MS * 2,
        }),
      ),
    ];
    expect(await waitForBlocked(prisma, 2)).toBe(true);
    await barrier.release();
    const [finalize, reclaim] = await Promise.all(races);

    expect(finalize.ok && reclaim.ok).toBe(true);
    const row = await validationOf(prisma, composed.deliverableVersionId);
    if (finalize.ok && finalize.value.kind !== "LEASE_LOST") {
      // The finalize went first: the verdict is terminal and the reclaim was
      // refused rather than reopening it.
      expect(row?.status).toBe("VALID");
      expect(reclaim.ok && reclaim.value.kind).toBe("ALREADY_VALID");
    } else {
      // The reclaim went first: the stale worker lost, and the row is still
      // being worked on by the reclaimer.
      expect(row?.status).toBe("RUNNING");
      expect(reclaim.ok && reclaim.value.kind).toBe("CLAIMED");
    }
    expect(
      await prisma.generationTransitionEvent.count({
        where: { aggregateId: composed.deliverableVersionId, toState: "VALIDATED" },
      }),
    ).toBeLessThanOrEqual(1);

    await first.$disconnect();
    await second.$disconnect();
  });
});
