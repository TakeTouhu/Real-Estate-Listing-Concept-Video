import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { safePositiveByteCount, sha256Digest } from "@app/domain";
import { createDeliverableCompositionExecutionRepository } from "@app/database";
import {
  ctx,
  dropTenants,
  HAS_DB,
  ORG_A,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";
import {
  compositionOf,
  eventCount,
  eventsFor,
  jobOf,
  seedPlannedDeliverable,
} from "./deliverable-composition-execution-fixture";

/**
 * The races composition *execution* must not lose, against live PostgreSQL.
 *
 * Duplicate execution is designed for rather than prevented — a lease can expire
 * under a healthy worker — so what has to hold is that only one of the racers
 * ever writes history. Three contentions are proved:
 *
 * **Two first claims.** Exactly one work row is created, exactly one job moves,
 * and exactly one pair of events is appended. The loser is refused, never
 * handed a duplicate lease.
 *
 * **Two finishers.** One finalize and one block reach a row whose lease has
 * moved on; the stale one writes nothing at all.
 *
 * **A block racing a finalize.** Whichever commits first, the row ends in one
 * of the two states and the other caller is told it lost — never a row that is
 * both verified and blocked.
 *
 * No `sleep` is a synchronization authority. Ordering is established with a real
 * row lock held by a third connection, and `pg_stat_activity` is consulted to
 * prove the contenders are genuinely blocked before the barrier is released.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const repository = createDeliverableCompositionExecutionRepository(prisma);

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const LEASE_MS = 30 * 60_000;
const SHA = sha256Digest("f".repeat(64));
const BYTES = safePositiveByteCount(4_096);

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
 * Hold the Job row exclusively on a connection of its own.
 *
 * Every execution transaction locks the Job first, so each contender queues
 * behind this. Without it one contender simply finishes before the other begins
 * and nothing was raced.
 */
async function jobBarrier(jobId: string) {
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
        await tx.$queryRaw`SELECT "id" FROM "generation_jobs" WHERE "id" = ${jobId} FOR UPDATE`;
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

function claimVia(
  client: PrismaClient,
  deliverableVersionId: string,
  now = NOW,
) {
  leaseSeq += 1;
  return createDeliverableCompositionExecutionRepository(client).claimCompositionWork({
    organizationId: ORG_A,
    deliverableVersionId,
    now,
    leaseToken: `clease_race_${leaseSeq}`,
    leaseExpiresAt: now + LEASE_MS,
    context: ctx(),
  });
}

RUN("composition execution under contention", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  it("admits exactly one first claim when two workers race", async () => {
    const planned = await seedPlannedDeliverable(prisma);
    const before = await eventCount(prisma);
    const barrier = await jobBarrier(planned.jobId);
    const a = new PrismaClient();
    const b = new PrismaClient();

    try {
      const first = settled(claimVia(a, planned.deliverableVersionId));
      const second = settled(claimVia(b, planned.deliverableVersionId));
      expect(await waitForBlocked(prisma, 2)).toBe(true);
      await barrier.release();

      const outcomes = [await first, await second];
      const kinds = outcomes.map((one) => (one.ok ? one.value.kind : "THREW")).sort();
      expect(kinds).toEqual(["CLAIMED", "NOT_CLAIMABLE"]);

      const work = await compositionOf(prisma, planned.deliverableVersionId);
      expect(work?.status).toBe("RUNNING");
      expect(work?.attemptCount).toBe(1);
      expect(work?.version).toBe(1);
      expect((await jobOf(prisma, planned.jobId)).state).toBe("COMPOSING");
      // One deliverable event and one job event, not two of each.
      expect(await eventCount(prisma)).toBe(before + 2);
      expect((await eventsFor(prisma, planned.jobId)).filter((e) => e.toState === "COMPOSING")).toHaveLength(
        1,
      );
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  });

  it("lets exactly one of two racing reclaims take the expired lease", async () => {
    const planned = await seedPlannedDeliverable(prisma);
    const initial = await claimVia(prisma, planned.deliverableVersionId);
    expect(initial.kind).toBe("CLAIMED");

    const at = NOW + LEASE_MS + 1;
    const barrier = await jobBarrier(planned.jobId);
    const a = new PrismaClient();
    const b = new PrismaClient();

    try {
      const first = settled(claimVia(a, planned.deliverableVersionId, at));
      const second = settled(claimVia(b, planned.deliverableVersionId, at));
      expect(await waitForBlocked(prisma, 2)).toBe(true);
      await barrier.release();

      const kinds = [await first, await second]
        .map((one) => (one.ok ? one.value.kind : "THREW"))
        .sort();
      expect(kinds).toEqual(["CLAIMED", "NOT_CLAIMABLE"]);

      const work = await compositionOf(prisma, planned.deliverableVersionId);
      // One reclaim, so exactly one increment of each counter.
      expect(work?.attemptCount).toBe(2);
      expect(work?.version).toBe(2);
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  });

  it("lets the stale worker's finalize write nothing after a reclaim", async () => {
    const planned = await seedPlannedDeliverable(prisma);
    const stale = await claimVia(prisma, planned.deliverableVersionId);
    if (stale.kind !== "CLAIMED") throw new Error("expected a claim");
    const fresh = await claimVia(prisma, planned.deliverableVersionId, NOW + LEASE_MS + 1);
    if (fresh.kind !== "CLAIMED") throw new Error("expected a reclaim");

    const before = await compositionOf(prisma, planned.deliverableVersionId);
    const events = await eventCount(prisma);

    expect(
      await repository.finalizeComposition({
        claim: stale.claim,
        outputSha256: SHA,
        outputSizeBytes: BYTES,
        verifiedAt: NOW + 120_000,
        context: ctx(),
      }),
    ).toEqual({ kind: "LEASE_LOST" });

    expect(await compositionOf(prisma, planned.deliverableVersionId)).toEqual(before);
    expect(await eventCount(prisma)).toBe(events);
    expect((await jobOf(prisma, planned.jobId)).state).toBe("COMPOSING");
  });

  it("lets the stale worker's block write nothing after a reclaim", async () => {
    const planned = await seedPlannedDeliverable(prisma);
    const stale = await claimVia(prisma, planned.deliverableVersionId);
    if (stale.kind !== "CLAIMED") throw new Error("expected a claim");
    await claimVia(prisma, planned.deliverableVersionId, NOW + LEASE_MS + 1);

    const before = await compositionOf(prisma, planned.deliverableVersionId);
    const events = await eventCount(prisma);

    expect(
      await repository.blockComposition({
        claim: stale.claim,
        blockCode: "SOURCE_INTEGRITY_MISMATCH",
        blockedAt: NOW + 120_000,
        context: ctx(),
      }),
    ).toEqual({ kind: "LEASE_LOST" });

    expect(await compositionOf(prisma, planned.deliverableVersionId)).toEqual(before);
    expect(await eventCount(prisma)).toBe(events);
  });

  it("never lets a finalize and a block both land on one deliverable", async () => {
    const planned = await seedPlannedDeliverable(prisma);
    const held = await claimVia(prisma, planned.deliverableVersionId);
    if (held.kind !== "CLAIMED") throw new Error("expected a claim");

    const barrier = await jobBarrier(planned.jobId);
    const a = new PrismaClient();
    const b = new PrismaClient();

    try {
      const finalizing = settled(
        createDeliverableCompositionExecutionRepository(a).finalizeComposition({
          claim: held.claim,
          outputSha256: SHA,
          outputSizeBytes: BYTES,
          verifiedAt: NOW + 60_000,
          context: ctx(),
        }),
      );
      const blocking = settled(
        createDeliverableCompositionExecutionRepository(b).blockComposition({
          claim: held.claim,
          blockCode: "OUTPUT_SIZE_LIMIT_EXCEEDED",
          blockedAt: NOW + 60_000,
          context: ctx(),
        }),
      );
      expect(await waitForBlocked(prisma, 2)).toBe(true);
      await barrier.release();

      const finalizeOutcome = await finalizing;
      const blockOutcome = await blocking;

      const work = await compositionOf(prisma, planned.deliverableVersionId);
      expect(["OUTPUT_VERIFIED", "BLOCKED"]).toContain(work?.status);

      if (work?.status === "OUTPUT_VERIFIED") {
        expect(finalizeOutcome.ok && finalizeOutcome.value.kind).toBe("FINALIZED");
        expect(blockOutcome.ok && blockOutcome.value.kind).toBe("LEASE_LOST");
        expect(work.blockCode).toBeNull();
        expect(work.blockedAt).toBeNull();
        expect((await jobOf(prisma, planned.jobId)).state).toBe("DELIVERABLE_VALIDATING");
      } else {
        expect(blockOutcome.ok && blockOutcome.value.kind).toBe("BLOCKED");
        expect(finalizeOutcome.ok && finalizeOutcome.value.kind).toBe("LEASE_LOST");
        expect(work?.outputSha256).toBeNull();
        expect(work?.lastRetryCode).toBeNull();
        // Blocking moves no job, so a lost finalize leaves it composing.
        expect((await jobOf(prisma, planned.jobId)).state).toBe("COMPOSING");
      }
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  });

  it("never lets a defer and a block both land on one deliverable", async () => {
    const planned = await seedPlannedDeliverable(prisma);
    const held = await claimVia(prisma, planned.deliverableVersionId);
    if (held.kind !== "CLAIMED") throw new Error("expected a claim");

    const barrier = await jobBarrier(planned.jobId);
    const a = new PrismaClient();
    const b = new PrismaClient();

    try {
      const deferring = settled(
        createDeliverableCompositionExecutionRepository(a).deferComposition({
          claim: held.claim,
          retryCode: "SOURCE_READ_RETRYABLE",
          nextAttemptAt: NOW + 300_000,
        }),
      );
      const blocking = settled(
        createDeliverableCompositionExecutionRepository(b).blockComposition({
          claim: held.claim,
          blockCode: "SOURCE_INTEGRITY_MISMATCH",
          blockedAt: NOW + 60_000,
          context: ctx(),
        }),
      );
      expect(await waitForBlocked(prisma, 2)).toBe(true);
      await barrier.release();

      await deferring;
      await blocking;

      const work = await compositionOf(prisma, planned.deliverableVersionId);
      // Whichever won, the two reasons never coexist: a deferred row states why
      // it is waiting, a blocked row states why it never will be.
      if (work?.status === "BLOCKED") {
        expect(work.lastRetryCode).toBeNull();
        expect(work.nextAttemptAt).toBeNull();
        expect(work.blockCode).toBe("SOURCE_INTEGRITY_MISMATCH");
      } else {
        expect(work?.status).toBe("PENDING");
        expect(work?.blockCode).toBeNull();
        expect(work?.blockedAt).toBeNull();
        expect(work?.lastRetryCode).toBe("SOURCE_READ_RETRYABLE");
      }
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  });
});
