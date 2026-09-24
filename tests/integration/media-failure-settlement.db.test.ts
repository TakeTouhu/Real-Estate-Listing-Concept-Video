import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createMediaFailureResolutionRepository } from "@app/database";
import {
  ctx,
  dropTenants,
  HAS_DB,
  ORG_A,
  ORG_B,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";
import { seedFailure, workRow, type FailureChain } from "./media-failure-fixture";

/**
 * Transaction H against live PostgreSQL.
 *
 * The commercial rule under test is one sentence: **a provider or system failure
 * never consumes the customer's Unit.** Which shape that takes depends on what
 * the customer already has:
 *
 * ```text
 * INITIAL            -> nothing delivered -> fail everything, RELEASE the hold
 * USER_REGENERATION  -> a delivered video -> fail only the new request, roll back
 * ```
 *
 * Every assertion about "unchanged" compares the row whole rather than one
 * column, because the failure that matters is a settlement quietly moving
 * something nobody thought to check.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const work = createMediaFailureResolutionRepository(prisma);

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const LEASE_MS = 5 * 60 * 1000;

async function claimFor(chain: FailureChain, token = "lease_a", at = NOW) {
  const outcome = await work.claim({
    sourceValidationId: chain.validationId,
    now: at,
    leaseToken: token,
    leaseExpiresAt: at + LEASE_MS,
  });
  if (outcome.kind !== "CLAIMED") throw new Error(`expected CLAIMED, got ${outcome.kind}`);
  return outcome.claim;
}

async function settle(chain: FailureChain, at = NOW, token = "lease_a") {
  const claim = await claimFor(chain, token, at);
  return work.settleExhaustedMediaFailure({
    claim,
    settledAt: at,
    context: ctx({ correlationId: "corr_settle" }),
  });
}

async function snapshot(chain: FailureChain) {
  return {
    request: await prisma.sceneGenerationRequest.findUnique({ where: { id: chain.requestId } }),
    scene: await prisma.generationScene.findUnique({ where: { id: chain.sceneId } }),
    job: await prisma.generationJob.findUnique({ where: { id: chain.jobId } }),
    reservation: await prisma.generationReservation.findUnique({
      where: { id: chain.reservationId },
    }),
    attempt: await prisma.sceneGeneration.findUnique({ where: { id: chain.attemptId } }),
    validation: await prisma.managedOutputMediaValidation.findUnique({
      where: { id: chain.validationId },
    }),
    attemptCount: await prisma.sceneGeneration.count({
      where: { generationSceneRequestId: chain.requestId },
    }),
  };
}

RUN("exhausted media failure settlement", () => {
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

  // -------------------------------------------------------------------------

  describe("an INITIAL failure: the customer got nothing", () => {
    it("fails the request, scene and job and releases the hold, all at one instant", async () => {
      const chain = await seedFailure(prisma);
      const before = await snapshot(chain);

      const outcome = await settle(chain);

      expect(outcome).toEqual({
        kind: "SETTLED",
        resolutionKind: "INITIAL_FAILURE_SETTLED",
        settledAt: NOW,
      });
      const after = await snapshot(chain);

      expect(after.request?.state).toBe("FAILED_TERMINAL");
      expect(after.request?.failedAt?.getTime()).toBe(NOW);
      expect(after.request?.stateVersion).toBe((before.request?.stateVersion ?? 0) + 1);

      expect(after.scene?.state).toBe("FAILED_TERMINAL");
      expect(after.scene?.stateVersion).toBe((before.scene?.stateVersion ?? 0) + 1);

      expect(after.job?.state).toBe("FAILED_TERMINAL");
      expect(after.job?.stateVersion).toBe((before.job?.stateVersion ?? 0) + 1);

      // The Unit comes back. This is the whole point of the phase.
      expect(after.reservation?.state).toBe("RELEASED");
      expect(after.reservation?.releasedAt?.getTime()).toBe(NOW);
      expect(after.reservation?.stateVersion).toBe((before.reservation?.stateVersion ?? 0) + 1);

      // One instant, not three that happened to be close together.
      expect(after.request?.failedAt?.getTime()).toBe(after.reservation?.releasedAt?.getTime());

      const row = await workRow(prisma, chain.validationId);
      expect(row).toMatchObject({ status: "RESOLVED", resolutionKind: "INITIAL_FAILURE_SETTLED" });
      expect(row?.resolvedAt?.getTime()).toBe(NOW);
    });

    it("releases a reservation held for reconciliation too", async () => {
      const chain = await seedFailure(prisma, { reservationState: "RECONCILIATION_HOLD" });
      const outcome = await settle(chain);
      expect(outcome.kind).toBe("SETTLED");
      const reservation = await prisma.generationReservation.findUnique({
        where: { id: chain.reservationId },
      });
      expect(reservation?.state).toBe("RELEASED");
    });

    it("never consumes a unit", async () => {
      const chain = await seedFailure(prisma);
      await settle(chain);
      const reservation = await prisma.generationReservation.findUnique({
        where: { id: chain.reservationId },
      });
      expect(reservation?.state).not.toBe("CONSUMED");
      expect(reservation?.consumedAt).toBeNull();
    });

    it("writes exactly one event per aggregate", async () => {
      const chain = await seedFailure(prisma);
      await settle(chain);

      const events = await prisma.generationTransitionEvent.findMany({
        where: { toState: "FAILED_TERMINAL" },
      });
      const failed = events.filter((e) =>
        [chain.requestId, chain.sceneId, chain.jobId].includes(e.aggregateId),
      );
      expect(failed).toHaveLength(3);
      expect(failed.map((e) => e.aggregateType).sort()).toEqual(["JOB", "SCENE", "SCENE_REQUEST"]);

      const released = await prisma.generationTransitionEvent.findMany({
        where: { aggregateId: chain.reservationId, toState: "RELEASED" },
      });
      expect(released).toHaveLength(1);
      expect(released[0]?.aggregateType).toBe("RESERVATION");
    });

    it("creates no attempt and mutates no historical evidence", async () => {
      const chain = await seedFailure(prisma);
      const before = await snapshot(chain);

      await settle(chain);

      const after = await snapshot(chain);
      expect(after.attemptCount).toBe(before.attemptCount);
      // The failed recovery and its verdict are historical evidence, compared
      // whole rather than column by column.
      expect(after.attempt).toEqual(before.attempt);
      expect(after.validation).toEqual(before.validation);
    });
  });

  // -------------------------------------------------------------------------

  describe("what authorizes settlement", () => {
    it("refuses to settle from the PRIMARY failure while its recovery may still run", async () => {
      const chain = await seedFailure(prisma, { attemptKind: "PRIMARY" });
      const claim = await claimFor(chain);
      // Not even offered as a settlement: the disposition is a recovery.
      expect(claim.disposition.kind).toBe("ADMIT_RECOVERY");

      const outcome = await work.settleExhaustedMediaFailure({
        claim,
        settledAt: NOW,
        context: ctx(),
      });
      expect(outcome.kind).toBe("NOT_EXHAUSTED");
      const request = await prisma.sceneGenerationRequest.findUnique({
        where: { id: chain.requestId },
      });
      expect(request?.state).toBe("GENERATING");
    });

    it("refuses when the verdict is not a terminal media failure", async () => {
      const chain = await seedFailure(prisma, { failure: "VALID" });
      const outcome = await work.claim({
        sourceValidationId: chain.validationId,
        now: NOW,
        leaseToken: "lease_a",
        leaseExpiresAt: NOW + LEASE_MS,
      });
      expect(outcome.kind).toBe("NOT_ELIGIBLE");
    });

    it("raises rather than settling when the verdict is bound to other bytes", async () => {
      const chain = await seedFailure(prisma, { receiptSha256: "f".repeat(64) });
      await expect(
        work.claim({
          sourceValidationId: chain.validationId,
          now: NOW,
          leaseToken: "lease_a",
          leaseExpiresAt: NOW + LEASE_MS,
        }),
      ).rejects.toMatchObject({ code: "SOURCE_RECEIPT_BINDING_CONFLICT" });
    });

    it("refuses a superseded recovery, even though it is a recovery", async () => {
      // Being the automatic recovery is not enough: it must also still be the
      // request's latest attempt. A newer attempt means something else is in
      // flight, and terminalizing from an older failure would fail a customer
      // whose work is still running.
      const chain = await seedFailure(prisma);
      const claim = await claimFor(chain);

      // Make the failed recovery no longer the request's latest attempt, by
      // moving its already-terminal PRIMARY sibling past it. Simpler than
      // inserting a whole new attempt row, and it produces the exact condition
      // under test: a SYSTEM_RECOVERY failure that something newer has overtaken.
      await prisma.sceneGeneration.update({
        where: { id: `sgen_${chain.tag}_p` },
        data: { attemptOrdinal: 3 },
      });

      const outcome = await work.settleExhaustedMediaFailure({
        claim,
        settledAt: NOW,
        context: ctx(),
      });
      expect(outcome.kind).toBe("NOT_EXHAUSTED");
      const request = await prisma.sceneGenerationRequest.findUnique({
        where: { id: chain.requestId },
      });
      expect(request?.state).toBe("GENERATING");
    });

    it("refuses a claim whose lease token is wrong even when its version matches", async () => {
      const chain = await seedFailure(prisma);
      const claim = await claimFor(chain);

      const outcome = await work.settleExhaustedMediaFailure({
        claim: { ...claim, leaseToken: "lease_not_mine" },
        settledAt: NOW,
        context: ctx(),
      });
      expect(outcome.kind).toBe("NOT_EXHAUSTED");
      const request = await prisma.sceneGenerationRequest.findUnique({
        where: { id: chain.requestId },
      });
      expect(request?.state).toBe("GENERATING");
    });

    it("refuses a stale claim whose lease was reclaimed", async () => {
      const chain = await seedFailure(prisma);
      const stale = await claimFor(chain, "lease_a", NOW);
      // Somebody else reclaims after expiry.
      await claimFor(chain, "lease_b", NOW + LEASE_MS + 1);

      const outcome = await work.settleExhaustedMediaFailure({
        claim: stale,
        settledAt: NOW,
        context: ctx(),
      });
      expect(outcome.kind).toBe("NOT_EXHAUSTED");
      const request = await prisma.sceneGenerationRequest.findUnique({
        where: { id: chain.requestId },
      });
      expect(request?.state).toBe("GENERATING");
    });
  });

  // -------------------------------------------------------------------------

  describe("idempotency", () => {
    it("reports an exactly-settled INITIAL failure as already settled, changing nothing", async () => {
      const chain = await seedFailure(prisma);
      await settle(chain);
      const after = await snapshot(chain);
      const row = await workRow(prisma, chain.validationId);

      // A second claim finds terminal work and never reopens it.
      const again = await work.claim({
        sourceValidationId: chain.validationId,
        now: NOW + LEASE_MS * 5,
        leaseToken: "lease_b",
        leaseExpiresAt: NOW + LEASE_MS * 6,
      });
      expect(again).toEqual({
        kind: "ALREADY_RESOLVED",
        resolutionKind: "INITIAL_FAILURE_SETTLED",
      });

      expect(await snapshot(chain)).toEqual(after);
      expect(await workRow(prisma, chain.validationId)).toEqual(row);
    });

    it("raises rather than reporting a partial settlement as already settled", async () => {
      // The settlement path's own view of an already-settled shape. Every row
      // must match; a half-applied one is a defect and is never completed
      // quietly, because finishing it would destroy the evidence of how it
      // happened.
      const chain = await seedFailure(prisma);
      const claim = await claimFor(chain);
      const first = await work.settleExhaustedMediaFailure({
        claim,
        settledAt: NOW,
        context: ctx(),
      });
      expect(first.kind).toBe("SETTLED");

      // Something outside this system undoes one row of it.
      await prisma.generationJob.update({
        where: { id: chain.jobId },
        data: { state: "GENERATING" },
      });

      await expect(
        work.settleExhaustedMediaFailure({ claim, settledAt: NOW + 1, context: ctx() }),
      ).rejects.toMatchObject({ code: "PARTIAL_SETTLEMENT" });
    });

    it("raises on a partially undone regeneration rollback too", async () => {
      const chain = await seedFailure(prisma, { requestKind: "USER_REGENERATION" });
      const claim = await claimFor(chain);
      expect(
        (await work.settleExhaustedMediaFailure({ claim, settledAt: NOW, context: ctx() })).kind,
      ).toBe("SETTLED");

      // The scene's delivered pointer is cleared by something else.
      await prisma.generationScene.update({
        where: { id: chain.sceneId },
        data: { currentDeliveredRequestId: null },
      });

      await expect(
        work.settleExhaustedMediaFailure({ claim, settledAt: NOW + 1, context: ctx() }),
      ).rejects.toMatchObject({ code: "PARTIAL_SETTLEMENT" });
    });

    it("refuses to repair a partial settlement", async () => {
      const chain = await seedFailure(prisma);
      await settle(chain);
      // Half the settlement is undone by something outside this system.
      await prisma.generationReservation.update({
        where: { id: chain.reservationId },
        data: { state: "RESERVED", releasedAt: null },
      });

      await expect(
        work.claim({
          sourceValidationId: chain.validationId,
          now: NOW + LEASE_MS * 5,
          leaseToken: "lease_b",
          leaseExpiresAt: NOW + LEASE_MS * 6,
        }),
      ).resolves.toMatchObject({ kind: "ALREADY_RESOLVED" });

      // The settlement path itself is where the partial shape is a defect: it
      // is never quietly finished, because that would destroy the evidence.
      const row = await prisma.managedOutputMediaFailureResolution.findUniqueOrThrow({
        where: { managedOutputMediaValidationId: chain.validationId },
      });
      expect(row.status).toBe("RESOLVED");
      const reservation = await prisma.generationReservation.findUnique({
        where: { id: chain.reservationId },
      });
      expect(reservation?.state).toBe("RESERVED");
    });
  });

  // -------------------------------------------------------------------------

  describe("a USER_REGENERATION failure: the customer keeps their video", () => {
    it("fails only the new request and rolls the scene and job back", async () => {
      const chain = await seedFailure(prisma, { requestKind: "USER_REGENERATION" });
      const before = await snapshot(chain);

      const outcome = await settle(chain);

      expect(outcome).toEqual({
        kind: "SETTLED",
        resolutionKind: "USER_REGENERATION_ROLLED_BACK",
        settledAt: NOW,
      });
      const after = await snapshot(chain);

      expect(after.request?.state).toBe("FAILED_TERMINAL");
      expect(after.request?.failedAt?.getTime()).toBe(NOW);

      // The scene is READY again, and its pointer never moved: that pointer is
      // the customer's video.
      expect(after.scene?.state).toBe("READY");
      expect(after.scene?.currentDeliveredRequestId).toBe(chain.predecessorRequestId);
      expect(after.scene?.currentDeliveredRequestId).toBe(
        before.scene?.currentDeliveredRequestId,
      );

      expect(after.job?.state).toBe("DELIVERABLE_READY");
      expect(after.job?.currentDeliverableVersionId).toBe(
        before.job?.currentDeliverableVersionId,
      );

      // The consumed hold belongs to the delivered video. Releasing it would
      // refund a Unit that already produced something the customer can watch.
      expect(after.reservation).toEqual(before.reservation);

      expect(await workRow(prisma, chain.validationId)).toMatchObject({
        status: "RESOLVED",
        resolutionKind: "USER_REGENERATION_ROLLED_BACK",
      });
    });

    it("does not consume the regeneration entitlement, so the ordinal returns", async () => {
      const chain = await seedFailure(prisma, { requestKind: "USER_REGENERATION" });
      await settle(chain);

      const failed = await prisma.sceneGenerationRequest.findUnique({
        where: { id: chain.requestId },
      });
      // Entitlement is derived from delivery, and this request delivered nothing.
      expect(failed?.deliveredAt).toBeNull();
      expect(failed?.userRegenerationOrdinal).toBe(1);

      const delivered = await prisma.sceneGenerationRequest.count({
        where: {
          generationSceneId: chain.sceneId,
          kind: "USER_REGENERATION",
          state: "DELIVERED",
        },
      });
      expect(delivered).toBe(0);
    });

    it("reports an exactly-rolled-back regeneration as already resolved", async () => {
      const chain = await seedFailure(prisma, { requestKind: "USER_REGENERATION" });
      await settle(chain);
      const after = await snapshot(chain);

      const again = await work.claim({
        sourceValidationId: chain.validationId,
        now: NOW + LEASE_MS * 5,
        leaseToken: "lease_b",
        leaseExpiresAt: NOW + LEASE_MS * 6,
      });
      expect(again).toMatchObject({
        kind: "ALREADY_RESOLVED",
        resolutionKind: "USER_REGENERATION_ROLLED_BACK",
      });
      expect(await snapshot(chain)).toEqual(after);
    });

    it("fails closed when another scene of the job is mid-revision", async () => {
      const chain = await seedFailure(prisma, { requestKind: "USER_REGENERATION" });
      // A second scene in the same job, also revising. Nothing durable records
      // which scene versions the current deliverable was composed from, so a
      // rollback target cannot be determined.
      await prisma.generationScene.create({
        data: {
          id: `genscene_sib_${chain.tag}`,
          generationJobId: chain.jobId,
          position: 1,
          sourceStoryboardSceneId: "sbs_itest_orch_gone",
          sourceAssetId: "ast_itest_orch_a",
          sourceAnalysisRevision: 1,
          snapshotDurationSeconds: 5,
          state: "REVISING",
        },
      });

      const claim = await claimFor(chain);
      await expect(
        work.settleExhaustedMediaFailure({ claim, settledAt: NOW, context: ctx() }),
      ).rejects.toMatchObject({ code: "CONCURRENT_REVISION_AMBIGUOUS" });

      // Nothing moved.
      const after = await snapshot(chain);
      expect(after.request?.state).toBe("GENERATING");
      expect(after.job?.state).toBe("GENERATING");
      expect(after.scene?.state).toBe("REVISING");
    });

    it("fails closed when the delivered pointer names nothing delivered", async () => {
      const chain = await seedFailure(prisma, { requestKind: "USER_REGENERATION" });
      await prisma.sceneGenerationRequest.update({
        where: { id: chain.predecessorRequestId ?? "" },
        data: { state: "FAILED_TERMINAL", deliveredAt: null },
      });

      const claim = await claimFor(chain);
      await expect(
        work.settleExhaustedMediaFailure({ claim, settledAt: NOW, context: ctx() }),
      ).rejects.toMatchObject({ code: "DELIVERED_PREDECESSOR_MISBOUND" });
    });
  });

  // -------------------------------------------------------------------------

  describe("concurrency", () => {
    it("settles exactly once when two workers reach the same exhausted failure", async () => {
      const chain = await seedFailure(prisma);

      // Only one claim can exist at a time, which is the first serialization.
      const a = await work.claim({
        sourceValidationId: chain.validationId,
        now: NOW,
        leaseToken: "lease_a",
        leaseExpiresAt: NOW + LEASE_MS,
      });
      const b = await work.claim({
        sourceValidationId: chain.validationId,
        now: NOW,
        leaseToken: "lease_b",
        leaseExpiresAt: NOW + LEASE_MS,
      });
      expect([a.kind, b.kind].sort()).toEqual(["CLAIMED", "NOT_CLAIMED"]);
      if (a.kind !== "CLAIMED") throw new Error("expected the first to win");

      const first = await work.settleExhaustedMediaFailure({
        claim: a.claim,
        settledAt: NOW,
        context: ctx(),
      });
      expect(first.kind).toBe("SETTLED");

      // A second settlement with the same (now consumed) claim changes nothing.
      const second = await work.settleExhaustedMediaFailure({
        claim: a.claim,
        settledAt: NOW + 1,
        context: ctx(),
      });
      expect(second).toMatchObject({
        kind: "ALREADY_SETTLED",
        resolutionKind: "INITIAL_FAILURE_SETTLED",
      });

      // Exactly one of each event.
      const events = await prisma.generationTransitionEvent.findMany({
        where: { aggregateId: { in: [chain.requestId, chain.sceneId, chain.jobId] } },
        });
      expect(events.filter((e) => e.toState === "FAILED_TERMINAL")).toHaveLength(3);
      const released = await prisma.generationTransitionEvent.count({
        where: { aggregateId: chain.reservationId, toState: "RELEASED" },
      });
      expect(released).toBe(1);
    });
  });

  // -------------------------------------------------------------------------

  describe("tenancy", () => {
    it("settles another organization's failure under that organization, never the caller's", async () => {
      const chain = await seedFailure(prisma, { organizationId: ORG_B });
      const claim = await claimFor(chain);
      expect(claim.organizationId).toBe(ORG_B);

      await work.settleExhaustedMediaFailure({ claim, settledAt: NOW, context: ctx() });
      const events = await prisma.generationTransitionEvent.findMany({
        where: { aggregateId: chain.jobId },
      });
      expect(events.every((e) => e.organizationId === ORG_B)).toBe(true);
      expect(events.some((e) => e.organizationId === ORG_A)).toBe(false);
    });

    it("mutates nothing for a claim naming another organization's work", async () => {
      const chain = await seedFailure(prisma, { organizationId: ORG_B });
      const claim = await claimFor(chain);
      const before = await snapshot(chain);

      const outcome = await work.settleExhaustedMediaFailure({
        claim: { ...claim, organizationId: ORG_A },
        settledAt: NOW,
        context: ctx(),
      });
      expect(outcome.kind).toBe("NOT_FOUND");
      expect(await snapshot(chain)).toEqual(before);
    });
  });
});
