import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DeliverableCompositionExecutionDefect,
  managedDeliverableOutputKey,
  managedGenerationOutputKey,
  safePositiveByteCount,
  sha256Digest,
  type ClaimCompositionWorkOutcome,
  type DeliverableCompositionClaim,
} from "@app/domain";
import { createDeliverableCompositionExecutionRepository } from "@app/database";
import { ctx, dropTenants, HAS_DB, ORG_A, ORG_B, seedTenants, wipeOrchestration } from "./orchestration-fixture";
import {
  compositionOf,
  eventCount,
  eventsFor,
  jobOf,
  seedPlannedDeliverable,
} from "./deliverable-composition-execution-fixture";
import { worldSnapshot } from "./deliverable-composition-fixture";

/**
 * Transactions J1, J2, defer and block against live PostgreSQL.
 *
 * The unit suites prove the routing — which failure is a retry and which is a
 * refusal. What only a database can prove is that the durable row agrees: that
 * `BLOCKED` really does clear the retry code and the next attempt instant, that
 * the job is left exactly where it was, that no transition event is written for
 * a state change that did not happen, and that a blocked row is never handed
 * back by discovery.
 *
 * Nothing here composes anything. No `ffmpeg`, no `ffprobe`, no object store.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const repository = createDeliverableCompositionExecutionRepository(prisma);

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const LEASE_MS = 30 * 60_000;
const OUTPUT_SHA = sha256Digest("d".repeat(64));
const OUTPUT_BYTES = safePositiveByteCount(4_096);

let leaseSeq = 0;

async function claim(
  organizationId: string,
  deliverableVersionId: string,
  now = NOW,
): Promise<ClaimCompositionWorkOutcome> {
  leaseSeq += 1;
  return repository.claimCompositionWork({
    organizationId,
    deliverableVersionId,
    now,
    leaseToken: `clease_itest_${leaseSeq}`,
    leaseExpiresAt: now + LEASE_MS,
    context: ctx(),
  });
}

async function claimed(
  organizationId: string,
  deliverableVersionId: string,
  now = NOW,
): Promise<DeliverableCompositionClaim> {
  const outcome = await claim(organizationId, deliverableVersionId, now);
  if (outcome.kind !== "CLAIMED") throw new Error(`expected CLAIMED, got ${outcome.kind}`);
  return outcome.claim;
}

RUN("Phase 5B — durable composition execution", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // J1 — the first claim
  // -------------------------------------------------------------------------

  describe("J1 creates the work row and moves the job, or does neither", () => {
    it("creates RUNNING work and moves COMPOSITION_PENDING -> COMPOSING together", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const claimOutcome = await claimed(ORG_A, planned.deliverableVersionId);

      const work = await compositionOf(prisma, planned.deliverableVersionId);
      expect(work?.status).toBe("RUNNING");
      expect(work?.attemptCount).toBe(1);
      expect(work?.version).toBe(1);
      expect(work?.leaseToken).toBe(claimOutcome.leaseToken);
      expect(work?.leaseExpiresAt?.getTime()).toBe(NOW + LEASE_MS);
      expect(work?.nextAttemptAt).toBeNull();
      expect(work?.lastRetryCode).toBeNull();
      expect(work?.blockCode).toBeNull();
      expect(work?.blockedAt).toBeNull();
      expect((await jobOf(prisma, planned.jobId)).state).toBe("COMPOSING");
    });

    it("returns the plan in position order with the frozen receipts and keys", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const result = await claimed(ORG_A, planned.deliverableVersionId);

      expect(result.scenes.map((one) => one.position)).toEqual([0, 1]);
      expect(result.requestedDurationSeconds).toBe(10);
      for (const scene of result.scenes) {
        expect(scene.durationSeconds).toBe(5);
        expect(scene.sourceStorageKey).toBe(
          managedGenerationOutputKey({
            organizationId: ORG_A,
            attemptId: scene.sceneGenerationAttemptId,
          }),
        );
      }
      expect(result.outputStorageKey).toBe(
        managedDeliverableOutputKey({
          organizationId: ORG_A,
          deliverableVersionId: planned.deliverableVersionId,
        }),
      );
    });

    it("freezes profile v1 onto the row from the job's delivery target", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      await claimed(ORG_A, planned.deliverableVersionId);
      const work = await compositionOf(prisma, planned.deliverableVersionId);
      expect(work?.profileKey).toBe("vtavision-compose:v1");
      expect(work?.targetWidthPx).toBe(1920);
      expect(work?.targetHeightPx).toBe(1080);
      expect(work?.frameRateNumerator).toBe(30);
      expect(work?.frameRateDenominator).toBe(1);
      expect(work?.crf).toBe(18);
      expect(work?.videoCodec).toBe("h264");
      expect(work?.pixelFormat).toBe("yuv420p");
    });

    it("appends exactly one deliverable event and one job event", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const before = await eventCount(prisma);
      await claimed(ORG_A, planned.deliverableVersionId);

      const deliverableEvents = await eventsFor(prisma, planned.deliverableVersionId);
      const jobEvents = await eventsFor(prisma, planned.jobId);
      expect(deliverableEvents.at(-1)?.toState).toBe("COMPOSING");
      expect(jobEvents.at(-1)?.fromState).toBe("COMPOSITION_PENDING");
      expect(jobEvents.at(-1)?.toState).toBe("COMPOSING");
      expect(await eventCount(prisma)).toBe(before + 2);
    });

    it("refuses a job whose target is outside profile v1, writing nothing at all", async () => {
      const planned = await seedPlannedDeliverable(prisma, { targetAspectRatio: "21:9" });
      const before = await worldSnapshot(prisma);

      expect((await claim(ORG_A, planned.deliverableVersionId)).kind).toBe("UNSUPPORTED_TARGET");

      expect(await compositionOf(prisma, planned.deliverableVersionId)).toBeNull();
      expect((await jobOf(prisma, planned.jobId)).state).toBe("COMPOSITION_PENDING");
      expect(await worldSnapshot(prisma)).toEqual(before);
    });

    it("refuses every aspect ratio outside the three v1 composes", async () => {
      for (const targetAspectRatio of ["21:9", "4:3", "16:9 ", "", "HD"]) {
        const planned = await seedPlannedDeliverable(prisma, { targetAspectRatio });
        expect((await claim(ORG_A, planned.deliverableVersionId)).kind).toBe("UNSUPPORTED_TARGET");
        expect(await compositionOf(prisma, planned.deliverableVersionId)).toBeNull();
      }
    });

    it("cannot be reached through the resolution, because the schema bounds it", async () => {
      // `generation_jobs_target_resolution_check` already restricts the column
      // to exactly the two resolutions profile v1 composes, so an unsupported
      // resolution is not a state a real job can be in. The profile's own
      // refusal for it is defence against a future product tier being added to
      // the job vocabulary without being added to the raster table -- and this
      // test records that the aspect ratio, which is free-form TEXT, is the
      // only reachable vector today.
      await expect(
        seedPlannedDeliverable(prisma, { targetOutputResolution: "4k" }),
      ).rejects.toThrow();
    });

    it("reports a version belonging to another organization as missing", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      expect((await claim(ORG_B, planned.deliverableVersionId)).kind).toBe("NOT_FOUND");
      expect(await compositionOf(prisma, planned.deliverableVersionId)).toBeNull();
      expect((await jobOf(prisma, planned.jobId)).state).toBe("COMPOSITION_PENDING");
    });

    it("refuses a second first-claim while the first lease is live", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      await claimed(ORG_A, planned.deliverableVersionId);
      expect((await claim(ORG_A, planned.deliverableVersionId, NOW + 60_000)).kind).toBe(
        "NOT_CLAIMABLE",
      );
      const work = await compositionOf(prisma, planned.deliverableVersionId);
      expect(work?.attemptCount).toBe(1);
      expect(work?.version).toBe(1);
    });

    it("reclaims after the lease expires, bumping the attempt without touching the job", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      await claimed(ORG_A, planned.deliverableVersionId);
      const jobEventsBefore = (await eventsFor(prisma, planned.jobId)).length;

      const again = await claimed(ORG_A, planned.deliverableVersionId, NOW + LEASE_MS + 1);
      expect(again.attemptCount).toBe(2);
      expect(again.version).toBe(2);
      expect((await jobOf(prisma, planned.jobId)).state).toBe("COMPOSING");
      // A second COMPOSITION_PENDING -> COMPOSING event would record a state
      // change that did not happen.
      expect((await eventsFor(prisma, planned.jobId)).length).toBe(jobEventsBefore);
    });
  });

  // -------------------------------------------------------------------------
  // Defer
  // -------------------------------------------------------------------------

  describe("defer returns work to PENDING with a retry code and a future instant", () => {
    it("records the code, clears the lease and leaves the job alone", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const result = await claimed(ORG_A, planned.deliverableVersionId);
      const jobEvents = (await eventsFor(prisma, planned.jobId)).length;
      const totalEvents = await eventCount(prisma);

      expect(
        await repository.deferComposition({
          claim: result,
          retryCode: "SOURCE_READ_RETRYABLE",
          nextAttemptAt: NOW + 300_000,
        }),
      ).toEqual({ kind: "DEFERRED" });

      const work = await compositionOf(prisma, planned.deliverableVersionId);
      expect(work?.status).toBe("PENDING");
      expect(work?.lastRetryCode).toBe("SOURCE_READ_RETRYABLE");
      expect(work?.nextAttemptAt?.getTime()).toBe(NOW + 300_000);
      expect(work?.leaseToken).toBeNull();
      expect(work?.leaseExpiresAt).toBeNull();
      expect(work?.version).toBe(2);
      expect((await jobOf(prisma, planned.jobId)).state).toBe("COMPOSING");
      // A deferral is not a customer-visible fact.
      expect((await eventsFor(prisma, planned.jobId)).length).toBe(jobEvents);
      expect(await eventCount(prisma)).toBe(totalEvents);
    });

    it("clears the retry code again when the work is reclaimed", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const first = await claimed(ORG_A, planned.deliverableVersionId);
      await repository.deferComposition({
        claim: first,
        retryCode: "COMPOSER_RETRYABLE",
        nextAttemptAt: NOW + 300_000,
      });
      await claimed(ORG_A, planned.deliverableVersionId, NOW + 300_001);

      const work = await compositionOf(prisma, planned.deliverableVersionId);
      expect(work?.status).toBe("RUNNING");
      // RUNNING work is not deferred for anything, so "why it is waiting" must
      // not survive into it.
      expect(work?.lastRetryCode).toBeNull();
    });

    it("refuses a deferral from a worker whose lease moved on", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const stale = await claimed(ORG_A, planned.deliverableVersionId);
      await claimed(ORG_A, planned.deliverableVersionId, NOW + LEASE_MS + 1);

      expect(
        await repository.deferComposition({
          claim: stale,
          retryCode: "SOURCE_READ_RETRYABLE",
          nextAttemptAt: NOW + 900_000,
        }),
      ).toEqual({ kind: "LEASE_LOST" });
      expect((await compositionOf(prisma, planned.deliverableVersionId))?.status).toBe("RUNNING");
    });
  });

  // -------------------------------------------------------------------------
  // Block
  // -------------------------------------------------------------------------

  describe("block ends automatic work and nothing else", () => {
    it("clears the retry code, the lease and the next attempt, and records the reason", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const first = await claimed(ORG_A, planned.deliverableVersionId);
      await repository.deferComposition({
        claim: first,
        retryCode: "SOURCE_READ_RETRYABLE",
        nextAttemptAt: NOW + 300_000,
      });
      const second = await claimed(ORG_A, planned.deliverableVersionId, NOW + 300_001);

      expect(
        await repository.blockComposition({
          claim: second,
          blockCode: "SOURCE_INTEGRITY_MISMATCH",
          blockedAt: NOW + 400_000,
          context: ctx(),
        }),
      ).toEqual({ kind: "BLOCKED" });

      const work = await compositionOf(prisma, planned.deliverableVersionId);
      expect(work?.status).toBe("BLOCKED");
      expect(work?.blockCode).toBe("SOURCE_INTEGRITY_MISMATCH");
      expect(work?.blockedAt?.getTime()).toBe(NOW + 400_000);
      // The earlier transient reason does not survive: it would show an
      // operator two competing explanations for one row.
      expect(work?.lastRetryCode).toBeNull();
      expect(work?.nextAttemptAt).toBeNull();
      expect(work?.leaseToken).toBeNull();
      expect(work?.leaseExpiresAt).toBeNull();
      expect(work?.outputStorageKey).toBeNull();
      expect(work?.outputSha256).toBeNull();
      expect(work?.outputSizeBytes).toBeNull();
      expect(work?.outputVerifiedAt).toBeNull();
      // `attemptCount` already records that the work was tried.
      expect(work?.attemptCount).toBe(2);
      expect(work?.version).toBe(4);
    });

    it("appends no transition event, on either aggregate", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const result = await claimed(ORG_A, planned.deliverableVersionId);
      const deliverableEvents = (await eventsFor(prisma, planned.deliverableVersionId)).length;
      const jobEvents = (await eventsFor(prisma, planned.jobId)).length;
      const total = await eventCount(prisma);

      await repository.blockComposition({
        claim: result,
        blockCode: "OUTPUT_SIZE_LIMIT_EXCEEDED",
        blockedAt: NOW + 1_000,
        context: ctx(),
      });

      expect((await eventsFor(prisma, planned.deliverableVersionId)).length).toBe(deliverableEvents);
      expect((await eventsFor(prisma, planned.jobId)).length).toBe(jobEvents);
      expect(await eventCount(prisma)).toBe(total);
    });

    it("leaves the job COMPOSING, its pointer, its units and its reservation untouched", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const jobBefore = await jobOf(prisma, planned.jobId);
      const reservationBefore = await prisma.generationReservation.findUniqueOrThrow({
        where: { id: planned.reservationId },
      });
      const result = await claimed(ORG_A, planned.deliverableVersionId);

      await repository.blockComposition({
        claim: result,
        blockCode: "DURATION_INVARIANT_MISMATCH",
        blockedAt: NOW + 1_000,
        context: ctx(),
      });

      const jobAfter = await jobOf(prisma, planned.jobId);
      expect(jobAfter.state).toBe("COMPOSING");
      expect(jobAfter.currentDeliverableVersionId).toBe(jobBefore.currentDeliverableVersionId);
      expect(jobAfter.requiredVideoUnits).toBe(jobBefore.requiredVideoUnits);
      // The job moved COMPOSITION_PENDING -> COMPOSING at claim; blocking moved
      // it no further, so its state version is the claim's and nothing else.
      expect(jobAfter.stateVersion).toBe(jobBefore.stateVersion + 1);
      expect(
        await prisma.generationReservation.findUniqueOrThrow({
          where: { id: planned.reservationId },
        }),
      ).toEqual(reservationBefore);
    });

    for (const blockCode of [
      "SOURCE_BYTES_LIMIT_EXCEEDED",
      "DURATION_INVARIANT_MISMATCH",
      "SOURCE_INTEGRITY_MISMATCH",
      "OUTPUT_SIZE_LIMIT_EXCEEDED",
    ] as const) {
      it(`persists ${blockCode}`, async () => {
        const planned = await seedPlannedDeliverable(prisma);
        const result = await claimed(ORG_A, planned.deliverableVersionId);
        await repository.blockComposition({
          claim: result,
          blockCode,
          blockedAt: NOW + 1_000,
          context: ctx(),
        });
        expect((await compositionOf(prisma, planned.deliverableVersionId))?.blockCode).toBe(
          blockCode,
        );
      });
    }

    it("replays the same code without rewriting the instant, the version or history", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const result = await claimed(ORG_A, planned.deliverableVersionId);
      await repository.blockComposition({
        claim: result,
        blockCode: "SOURCE_INTEGRITY_MISMATCH",
        blockedAt: NOW + 1_000,
        context: ctx(),
      });
      const after = await compositionOf(prisma, planned.deliverableVersionId);
      const total = await eventCount(prisma);

      expect(
        await repository.blockComposition({
          claim: result,
          blockCode: "SOURCE_INTEGRITY_MISMATCH",
          // A much later instant, which must not be adopted.
          blockedAt: NOW + 9_999_999,
          context: ctx(),
        }),
      ).toEqual({ kind: "ALREADY_BLOCKED" });

      expect(await compositionOf(prisma, planned.deliverableVersionId)).toEqual(after);
      expect(await eventCount(prisma)).toBe(total);
    });

    it("refuses a different code for an already-blocked row, and writes nothing", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const result = await claimed(ORG_A, planned.deliverableVersionId);
      await repository.blockComposition({
        claim: result,
        blockCode: "SOURCE_INTEGRITY_MISMATCH",
        blockedAt: NOW + 1_000,
        context: ctx(),
      });
      const after = await compositionOf(prisma, planned.deliverableVersionId);

      await expect(
        repository.blockComposition({
          claim: result,
          blockCode: "OUTPUT_SIZE_LIMIT_EXCEEDED",
          blockedAt: NOW + 2_000,
          context: ctx(),
        }),
      ).rejects.toBeInstanceOf(DeliverableCompositionExecutionDefect);

      expect(await compositionOf(prisma, planned.deliverableVersionId)).toEqual(after);
    });

    it("refuses a block from a worker whose lease moved on", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const stale = await claimed(ORG_A, planned.deliverableVersionId);
      await claimed(ORG_A, planned.deliverableVersionId, NOW + LEASE_MS + 1);

      expect(
        await repository.blockComposition({
          claim: stale,
          blockCode: "SOURCE_INTEGRITY_MISMATCH",
          blockedAt: NOW + 1_000,
          context: ctx(),
        }),
      ).toEqual({ kind: "LEASE_LOST" });
      expect((await compositionOf(prisma, planned.deliverableVersionId))?.status).toBe("RUNNING");
    });

    it("never hands blocked work back to a claim", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const result = await claimed(ORG_A, planned.deliverableVersionId);
      await repository.blockComposition({
        claim: result,
        blockCode: "SOURCE_BYTES_LIMIT_EXCEEDED",
        blockedAt: NOW + 1_000,
        context: ctx(),
      });

      for (const at of [NOW + 2_000, NOW + LEASE_MS + 1, NOW + 86_400_000]) {
        expect((await claim(ORG_A, planned.deliverableVersionId, at)).kind).toBe("NOT_CLAIMABLE");
      }
      expect((await compositionOf(prisma, planned.deliverableVersionId))?.status).toBe("BLOCKED");
    });
  });

  // -------------------------------------------------------------------------
  // The database refuses an impossible BLOCKED row
  // -------------------------------------------------------------------------

  describe("the status shape constraint refuses what TypeScript cannot", () => {
    async function blockedRow(planned: { deliverableVersionId: string }) {
      const result = await claimed(ORG_A, planned.deliverableVersionId);
      await repository.blockComposition({
        claim: result,
        blockCode: "SOURCE_INTEGRITY_MISMATCH",
        blockedAt: NOW + 1_000,
        context: ctx(),
      });
      return compositionOf(prisma, planned.deliverableVersionId);
    }

    it("refuses BLOCKED with a next attempt a sweep would honour", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const work = await blockedRow(planned);
      await expect(
        prisma.generationDeliverableComposition.update({
          where: { id: work!.id },
          data: { nextAttemptAt: new Date(NOW + 60_000) },
        }),
      ).rejects.toThrow();
    });

    it("refuses BLOCKED carrying a retry code", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const work = await blockedRow(planned);
      await expect(
        prisma.generationDeliverableComposition.update({
          where: { id: work!.id },
          data: { lastRetryCode: "SOURCE_READ_RETRYABLE" },
        }),
      ).rejects.toThrow();
    });

    it("refuses BLOCKED holding a lease", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const work = await blockedRow(planned);
      await expect(
        prisma.generationDeliverableComposition.update({
          where: { id: work!.id },
          data: { leaseToken: "clease_x", leaseExpiresAt: new Date(NOW + 60_000) },
        }),
      ).rejects.toThrow();
    });

    it("refuses BLOCKED carrying an output receipt", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const work = await blockedRow(planned);
      await expect(
        prisma.generationDeliverableComposition.update({
          where: { id: work!.id },
          data: {
            outputStorageKey: "org/x/deliverables/y/output",
            outputSha256: OUTPUT_SHA,
            outputSizeBytes: BigInt(OUTPUT_BYTES),
            outputVerifiedAt: new Date(NOW),
          },
        }),
      ).rejects.toThrow();
    });

    it("refuses BLOCKED without a reason, and without an instant", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const work = await blockedRow(planned);
      for (const data of [{ blockCode: null }, { blockedAt: null }]) {
        await expect(
          prisma.generationDeliverableComposition.update({ where: { id: work!.id }, data }),
        ).rejects.toThrow();
      }
    });

    it("refuses a block reason on any other status", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const result = await claimed(ORG_A, planned.deliverableVersionId);
      await expect(
        prisma.generationDeliverableComposition.update({
          where: { id: result.compositionId },
          data: { blockCode: "SOURCE_INTEGRITY_MISMATCH", blockedAt: new Date(NOW) },
        }),
      ).rejects.toThrow();
    });

    it("refuses a retry code on RUNNING", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const result = await claimed(ORG_A, planned.deliverableVersionId);
      await expect(
        prisma.generationDeliverableComposition.update({
          where: { id: result.compositionId },
          data: { lastRetryCode: "COMPOSER_RETRYABLE" },
        }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // J2 — finalize
  // -------------------------------------------------------------------------

  describe("J2 writes the receipt and moves COMPOSING -> DELIVERABLE_VALIDATING", () => {
    async function finalize(claimValue: DeliverableCompositionClaim) {
      return repository.finalizeComposition({
        claim: claimValue,
        outputSha256: OUTPUT_SHA,
        outputSizeBytes: OUTPUT_BYTES,
        verifiedAt: NOW + 60_000,
        context: ctx(),
      });
    }

    it("writes the receipt, clears the lease and moves the job in one transaction", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const result = await claimed(ORG_A, planned.deliverableVersionId);

      expect(await finalize(result)).toEqual({ kind: "FINALIZED" });

      const work = await compositionOf(prisma, planned.deliverableVersionId);
      expect(work?.status).toBe("OUTPUT_VERIFIED");
      expect(work?.outputSha256).toBe(OUTPUT_SHA);
      expect(work?.outputSizeBytes).toBe(BigInt(OUTPUT_BYTES));
      expect(work?.outputStorageKey).toBe(
        managedDeliverableOutputKey({
          organizationId: ORG_A,
          deliverableVersionId: planned.deliverableVersionId,
        }),
      );
      expect(work?.outputVerifiedAt?.getTime()).toBe(NOW + 60_000);
      expect(work?.leaseToken).toBeNull();
      expect(work?.lastRetryCode).toBeNull();
      expect(work?.blockCode).toBeNull();
      expect((await jobOf(prisma, planned.jobId)).state).toBe("DELIVERABLE_VALIDATING");
    });

    it("leaves the customer's current deliverable pointer exactly where it was", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const before = await jobOf(prisma, planned.jobId);
      const result = await claimed(ORG_A, planned.deliverableVersionId);
      await finalize(result);
      expect((await jobOf(prisma, planned.jobId)).currentDeliverableVersionId).toBe(
        before.currentDeliverableVersionId,
      );
    });

    it("replays the identical receipt without a second event", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const result = await claimed(ORG_A, planned.deliverableVersionId);
      await finalize(result);
      const total = await eventCount(prisma);
      const after = await compositionOf(prisma, planned.deliverableVersionId);

      expect(await finalize(result)).toEqual({ kind: "ALREADY_FINALIZED" });
      expect(await eventCount(prisma)).toBe(total);
      expect(await compositionOf(prisma, planned.deliverableVersionId)).toEqual(after);
    });

    it("refuses a different receipt for an already-verified deliverable", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const result = await claimed(ORG_A, planned.deliverableVersionId);
      await finalize(result);

      await expect(
        repository.finalizeComposition({
          claim: result,
          outputSha256: sha256Digest("e".repeat(64)),
          outputSizeBytes: OUTPUT_BYTES,
          verifiedAt: NOW + 120_000,
          context: ctx(),
        }),
      ).rejects.toBeInstanceOf(DeliverableCompositionExecutionDefect);
    });

    it("refuses a finalize from a worker whose lease moved on", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const stale = await claimed(ORG_A, planned.deliverableVersionId);
      await claimed(ORG_A, planned.deliverableVersionId, NOW + LEASE_MS + 1);
      expect(await finalize(stale)).toEqual({ kind: "LEASE_LOST" });
      expect((await compositionOf(prisma, planned.deliverableVersionId))?.status).toBe("RUNNING");
    });

    it("reports a verified deliverable to a later claim, rather than re-running it", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const result = await claimed(ORG_A, planned.deliverableVersionId);
      await finalize(result);
      expect((await claim(ORG_A, planned.deliverableVersionId, NOW + 999_999)).kind).toBe(
        "ALREADY_VERIFIED",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  describe("candidate discovery is bounded, tenant-agnostic and never offers dead work", () => {
    it("offers a planned deliverable nobody has claimed", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const rows = await repository.findCompositionCandidates({ limit: 10, now: NOW });
      expect(rows.map((one) => one.deliverableVersionId)).toContain(planned.deliverableVersionId);
      expect(rows.every((one) => one.organizationId === ORG_A)).toBe(true);
    });

    it("stops offering it once a live lease exists, and offers it again when that expires", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      await claimed(ORG_A, planned.deliverableVersionId);

      const held = await repository.findCompositionCandidates({ limit: 10, now: NOW + 60_000 });
      expect(held.map((one) => one.deliverableVersionId)).not.toContain(
        planned.deliverableVersionId,
      );

      const expired = await repository.findCompositionCandidates({
        limit: 10,
        now: NOW + LEASE_MS + 1,
      });
      expect(expired.map((one) => one.deliverableVersionId)).toContain(
        planned.deliverableVersionId,
      );
    });

    it("offers deferred work only at or after its next attempt", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const result = await claimed(ORG_A, planned.deliverableVersionId);
      await repository.deferComposition({
        claim: result,
        retryCode: "SOURCE_READ_RETRYABLE",
        nextAttemptAt: NOW + 300_000,
      });

      expect(
        (await repository.findCompositionCandidates({ limit: 10, now: NOW + 299_999 })).map(
          (one) => one.deliverableVersionId,
        ),
      ).not.toContain(planned.deliverableVersionId);
      expect(
        (await repository.findCompositionCandidates({ limit: 10, now: NOW + 300_000 })).map(
          (one) => one.deliverableVersionId,
        ),
      ).toContain(planned.deliverableVersionId);
    });

    it("never offers blocked work, at any instant", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const result = await claimed(ORG_A, planned.deliverableVersionId);
      await repository.blockComposition({
        claim: result,
        blockCode: "DURATION_INVARIANT_MISMATCH",
        blockedAt: NOW + 1_000,
        context: ctx(),
      });

      for (const now of [NOW, NOW + LEASE_MS + 1, NOW + 86_400_000, NOW + 31_536_000_000]) {
        const rows = await repository.findCompositionCandidates({ limit: 25, now });
        expect(rows.map((one) => one.deliverableVersionId)).not.toContain(
          planned.deliverableVersionId,
        );
      }
    });

    it("never offers a verified deliverable", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const result = await claimed(ORG_A, planned.deliverableVersionId);
      await repository.finalizeComposition({
        claim: result,
        outputSha256: OUTPUT_SHA,
        outputSizeBytes: OUTPUT_BYTES,
        verifiedAt: NOW + 60_000,
        context: ctx(),
      });
      const rows = await repository.findCompositionCandidates({ limit: 10, now: NOW + 999_999 });
      expect(rows.map((one) => one.deliverableVersionId)).not.toContain(
        planned.deliverableVersionId,
      );
    });

    it("never offers a job whose target is outside profile v1", async () => {
      const composable = await seedPlannedDeliverable(prisma);
      const unsupported = await seedPlannedDeliverable(prisma, { targetAspectRatio: "21:9" });
      const alsoUnsupported = await seedPlannedDeliverable(prisma, { targetAspectRatio: "4:3" });

      const rows = await repository.findCompositionCandidates({ limit: 25, now: NOW });
      const ids = rows.map((one) => one.deliverableVersionId);
      expect(ids).toContain(composable.deliverableVersionId);
      expect(ids).not.toContain(unsupported.deliverableVersionId);
      expect(ids).not.toContain(alsoUnsupported.deliverableVersionId);
    });

    it("offers every composable target pair", async () => {
      const wanted: string[] = [];
      for (const [targetAspectRatio, targetOutputResolution] of [
        ["16:9", "720p"],
        ["16:9", "1080p"],
        ["9:16", "720p"],
        ["9:16", "1080p"],
        ["1:1", "720p"],
        ["1:1", "1080p"],
      ] as const) {
        const planned = await seedPlannedDeliverable(prisma, {
          targetAspectRatio,
          targetOutputResolution,
        });
        wanted.push(planned.deliverableVersionId);
      }
      const rows = await repository.findCompositionCandidates({ limit: 25, now: NOW });
      const ids = rows.map((one) => one.deliverableVersionId);
      for (const id of wanted) expect(ids).toContain(id);
    });

    it("honours its bound and refuses an unusable one", async () => {
      await seedPlannedDeliverable(prisma);
      await seedPlannedDeliverable(prisma);
      expect(await repository.findCompositionCandidates({ limit: 1, now: NOW })).toHaveLength(1);
      for (const limit of [0, -1, 1.5, 26, Number.NaN]) {
        await expect(repository.findCompositionCandidates({ limit, now: NOW })).rejects.toThrow();
      }
    });
  });

  // -------------------------------------------------------------------------
  // The read model
  // -------------------------------------------------------------------------

  describe("the read model is tenant-scoped", () => {
    it("returns the row to its owner and nothing to anyone else", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const result = await claimed(ORG_A, planned.deliverableVersionId);
      await repository.blockComposition({
        claim: result,
        blockCode: "OUTPUT_SIZE_LIMIT_EXCEEDED",
        blockedAt: NOW + 1_000,
        context: ctx(),
      });

      const mine = await repository.findCompositionByVersionId(
        ORG_A,
        planned.deliverableVersionId,
      );
      expect(mine?.status).toBe("BLOCKED");
      expect(mine?.blockCode).toBe("OUTPUT_SIZE_LIMIT_EXCEEDED");
      expect(mine?.lastRetryCode).toBeNull();
      expect(
        await repository.findCompositionByVersionId(ORG_B, planned.deliverableVersionId),
      ).toBeNull();
    });
  });
});
