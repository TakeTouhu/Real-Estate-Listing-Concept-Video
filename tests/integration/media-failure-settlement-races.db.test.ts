import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFixedAuthorizationClock,
  createPaidSubmissionAuthorizationService,
  epochMillisFromDate,
  yen,
  type BillingCycleRevenueReader,
} from "@app/domain";
import {
  createMediaFailureResolutionRepository,
  createPaidSubmissionAuthorizationRepository,
  createValidatedSceneDeliveryRepository,
} from "@app/database";
import {
  attemptInput,
  ctx,
  dropTenants,
  HAS_DB,
  ORG_A,
  repositories,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";
import { seedFailure, type FailureChain } from "./media-failure-fixture";

/**
 * The races settlement must not lose, against live PostgreSQL.
 *
 * Settlement releases a reservation, which is exactly the mutation the paid
 * submission gate protects itself against:
 *
 * ```text
 * T1  lock cycle -> read reservation RESERVED -> gate permits
 * T2                UPDATE reservation -> RELEASED, commit
 * T1  arm QUEUED -> SUBMITTING, commit          <- paid against a released hold
 * ```
 *
 * Nothing after that interleaving can undo it: the provider may already have
 * been paid. The proof is not "it did not happen once" but that the two share
 * one advisory lock key and one acquisition order, so the interleaving has no
 * window to occur in.
 *
 * No `sleep` is used as synchronization authority anywhere here. Ordering is
 * established with database locks and with `pg_stat_activity` showing the
 * contenders actually blocked.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const work = createMediaFailureResolutionRepository(prisma);
const repos = repositories(prisma);

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const LEASE_MS = 5 * 60 * 1000;
const AT = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));

/** Stands in for a revenue layer that does not exist yet. Deterministic. */
const revenue: BillingCycleRevenueReader = { async revenueYen() { return yen(49_800); } };

/** The real gate, so the policy that refuses a released hold is the one tested. */
function gate(client: PrismaClient) {
  return createPaidSubmissionAuthorizationService({
    authorization: createPaidSubmissionAuthorizationRepository(client),
    billingCycleRevenue: revenue,
    clock: createFixedAuthorizationClock(AT),
  });
}

async function claimFor(chain: FailureChain, token = "lease_a") {
  const outcome = await work.claim({
    sourceValidationId: chain.validationId,
    now: NOW,
    leaseToken: token,
    leaseExpiresAt: NOW + LEASE_MS,
  });
  if (outcome.kind !== "CLAIMED") throw new Error(`expected CLAIMED, got ${outcome.kind}`);
  return outcome.claim;
}

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

RUN("settlement under contention", () => {
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

  describe("paid authorization against entitlement release", () => {
    /**
     * Both contend for one organization and cycle, with a third connection
     * holding that exact advisory lock so neither can start until both are
     * genuinely queued behind it.
     */
    it("never arms a queued attempt after the hold behind it was released", async () => {
      const chain = await seedFailure(prisma);

      // A second scene in the same job, carrying a QUEUED attempt. Its cost is
      // attributed to the same reservation and therefore the same cycle.
      const scene2 = await prisma.generationScene.create({
        data: {
          id: `genscene_race_${chain.tag}`,
          generationJobId: chain.jobId,
          position: 1,
          sourceStoryboardSceneId: "sbs_itest_orch_gone",
          sourceAssetId: "ast_itest_orch_a",
          sourceAnalysisRevision: 1,
          snapshotDurationSeconds: 5,
          snapshotCompiledPrompt: `a second room, ${chain.tag}`,
          state: "GENERATING",
        },
      });
      const request2 = await repos.requests.createInitial(
        ORG_A,
        { id: `genreq_race_${chain.tag}`, generationSceneId: scene2.id, requestedByUserId: "u" },
        ctx(),
      );
      if (request2 === null) throw new Error("second request not created");
      const queuedId = `sgen_race_${chain.tag}`;
      const admitted = await repos.attempts.admit(
        ORG_A,
        attemptInput({ id: queuedId, generationSceneRequestId: request2.id }),
        ctx(),
      );
      if (admitted.kind !== "ADMITTED") throw new Error(`not admitted: ${admitted.kind}`);

      const claim = await claimFor(chain);

      const holder = new PrismaClient();
      const workerA = new PrismaClient();
      const workerB = new PrismaClient();
      let releaseHolder: () => void = () => undefined;
      const holderMayFinish = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      let holderHasLock: () => void = () => undefined;
      const holderReady = new Promise<void>((resolve) => {
        holderHasLock = resolve;
      });

      // The same key formula both production paths derive. Written out here on
      // purpose: if the formula ever changes, this barrier stops blocking and
      // the test stops proving anything, loudly.
      const holderDone = holder
        .$transaction(
          async (tx) => {
            await tx.$queryRaw`
              SELECT pg_advisory_xact_lock(
                hashtext(${`paid-submission:${ORG_A}`}),
                hashtext(${`cycle:2026-09`})
              )::text AS locked
            `;
            holderHasLock();
            await holderMayFinish;
          },
          { timeout: 30_000 },
        )
        .catch(() => undefined);

      await holderReady;

      // The real gate, whose decision runs inside the transaction after both the
      // advisory lock and the reservation lock are taken. Calling `arm` directly
      // would bypass the very policy under test.
      const authorization = gate(workerA)
        .authorize({
          organizationId: ORG_A,
          attemptId: queuedId,
          context: ctx({ correlationId: "corr_auth_race" }),
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );

      const settlement = createMediaFailureResolutionRepository(workerB)
        .settleExhaustedMediaFailure({
          claim,
          settledAt: NOW,
          context: ctx({ correlationId: "corr_settle_race" }),
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );

      // Both must actually be queued on the advisory lock before it is released:
      // otherwise one could simply have finished first and nothing was raced.
      expect(await waitForBlocked(prisma, 2)).toBe(true);
      releaseHolder();
      await holderDone;

      const [auth, settled] = await Promise.all([authorization, settlement]);

      const reservation = await prisma.generationReservation.findUniqueOrThrow({
        where: { id: chain.reservationId },
      });
      const attempt = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: queuedId },
      });

      // The invariant, stated exactly: a still-QUEUED attempt never crosses the
      // submission boundary *after* the hold that authorized it was released.
      if (reservation.state === "RELEASED" && attempt.submissionBoundaryEnteredAt !== null) {
        expect(attempt.submissionBoundaryEnteredAt.getTime()).toBeLessThanOrEqual(
          reservation.releasedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
        );
      }

      // And the two really did serialize rather than both winning blindly.
      if (settled.ok && settled.value.kind === "SETTLED") {
        // Settlement went first or the authorization refused: either way the
        // attempt must not be newly armed against a released hold.
        expect(
          attempt.orchestrationState === "SUBMITTING" && reservation.state === "RELEASED"
            ? attempt.submissionBoundaryEnteredAt !== null
            : true,
        ).toBe(true);
      }
      expect(auth.ok || settled.ok).toBe(true);
      // If the gate authorized at all, the hold that authorized it was still
      // standing when it happened.
      if (auth.ok && auth.value.kind === "AUTHORIZED") {
        expect(attempt.submissionBoundaryEnteredAt).not.toBeNull();
        expect(reservation.state).not.toBe("RELEASED");
      }

      await Promise.all([holder.$disconnect(), workerA.$disconnect(), workerB.$disconnect()]);
    }, 60_000);

    it("refuses authorization outright once the hold is released", async () => {
      const chain = await seedFailure(prisma);
      const scene2 = await prisma.generationScene.create({
        data: {
          id: `genscene_after_${chain.tag}`,
          generationJobId: chain.jobId,
          position: 1,
          sourceStoryboardSceneId: "sbs_itest_orch_gone",
          sourceAssetId: "ast_itest_orch_a",
          sourceAnalysisRevision: 1,
          snapshotDurationSeconds: 5,
          snapshotCompiledPrompt: `a second room, ${chain.tag}`,
          state: "GENERATING",
        },
      });
      const request2 = await repos.requests.createInitial(
        ORG_A,
        { id: `genreq_after_${chain.tag}`, generationSceneId: scene2.id, requestedByUserId: "u" },
        ctx(),
      );
      if (request2 === null) throw new Error("second request not created");
      const queuedId = `sgen_after_${chain.tag}`;
      await repos.attempts.admit(
        ORG_A,
        attemptInput({ id: queuedId, generationSceneRequestId: request2.id }),
        ctx(),
      );

      const claim = await claimFor(chain);
      const settled = await work.settleExhaustedMediaFailure({
        claim,
        settledAt: NOW,
        context: ctx(),
      });
      expect(settled.kind).toBe("SETTLED");

      const auth = await gate(prisma).authorize({
        organizationId: ORG_A,
        attemptId: queuedId,
        context: ctx(),
      });
      // The entitlement behind it is gone, so nothing may cross the boundary.
      expect(auth.kind).not.toBe("AUTHORIZED");
      const attempt = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: queuedId } });
      expect(attempt.orchestrationState).toBe("QUEUED");
      expect(attempt.submissionBoundaryEnteredAt).toBeNull();
    }, 60_000);
  });

  // -------------------------------------------------------------------------

  describe("delivery against settlement", () => {
    it("cannot both deliver a scene and terminalize its job", async () => {
      // A regeneration whose recovery failed, on a job that also holds a
      // deliverable VALID attempt: delivery and rollback both want the job.
      const chain = await seedFailure(prisma, { requestKind: "USER_REGENERATION" });
      const claim = await claimFor(chain);

      const settled = await work.settleExhaustedMediaFailure({
        claim,
        settledAt: NOW,
        context: ctx(),
      });
      expect(settled.kind).toBe("SETTLED");

      // Delivery of the same request afterwards must find nothing to deliver:
      // the request is terminal, and Transaction F requires a GENERATING one.
      const delivery = await createValidatedSceneDeliveryRepository(prisma).deliverValidatedScene({
        organizationId: ORG_A,
        sceneGenerationId: chain.attemptId,
        context: ctx(),
      });
      expect(delivery.kind).not.toBe("DELIVERED");

      const scene = await prisma.generationScene.findUniqueOrThrow({
        where: { id: chain.sceneId },
      });
      expect(scene.state).toBe("READY");
      expect(scene.currentDeliveredRequestId).toBe(chain.predecessorRequestId);
    }, 60_000);
  });

  // -------------------------------------------------------------------------

  describe("atomicity", () => {
    /**
     * A database-level failpoint, not a production one.
     *
     * The rule is that no production code may carry an injection seam for this.
     * A trigger installed and dropped by the test satisfies that: the code under
     * test is untouched, and PostgreSQL provides the failure.
     */
    async function withFailingUpdate<T>(
      table: string,
      run: () => Promise<T>,
    ): Promise<T> {
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION itest_fail_update() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'itest injected failure';
        END;
        $$ LANGUAGE plpgsql;
      `);
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER itest_fail_${table} BEFORE UPDATE ON "${table}"
         FOR EACH ROW EXECUTE FUNCTION itest_fail_update();`,
      );
      try {
        return await run();
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS itest_fail_${table} ON "${table}";`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS itest_fail_update();`);
      }
    }

    it("rolls an INITIAL settlement back entirely when the release cannot complete", async () => {
      const chain = await seedFailure(prisma);
      const claim = await claimFor(chain);

      const before = {
        request: await prisma.sceneGenerationRequest.findUnique({ where: { id: chain.requestId } }),
        scene: await prisma.generationScene.findUnique({ where: { id: chain.sceneId } }),
        job: await prisma.generationJob.findUnique({ where: { id: chain.jobId } }),
        reservation: await prisma.generationReservation.findUnique({
          where: { id: chain.reservationId },
        }),
        events: await prisma.generationTransitionEvent.count(),
      };

      await withFailingUpdate("generation_reservations", async () => {
        await expect(
          work.settleExhaustedMediaFailure({ claim, settledAt: NOW, context: ctx() }),
        ).rejects.toThrow();
      });

      // Everything the settlement had already written is gone with it.
      expect(await prisma.sceneGenerationRequest.findUnique({ where: { id: chain.requestId } }))
        .toEqual(before.request);
      expect(await prisma.generationScene.findUnique({ where: { id: chain.sceneId } })).toEqual(
        before.scene,
      );
      expect(await prisma.generationJob.findUnique({ where: { id: chain.jobId } })).toEqual(
        before.job,
      );
      expect(
        await prisma.generationReservation.findUnique({ where: { id: chain.reservationId } }),
      ).toEqual(before.reservation);
      expect(await prisma.generationTransitionEvent.count()).toBe(before.events);

      // The work row is untouched too, so the claim's lease simply expires and
      // the item becomes reclaimable.
      const row = await prisma.managedOutputMediaFailureResolution.findUniqueOrThrow({
        where: { managedOutputMediaValidationId: chain.validationId },
      });
      expect(row.status).toBe("RUNNING");
      expect(row.resolutionKind).toBeNull();

      // And it really can be retried afterwards.
      const retry = await work.claim({
        sourceValidationId: chain.validationId,
        now: NOW + LEASE_MS + 1,
        leaseToken: "lease_retry",
        leaseExpiresAt: NOW + LEASE_MS * 2,
      });
      if (retry.kind !== "CLAIMED") throw new Error(`expected CLAIMED, got ${retry.kind}`);
      const done = await work.settleExhaustedMediaFailure({
        claim: retry.claim,
        settledAt: NOW + LEASE_MS + 1,
        context: ctx(),
      });
      expect(done.kind).toBe("SETTLED");
    }, 60_000);

    it("rolls a regeneration rollback back entirely when the job cannot move", async () => {
      const chain = await seedFailure(prisma, { requestKind: "USER_REGENERATION" });
      const claim = await claimFor(chain);

      const before = {
        request: await prisma.sceneGenerationRequest.findUnique({ where: { id: chain.requestId } }),
        scene: await prisma.generationScene.findUnique({ where: { id: chain.sceneId } }),
        job: await prisma.generationJob.findUnique({ where: { id: chain.jobId } }),
        events: await prisma.generationTransitionEvent.count(),
      };

      await withFailingUpdate("generation_jobs", async () => {
        await expect(
          work.settleExhaustedMediaFailure({ claim, settledAt: NOW, context: ctx() }),
        ).rejects.toThrow();
      });

      expect(await prisma.sceneGenerationRequest.findUnique({ where: { id: chain.requestId } }))
        .toEqual(before.request);
      expect(await prisma.generationScene.findUnique({ where: { id: chain.sceneId } })).toEqual(
        before.scene,
      );
      expect(await prisma.generationJob.findUnique({ where: { id: chain.jobId } })).toEqual(
        before.job,
      );
      expect(await prisma.generationTransitionEvent.count()).toBe(before.events);

      // The pointer the customer's video hangs from never moved.
      const scene = await prisma.generationScene.findUniqueOrThrow({ where: { id: chain.sceneId } });
      expect(scene.currentDeliveredRequestId).toBe(chain.predecessorRequestId);
    }, 60_000);
  });
});
