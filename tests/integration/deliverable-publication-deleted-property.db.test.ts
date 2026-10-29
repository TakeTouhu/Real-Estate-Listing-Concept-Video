import { createDeliverableValidationRepository } from "@app/database";
import {
  DeliverableValidationRunner,
  ISO_BMFF_CONTAINER,
  type DeliverableValidationPublicationTarget,
  type ManagedOutputMediaFacts,
} from "@app/domain";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eventCount, eventsFor, jobOf } from "./deliverable-composition-execution-fixture";
import {
  reservationOf,
  seedComposedDeliverable,
  seedRecomposedDeliverable,
  validationOf,
  type ComposedDeliverable,
} from "./deliverable-validation-fixture";
import {
  ctx,
  dropTenants,
  FIXTURE_CYCLE,
  HAS_DB,
  ORG_A,
  ORG_B,
  PROP_A,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * ADR-0103 against live PostgreSQL: Transaction G never publishes a first video
 * whose Property was deleted. The job fails and its Unit is released in the
 * commit that would have published it, as a cycle with no usable video settles
 * (ADR-0082), and the events say why.
 *
 * Every deliverable here is composed and validated through the real
 * transactions; the Property is deleted by hand, as `PropertyService.remove`
 * writes it (ADR-0101).
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const holder = new PrismaClient();
const repository = createDeliverableValidationRepository(prisma);

const NOW = Date.UTC(2026, 9, 29, 9, 0, 0);
const PUBLISHED_AT = NOW + 2_000;

const FACTS: ManagedOutputMediaFacts = {
  container: ISO_BMFF_CONTAINER,
  durationMs: 10_000,
  videoWidth: 1920,
  videoHeight: 1080,
  videoStreamCount: 1,
  audioStreamCount: 0,
};

let leaseSeq = 0;

/** Claim and record a VALID verdict, leaving only the publication outstanding. */
async function validated(composed: ComposedDeliverable): Promise<DeliverableValidationPublicationTarget> {
  leaseSeq += 1;
  const claimed = await repository.claimDeliverableValidation({
    organizationId: composed.organizationId,
    deliverableVersionId: composed.deliverableVersionId,
    now: NOW,
    leaseToken: `vlease_deleted_${leaseSeq}`,
    leaseExpiresAt: NOW + 15 * 60_000,
  });
  if (claimed.kind !== "CLAIMED") throw new Error(`expected CLAIMED, got ${claimed.kind}`);
  const finalized = await repository.finalizeValid({
    claim: claimed.claim,
    facts: FACTS,
    validatedAt: NOW + 1_000,
    context: ctx(),
  });
  if (finalized.kind === "LEASE_LOST") throw new Error("expected a written verdict");
  return finalized.publication;
}

function publish(publication: DeliverableValidationPublicationTarget, client: PrismaClient = prisma) {
  return createDeliverableValidationRepository(client).publishDeliverable({
    publication,
    publishedAt: PUBLISHED_AT,
    context: ctx(),
  });
}

async function deleteProperty(): Promise<void> {
  await prisma.property.update({ where: { id: PROP_A }, data: { status: "DELETED" } });
}

/** Everything Transaction G could write, read back for an unchanged comparison. */
async function publicationState(composed: ComposedDeliverable) {
  const job = await jobOf(prisma, composed.jobId);
  const reservation = await reservationOf(prisma, composed.reservationId);
  const validation = await validationOf(prisma, composed.deliverableVersionId);
  return {
    job: [job.state, job.stateVersion, job.currentDeliverableVersionId],
    reservation: [reservation.state, reservation.stateVersion, reservation.consumedAt, reservation.releasedAt],
    validation: [validation?.status, validation?.version],
    events: await eventCount(prisma),
  };
}

function lastEvent(events: Awaited<ReturnType<typeof eventsFor>>) {
  const last = events.at(-1);
  return [last?.fromState, last?.toState, last?.eventType, last?.reasonCode];
}

/** Resolves once, when `promise` settles; never rejects. */
function settled<T>(promise: Promise<T>): { done: () => boolean; value: Promise<T> } {
  let finished = false;
  const value = promise.finally(() => {
    finished = true;
  });
  void value.catch(() => undefined);
  return { done: () => finished, value };
}

/** Whether `count` other backends are waiting on a lock within the deadline: the database says so. */
async function waitForBlocked(count: number, withinMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<{ wait_event_type: string | null }[]>(
      `SELECT wait_event_type FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    if (rows.filter((row) => row.wait_event_type === "Lock").length >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** Run `body` on a connection of its own and keep its transaction open until `release`. */
async function holdOpen(body: (tx: Tx) => Promise<void>): Promise<{ release: () => Promise<void> }> {
  let mayFinish!: () => void;
  const held = new Promise<void>((resolve) => {
    mayFinish = resolve;
  });
  let ready!: () => void;
  let failed!: (error: unknown) => void;
  const locked = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const done = holder
    .$transaction(
      async (tx) => {
        await body(tx);
        ready();
        await held;
      },
      { timeout: 20_000 },
    )
    .catch((error: unknown) => failed(error));
  await locked;
  return {
    release: async () => {
      mayFinish();
      await done;
    },
  };
}

/** The cost-admission lock's formula, written out on purpose: if it changes, this stops blocking. */
async function holdCostAdmissionLock(tx: Tx, organizationId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${`paid-submission:${organizationId}`}),
      hashtext(${`cycle:${FIXTURE_CYCLE}`})
    )::text AS locked`;
}

RUN("ADR-0103 — Transaction G refuses a deleted Property's first video and releases its Unit", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await holder.$disconnect();
    await prisma.$disconnect();
  });

  it("fails the job and releases its Unit in one commit, publishing nothing", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(composed);
    await deleteProperty();
    const job = await jobOf(prisma, composed.jobId);
    const held = await reservationOf(prisma, composed.reservationId);
    const validation = await validationOf(prisma, composed.deliverableVersionId);
    const events = await eventCount(prisma);

    expect(await publish(publication)).toEqual({ kind: "PROPERTY_DELETED" });

    const failed = await jobOf(prisma, composed.jobId);
    expect([failed.state, failed.stateVersion, failed.currentDeliverableVersionId]).toEqual([
      "FAILED_TERMINAL",
      job.stateVersion + 1,
      null,
    ]);
    const released = await reservationOf(prisma, composed.reservationId);
    expect([released.state, released.stateVersion, released.consumedAt, released.releasedAt?.getTime()]).toEqual([
      "RELEASED",
      held.stateVersion + 1,
      null,
      PUBLISHED_AT,
    ]);
    // The job's move and the Unit's release, and nothing else: the version is
    // never published, and its verdict stays the evidence it was.
    expect(await eventCount(prisma)).toBe(events + 2);
    expect(lastEvent(await eventsFor(prisma, composed.jobId))).toEqual([
      "DELIVERABLE_VALIDATING",
      "FAILED_TERMINAL",
      "job.ended_property_deleted",
      "PROPERTY_DELETED",
    ]);
    expect(lastEvent(await eventsFor(prisma, composed.reservationId))).toEqual([
      "RESERVED",
      "RELEASED",
      "reservation.released",
      "PROPERTY_DELETED",
    ]);
    expect(
      (await eventsFor(prisma, composed.deliverableVersionId)).map((event) => event.toState),
    ).not.toContain("PUBLISHED");
    expect(await validationOf(prisma, composed.deliverableVersionId)).toEqual(validation);
  });

  it("answers a replay as NOT_PUBLISHABLE, and the video is never offered or claimed again", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(composed);
    await deleteProperty();
    expect((await publish(publication)).kind).toBe("PROPERTY_DELETED");
    const before = await publicationState(composed);

    expect(await publish(publication)).toEqual({ kind: "NOT_PUBLISHABLE" });
    expect(await repository.findValidationCandidates({ now: NOW + 5_000, limit: 25 })).toEqual([]);
    expect(
      await repository.claimDeliverableValidation({
        organizationId: composed.organizationId,
        deliverableVersionId: composed.deliverableVersionId,
        now: NOW + 5_000,
        leaseToken: "vlease_deleted_again",
        leaseExpiresAt: NOW + 20 * 60_000,
      }),
    ).toEqual({ kind: "NOT_ELIGIBLE" });
    expect(await publicationState(composed)).toEqual(before);
  });

  it("releases a hold on reconciliation the same way, as a terminal verdict would", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(composed);
    await prisma.generationReservation.update({
      where: { id: composed.reservationId },
      data: { state: "RECONCILIATION_HOLD" },
    });
    await deleteProperty();

    expect(await publish(publication)).toEqual({ kind: "PROPERTY_DELETED" });

    expect((await reservationOf(prisma, composed.reservationId)).state).toBe("RELEASED");
    expect(lastEvent(await eventsFor(prisma, composed.reservationId))).toEqual([
      "RECONCILIATION_HOLD",
      "RELEASED",
      "reservation.released",
      "PROPERTY_DELETED",
    ]);
    expect((await jobOf(prisma, composed.jobId)).state).toBe("FAILED_TERMINAL");
  });

  it("publishes a replacement whatever its Property: the customer's Unit was already spent", async () => {
    const first = await seedComposedDeliverable(prisma);
    expect((await publish(await validated(first))).kind).toBe("PUBLISHED_AND_CONSUMED");
    const second = await seedRecomposedDeliverable(prisma, first);
    const publication = await validated(second);
    await deleteProperty();
    const spent = await reservationOf(prisma, first.reservationId);

    expect(await publish(publication)).toEqual({ kind: "PUBLISHED_AS_REPLACEMENT" });

    const job = await jobOf(prisma, first.jobId);
    expect([job.state, job.currentDeliverableVersionId]).toEqual([
      "DELIVERABLE_READY",
      second.deliverableVersionId,
    ]);
    expect(await reservationOf(prisma, first.reservationId)).toEqual(spent);
  });

  it("does not judge a replay of a publication that already happened", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(composed);
    expect((await publish(publication)).kind).toBe("PUBLISHED_AND_CONSUMED");
    await deleteProperty();
    const before = await publicationState(composed);

    expect(await publish(publication)).toEqual({ kind: "ALREADY_PUBLISHED" });
    expect(await publicationState(composed)).toEqual(before);
  });

  it("ends nothing for a publication that is not the job's next", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(composed);
    await deleteProperty();
    const before = await publicationState(composed);

    // A stale verdict, a foreign version and a job that moved on are each
    // answered as before, and none of them fails the job or returns its Unit.
    expect(await publish({ ...publication, validationVersion: publication.validationVersion + 1 })).toEqual({
      kind: "NOT_PUBLISHABLE",
    });
    expect(await publicationState(composed)).toEqual(before);
    expect(before.job[0]).toBe("DELIVERABLE_VALIDATING");
    expect(before.reservation[0]).toBe("RESERVED");
    await expect(publish({ ...publication, generationJobId: "genjob_not_this_one" })).rejects.toThrow(
      expect.objectContaining({ code: "FOREIGN_DELIVERABLE_VERSION" }),
    );
    expect(await publicationState(composed)).toEqual(before);
  });

  it("publishes while the Property stands, and reads a Property only of the job's own organization", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(composed);
    // No key ties a project's Property to the project's organization; G's read does.
    await prisma.property.update({ where: { id: PROP_A }, data: { organizationId: ORG_B, status: "DELETED" } });
    try {
      expect(await publish(publication)).toEqual({ kind: "PUBLISHED_AND_CONSUMED" });
    } finally {
      await prisma.property.update({ where: { id: PROP_A }, data: { organizationId: ORG_A, status: "ACTIVE" } });
    }
    expect((await reservationOf(prisma, composed.reservationId)).state).toBe("CONSUMED");
  });

  it("writes nothing, and locks nothing of the job's, for another tenant's id", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(composed);
    await deleteProperty();
    const before = await publicationState(composed);
    const rows = await holdOpen(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "generation_reservations" WHERE "id" = ${composed.reservationId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "properties" WHERE "id" = ${PROP_A} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "generation_jobs" WHERE "id" = ${composed.jobId} FOR UPDATE`;
      // The other tenant's key for this job's cycle: what a cycle read across tenants would take.
      await holdCostAdmissionLock(tx, ORG_B);
    });
    try {
      const foreign = settled(publish({ ...publication, organizationId: ORG_B }));
      expect(await waitForBlocked(1, 1_000)).toBe(false);
      expect(await foreign.value).toEqual({ kind: "NOT_PUBLISHABLE" });
    } finally {
      await rows.release();
    }
    expect(await publicationState(composed)).toEqual(before);
  });

  it("locks no Property through another organization's job, even one now in the caller's organization", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(composed);
    await prisma.property.update({ where: { id: PROP_A }, data: { organizationId: ORG_B, status: "DELETED" } });
    try {
      const before = await publicationState(composed);
      const property = await holdOpen(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "properties" WHERE "id" = ${PROP_A} FOR UPDATE`;
      });
      try {
        const foreign = settled(publish({ ...publication, organizationId: ORG_B }));
        expect(await waitForBlocked(1, 1_000)).toBe(false);
        expect(await foreign.value).toEqual({ kind: "NOT_PUBLISHABLE" });
      } finally {
        await property.release();
      }
      expect(await publicationState(composed)).toEqual(before);
    } finally {
      await prisma.property.update({ where: { id: PROP_A }, data: { organizationId: ORG_A, status: "ACTIVE" } });
    }
  });

  it("shares the Property: one a launch commit holds FOR SHARE does not stop the publication", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(composed);
    const property = await holdOpen(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "properties" WHERE "id" = ${PROP_A} FOR SHARE`;
    });
    try {
      const publishing = settled(publish(publication));
      expect(await waitForBlocked(1, 1_000)).toBe(false);
      expect(await publishing.value).toEqual({ kind: "PUBLISHED_AND_CONSUMED" });
    } finally {
      await property.release();
    }
  });

  it("raises the same defect for a first video whose Unit is not held, whatever its Property", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(composed);
    await prisma.generationReservation.update({
      where: { id: composed.reservationId },
      data: { state: "RELEASED", releasedAt: new Date(NOW) },
    });
    await deleteProperty();
    const before = await publicationState(composed);

    await expect(publish(publication)).rejects.toThrow(
      expect.objectContaining({ code: "RESERVATION_NOT_CONSUMABLE" }),
    );
    expect(await publicationState(composed)).toEqual(before);
  });

  it("waits for a deletion already saving, then refuses the video", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(composed);
    const deletion = await holdOpen(async (tx) => {
      await tx.property.update({ where: { id: PROP_A }, data: { status: "DELETED" } });
    });
    const publishing = settled(publish(publication));
    expect(await waitForBlocked(1)).toBe(true);
    expect(publishing.done()).toBe(false);
    await deletion.release();

    expect(await publishing.value).toEqual({ kind: "PROPERTY_DELETED" });
    expect((await reservationOf(prisma, composed.reservationId)).state).toBe("RELEASED");
  });

  it("holds the Property until it commits, so a deletion saving waits for the published video", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(composed);
    const other = new PrismaClient();
    try {
      // G waits at the job, having taken the reservation and the Property.
      const job = await holdOpen(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "generation_jobs" WHERE "id" = ${composed.jobId} FOR UPDATE`;
      });
      const publishing = settled(publish(publication));
      expect(await waitForBlocked(1)).toBe(true);
      const deletion = settled(other.property.update({ where: { id: PROP_A }, data: { status: "DELETED" } }));
      expect(await waitForBlocked(2)).toBe(true);
      expect(deletion.done()).toBe(false);
      await job.release();

      // Read standing before the deletion saved: the customer's video, and its Unit spent.
      expect(await publishing.value).toEqual({ kind: "PUBLISHED_AND_CONSUMED" });
      await deletion.value;
      expect((await prisma.property.findUniqueOrThrow({ where: { id: PROP_A } })).status).toBe("DELETED");
    } finally {
      await other.$disconnect();
    }
  });

  it("takes the Property after the reservation and before the job", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(composed);
    const third = new PrismaClient();
    try {
      // Waiting at the reservation, G holds no Property yet.
      const reservation = await holdOpen(async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "generation_reservations" WHERE "id" = ${composed.reservationId} FOR UPDATE`;
      });
      const first = settled(publish(publication));
      expect(await waitForBlocked(1)).toBe(true);
      await third.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "properties" WHERE "id" = ${PROP_A} FOR UPDATE NOWAIT`;
      });
      await reservation.release();
      expect((await first.value).kind).toBe("PUBLISHED_AND_CONSUMED");

      // Waiting at the job, it holds the Property already.
      const second = await seedComposedDeliverable(prisma);
      const next = await validated(second);
      const job = await holdOpen(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "generation_jobs" WHERE "id" = ${second.jobId} FOR UPDATE`;
      });
      const publishing = settled(publish(next));
      expect(await waitForBlocked(1)).toBe(true);
      await expect(
        third.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "properties" WHERE "id" = ${PROP_A} FOR UPDATE NOWAIT`;
        }),
      ).rejects.toThrow();
      await job.release();
      expect((await publishing.value).kind).toBe("PUBLISHED_AND_CONSUMED");
    } finally {
      await third.$disconnect();
    }
  });

  it("waits for the cost-admission lock, taken before any row", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(composed);
    await deleteProperty();
    const lock = await holdOpen(async (tx) => {
      await holdCostAdmissionLock(tx, ORG_A);
    });
    const publishing = settled(publish(publication));
    expect(await waitForBlocked(1)).toBe(true);
    expect(publishing.done()).toBe(false);
    // No row of the job is locked while it waits.
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "generation_reservations" WHERE "id" = ${composed.reservationId} FOR UPDATE NOWAIT`;
      await tx.$queryRaw`SELECT "id" FROM "properties" WHERE "id" = ${PROP_A} FOR UPDATE NOWAIT`;
      await tx.$queryRaw`SELECT "id" FROM "generation_jobs" WHERE "id" = ${composed.jobId} FOR UPDATE NOWAIT`;
    });
    await lock.release();
    expect(await publishing.value).toEqual({ kind: "PROPERTY_DELETED" });
  });

  it("is what the validation runner reports for a deleted Property's video", async () => {
    const composed = await seedComposedDeliverable(prisma);
    await deleteProperty();
    let tick = 0;
    const runner = new DeliverableValidationRunner(
      {},
      {
        repository,
        validator: { validateDeliverable: async () => ({ kind: "VALID", facts: FACTS }) },
        clock: () => NOW + 1_000 * ++tick,
        leaseTokens: { next: () => `vlease_deleted_runner_${tick}` },
      },
    );

    expect(await runner.runOnce(10, ctx())).toEqual({
      claimed: 1,
      outcomes: [{ deliverableVersionId: composed.deliverableVersionId, outcome: { kind: "PROPERTY_DELETED" } }],
    });
    expect((await jobOf(prisma, composed.jobId)).state).toBe("FAILED_TERMINAL");
    expect((await reservationOf(prisma, composed.reservationId)).state).toBe("RELEASED");
    expect((await validationOf(prisma, composed.deliverableVersionId))?.status).toBe("VALID");
  });
});
