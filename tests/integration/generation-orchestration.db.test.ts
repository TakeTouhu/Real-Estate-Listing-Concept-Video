import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  costRiskProfile,
  reconciliationDeadlineFrom,
  sanitizeTransitionMetadata,
  type TransitionContext,
} from "@app/domain";
import {
  ASSET_A,
  ctx,
  domainSnapshot,
  dropTenants,
  H3_MAX_IDENTITY,
  HAS_DB,
  ORG_A,
  PROJECT_A,
  attemptInput,
  repositories,
  seedChain,
  seedTenants,
  STORYBOARD_SCENE,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * Generation orchestration against live PostgreSQL.
 *
 * There is no in-memory double for any of this, deliberately. Every property
 * worth asserting is decided by the database — whether two concurrent workers
 * can both win a provider boundary, whether a state change and its event commit
 * together, whether a CHECK refuses a fabricated provider reference — and a
 * single-threaded fake could only ever show that a second *sequential* call is
 * refused. That is not the question that decides whether a provider is paid
 * twice.
 */
const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
const repos = HAS_DB ? repositories(prisma) : (null as unknown as ReturnType<typeof repositories>);

/** Admit one attempt through the real primitive, priced in the same commit. */
async function admit(suffix: string, requestId: string, overrides = {}) {
  const outcome = await repos.attempts.admit(
    ORG_A,
    attemptInput({ id: `sgen_${suffix}`, generationSceneRequestId: requestId, ...overrides }),
    ctx({ eventType: "ATTEMPT_ADMITTED" }),
  );
  if (outcome.kind !== "ADMITTED") throw new Error(`admission failed: ${outcome.kind}`);
  return outcome.attempt;
}

describe.skipIf(!HAS_DB)("generation orchestration persistence", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  describe("job admission derives its own entitlement arithmetic", () => {
    it("computes units from duration and tier rather than accepting them", async () => {
      const created = await repos.jobs.create(
        ORG_A,
        {
          id: "genjob_units",
          videoProjectId: PROJECT_A,
          requestedByUserId: "usr_itest",
          qualityTier: "HIGH_QUALITY",
          requestedDurationSeconds: 61,
        },
        ctx(),
      );
      if (created.kind !== "CREATED") throw new Error("expected CREATED");
      // 61 seconds is the third tier, and high quality marks all of it.
      expect(created.job.requiredVideoUnits).toBe(3);
      expect(created.job.requiredHighQualityUnits).toBe(3);
    });

    it("snapshots the project's output configuration instead of choosing its own", async () => {
      // Frozen at admission and never read from the project again: project
      // settings are mutable, and an attempt admitted three days later must be
      // generated for what the customer actually started.
      const project = await prisma.videoProject.findUniqueOrThrow({ where: { id: PROJECT_A } });
      const created = await repos.jobs.create(
        ORG_A,
        {
          id: "genjob_snapshot",
          videoProjectId: PROJECT_A,
          requestedByUserId: "usr_itest",
          qualityTier: "NORMAL",
          requestedDurationSeconds: 30,
        },
        ctx(),
      );
      if (created.kind !== "CREATED") throw new Error("expected CREATED");
      expect(created.job.targetOutputResolution).toBe(project.targetOutputResolution);
      expect(created.job.targetAspectRatio).toBe(project.aspectRatio);

      // And it stays put when the project moves on.
      await prisma.videoProject.update({
        where: { id: PROJECT_A },
        data: { targetOutputResolution: "720p", aspectRatio: "9:16" },
      });
      const reloaded = await repos.jobs.findById(ORG_A, "genjob_snapshot");
      expect(reloaded?.targetOutputResolution).toBe(project.targetOutputResolution);
      expect(reloaded?.targetAspectRatio).toBe(project.aspectRatio);
    });

    it("refuses a target resolution outside the product vocabulary at the database", async () => {
      // The job's snapshot repeats the project's closed vocabulary rather than
      // opening a second, independently configurable one.
      await expect(
        prisma.generationJob.create({
          data: {
            id: "genjob_badres",
            videoProjectId: PROJECT_A,
            requestedByUserId: "usr_itest",
            qualityTier: "NORMAL",
            targetOutputResolution: "4K",
            targetAspectRatio: "16:9",
            requestedDurationSeconds: 30,
            requiredVideoUnits: 1,
            requiredHighQualityUnits: 0,
          },
        }),
      ).rejects.toThrow(/generation_jobs_target_resolution_check/);
    });

    it("refuses a duration the product does not sell instead of inventing a tier", async () => {
      const created = await repos.jobs.create(
        ORG_A,
        {
          id: "genjob_toolong",
          videoProjectId: PROJECT_A,
          requestedByUserId: "usr_itest",
          qualityTier: "NORMAL",
          requestedDurationSeconds: 91,
        },
        ctx(),
      );
      expect(created.kind).toBe("DURATION_NOT_SUPPORTED");
      expect(await prisma.generationJob.findUnique({ where: { id: "genjob_toolong" } })).toBeNull();
    });

    it("refuses a 91-second job at the database even with a self-consistent tier", async () => {
      // Aimed at the duration ceiling alone. An earlier version of this test
      // paired 91 seconds with four units, so the *tier* constraint rejected it
      // and a mutation removing the ceiling survived. Three units is what the
      // tier CASE yields for 91 seconds, so only the ceiling can refuse this.
      await expect(
        prisma.generationJob.create({
          data: {
            id: "genjob_ceiling",
            videoProjectId: PROJECT_A,
            requestedByUserId: "usr_itest",
            qualityTier: "NORMAL",
            targetOutputResolution: "1080p",
            targetAspectRatio: "16:9",
            requestedDurationSeconds: 91,
            requiredVideoUnits: 3,
            requiredHighQualityUnits: 0,
          },
        }),
      ).rejects.toThrow(/generation_jobs_duration_check/);
    });

    it.each([
      ["a 90-second job holding one unit", { requestedDurationSeconds: 90, requiredVideoUnits: 1 }],
      ["a 60-second job holding three units", { requestedDurationSeconds: 60, requiredVideoUnits: 3 }],
    ])("refuses %s at the database", async (_name, patch) => {
      await expect(
        prisma.generationJob.create({
          data: {
            id: `genjob_bad_${patch.requestedDurationSeconds}`,
            videoProjectId: PROJECT_A,
            requestedByUserId: "usr_itest",
            qualityTier: "NORMAL",
            targetOutputResolution: "1080p",
            targetAspectRatio: "16:9",
            requiredHighQualityUnits: 0,
            ...patch,
          },
        }),
      ).rejects.toThrow(/generation_jobs_(units|duration)_check/);
    });

    it.each([
      ["NORMAL with high-quality units", { qualityTier: "NORMAL" as const, hq: 2 }],
      ["HIGH_QUALITY with none", { qualityTier: "HIGH_QUALITY" as const, hq: 0 }],
    ])("refuses %s at the database", async (_name, patch) => {
      await expect(
        prisma.generationJob.create({
          data: {
            id: `genjob_hqbad_${patch.qualityTier}`,
            videoProjectId: PROJECT_A,
            requestedByUserId: "usr_itest",
            qualityTier: patch.qualityTier,
            targetOutputResolution: "1080p",
            targetAspectRatio: "16:9",
            requestedDurationSeconds: 60,
            requiredVideoUnits: 2,
            requiredHighQualityUnits: patch.hq,
          },
        }),
      ).rejects.toThrow(/generation_jobs_quality_units_check/);
    });
  });

  describe("Transaction B reserves in one commit", () => {
    it("creates the hold and moves the job together, copying units from the job", async () => {
      const { job } = await seedChain(prisma, "resb");
      const moved = await repos.jobs.transition({
        organizationId: ORG_A,
        id: job.id,
        expectedState: "CREATED",
        expectedVersion: 0,
        nextState: "RESERVING",
        context: ctx(),
      });
      if (moved.kind !== "APPLIED") throw new Error("expected APPLIED");

      const reserved = await repos.reservations.reserve(
        ORG_A,
        {
          reservationId: "genres_resb",
          generationJobId: job.id,
          expectedJobVersion: moved.value.stateVersion,
          billingCycleKey: "2026-09",
          billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
          billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
        },
        ctx({ eventType: "RESERVED" }),
      );
      if (reserved.kind !== "RESERVED") throw new Error(`expected RESERVED, got ${reserved.kind}`);

      expect(reserved.job.state).toBe("RESERVED");
      // Copied from the job, not supplied: a reservation covering fewer units
      // than its job is an under-charge nothing could later detect.
      expect(reserved.reservation.reservedTotalVideoUnits).toBe(job.requiredVideoUnits);
      expect(reserved.reservation.reservedHighQualityUnits).toBe(job.requiredHighQualityUnits);
      expect(reserved.reservation.state).toBe("RESERVED");
      // Version 1, not 0. The row is created RESERVING and genuinely moved
      // inside the same commit, so the two events below describe transitions
      // that actually happened. Inserted straight as RESERVED it would still
      // read RESERVED here, and the history would be fiction.
      expect(reserved.reservation.stateVersion).toBe(1);
      const stored = await prisma.generationReservation.findUniqueOrThrow({
        where: { id: reserved.reservation.id },
      });
      expect(stored.stateVersion).toBe(1);

      const jobHistory = await repos.events.listForAggregate(ORG_A, "JOB", job.id);
      const resHistory = await repos.events.listForAggregate(
        ORG_A,
        "RESERVATION",
        reserved.reservation.id,
      );
      expect(jobHistory.map((e) => e.toState)).toEqual(["CREATED", "RESERVING", "RESERVED"]);
      expect(resHistory.map((e) => e.toState)).toEqual(["RESERVING", "RESERVED"]);
    });

    it("commits nothing when the job transition is lost", async () => {
      // Wrong expected version: the reservation must not exist either, and the
      // job must not have moved. Split across two commits, this is exactly the
      // crash window that leaves a hold with no job behind it.
      const { job } = await seedChain(prisma, "resblost");
      const lost = await repos.reservations.reserve(
        ORG_A,
        {
          reservationId: "genres_lost",
          generationJobId: job.id,
          expectedJobVersion: 99,
          billingCycleKey: "2026-09",
          billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
          billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
        },
        ctx(),
      );
      expect(lost.kind).toBe("LOST");
      expect(await prisma.generationReservation.findUnique({ where: { id: "genres_lost" } }))
        .toBeNull();
      const row = await prisma.generationJob.findUnique({ where: { id: job.id } });
      expect(row?.state).toBe("CREATED");
      expect(row?.stateVersion).toBe(0);
    });

    it("rolls the job transition back when the reservation event cannot be written", async () => {
      // A caller that bypassed sanitization. The event write throws inside the
      // transaction, after the job CAS has already succeeded — so this passing
      // proves the rollback, not the ordering.
      const { job } = await seedChain(prisma, "resbroll");
      const moved = await repos.jobs.transition({
        organizationId: ORG_A,
        id: job.id,
        expectedState: "CREATED",
        expectedVersion: 0,
        nextState: "RESERVING",
        context: ctx(),
      });
      if (moved.kind !== "APPLIED") throw new Error("expected APPLIED");

      const poisoned = {
        ...ctx(),
        metadata: { requestCompiledPrompt: "a sunlit living room" },
      } as unknown as TransitionContext;

      await expect(
        repos.reservations.reserve(
          ORG_A,
          {
            reservationId: "genres_roll",
            generationJobId: job.id,
            expectedJobVersion: moved.value.stateVersion,
            billingCycleKey: "2026-09",
            billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
            billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
          },
          poisoned,
        ),
      ).rejects.toThrow(/forbidden keys/);

      const row = await prisma.generationJob.findUnique({ where: { id: job.id } });
      expect(row?.state).toBe("RESERVING");
      expect(await prisma.generationReservation.findUnique({ where: { id: "genres_roll" } }))
        .toBeNull();
    });

    it("permits only one reservation per job", async () => {
      const { job } = await seedChain(prisma, "resbdup");
      const moved = await repos.jobs.transition({
        organizationId: ORG_A,
        id: job.id,
        expectedState: "CREATED",
        expectedVersion: 0,
        nextState: "RESERVING",
        context: ctx(),
      });
      if (moved.kind !== "APPLIED") throw new Error("expected APPLIED");
      const base = {
        generationJobId: job.id,
        expectedJobVersion: moved.value.stateVersion,
        billingCycleKey: "2026-09",
        billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
        billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
      };
      const first = await repos.reservations.reserve(
        ORG_A,
        { reservationId: "genres_dup1", ...base },
        ctx(),
      );
      expect(first.kind).toBe("RESERVED");
      const second = await repos.reservations.reserve(
        ORG_A,
        { reservationId: "genres_dup2", ...base },
        ctx(),
      );
      expect(second.kind).toBe("ALREADY_RESERVED");
    });

    it("keeps its billing cycle through every later transition", async () => {
      // Reserved in September, delivered in October: September is charged.
      const { job } = await seedChain(prisma, "cycle");
      const moved = await repos.jobs.transition({
        organizationId: ORG_A,
        id: job.id,
        expectedState: "CREATED",
        expectedVersion: 0,
        nextState: "RESERVING",
        context: ctx(),
      });
      if (moved.kind !== "APPLIED") throw new Error("expected APPLIED");
      const reserved = await repos.reservations.reserve(
        ORG_A,
        {
          reservationId: "genres_cycle",
          generationJobId: job.id,
          expectedJobVersion: moved.value.stateVersion,
          billingCycleKey: "2026-09",
          billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
          billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
        },
        ctx(),
      );
      if (reserved.kind !== "RESERVED") throw new Error("expected RESERVED");

      let version = reserved.reservation.stateVersion;
      // CONSUMED is deliberately absent: it belongs to Transaction G, which is
      // deferred, and the generic API refuses that edge.
      for (const [from, to] of [
        ["RESERVED", "RECONCILIATION_HOLD"],
        ["RECONCILIATION_HOLD", "RESERVED"],
      ] as const) {
        const step = await repos.reservations.transition({
          organizationId: ORG_A,
          id: reserved.reservation.id,
          expectedState: from,
          expectedVersion: version,
          nextState: to,
          context: ctx(),
        });
        if (step.kind !== "APPLIED") throw new Error(`expected APPLIED for ${from} -> ${to}`);
        version = step.value.stateVersion;
        expect(step.value.billingCycleKey).toBe("2026-09");
      }
      const final = await repos.reservations.findByJobId(ORG_A, job.id);
      expect(final?.state).toBe("RESERVED");
      expect(final?.billingCycleKey).toBe("2026-09");
    });

    it("stamps a released hold with when it was given back", async () => {
      // `RELEASED` is the one terminal edge this method can actually reach —
      // both edges into `CONSUMED` belong to Transaction G — and the instant a
      // customer's units returned to them is what a billing dispute is settled
      // with. Added because a mutation removing the sibling `consumedAt` write
      // survived: it was unreachable, and this asserts the half that is not.
      const { job } = await seedChain(prisma, "release");
      const moved = await repos.jobs.transition({
        organizationId: ORG_A,
        id: job.id,
        expectedState: "CREATED",
        expectedVersion: 0,
        nextState: "RESERVING",
        context: ctx(),
      });
      if (moved.kind !== "APPLIED") throw new Error("expected APPLIED");
      const reserved = await repos.reservations.reserve(
        ORG_A,
        {
          reservationId: "genres_release",
          generationJobId: job.id,
          expectedJobVersion: moved.value.stateVersion,
          billingCycleKey: "2026-09",
          billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
          billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
        },
        ctx(),
      );
      if (reserved.kind !== "RESERVED") throw new Error("expected RESERVED");
      expect(reserved.reservation.releasedAt).toBeNull();

      const released = await repos.reservations.transition({
        organizationId: ORG_A,
        id: reserved.reservation.id,
        expectedState: "RESERVED",
        expectedVersion: reserved.reservation.stateVersion,
        nextState: "RELEASED",
        context: ctx(),
      });
      if (released.kind !== "APPLIED") throw new Error("expected APPLIED");
      expect(released.value.releasedAt).not.toBeNull();
      // And nothing invents a consumption on the way out.
      expect(released.value.consumedAt).toBeNull();
    });

    it("refuses to consume a reservation through the generic API", async () => {
      // Consuming a unit and marking a deliverable ready are one fact, and the
      // quota ledger that makes it safe is deferred. Exposing this edge alone
      // would make an incomplete workflow executable.
      const { job } = await seedChain(prisma, "noconsume");
      const moved = await repos.jobs.transition({
        organizationId: ORG_A,
        id: job.id,
        expectedState: "CREATED",
        expectedVersion: 0,
        nextState: "RESERVING",
        context: ctx(),
      });
      if (moved.kind !== "APPLIED") throw new Error("expected APPLIED");
      const reserved = await repos.reservations.reserve(
        ORG_A,
        {
          reservationId: "genres_noconsume",
          generationJobId: job.id,
          expectedJobVersion: moved.value.stateVersion,
          billingCycleKey: "2026-09",
          billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
          billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
        },
        ctx(),
      );
      if (reserved.kind !== "RESERVED") throw new Error("expected RESERVED");
      const refused = await repos.reservations.transition({
        organizationId: ORG_A,
        id: reserved.reservation.id,
        expectedState: "RESERVED",
        expectedVersion: reserved.reservation.stateVersion,
        nextState: "CONSUMED",
        context: ctx(),
      });
      expect(refused.kind).toBe("TRANSITION_RESERVED");
      const row = await repos.reservations.findByJobId(ORG_A, job.id);
      expect(row?.state).toBe("RESERVED");
      expect(row?.consumedAt).toBeNull();
    });

    it("refuses negative units and high-quality above total at the database", async () => {
      const { job } = await seedChain(prisma, "negunits");
      const base = {
        generationJobId: job.id,
        billingCycleKey: "2026-09",
        billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
        billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
      };
      await expect(
        prisma.generationReservation.create({
          data: { id: "r1", ...base, reservedTotalVideoUnits: -1, reservedHighQualityUnits: 0 },
        }),
      ).rejects.toThrow(/generation_reservations_units_check/);
      await expect(
        prisma.generationReservation.create({
          data: { id: "r2", ...base, reservedTotalVideoUnits: 2, reservedHighQualityUnits: 3 },
        }),
      ).rejects.toThrow(/generation_reservations_units_check/);
    });
  });

  describe("Transaction C admits an attempt and its price in one commit", () => {
    it("creates attempt, pricing snapshot and event together", async () => {
      const { request } = await seedChain(prisma, "txc");
      const attempt = await admit("txc", request.id);

      expect(attempt.orchestrationState).toBe("QUEUED");
      expect(attempt.submissionCertainty).toBe("PRE_SUBMISSION");
      expect(attempt.attemptOrdinal).toBe(1);
      // The project is resolved from the request chain, not supplied.
      expect(attempt.videoProjectId).toBe(PROJECT_A);
      // The contract key is copied from the snapshot, not supplied.
      expect(attempt.pricingContractKey).toBe(domainSnapshot().contractKey);

      const price = await repos.pricing.findByAttemptId(ORG_A, attempt.id);
      expect(price).not.toBeNull();
      const history = await repos.events.listForAggregate(ORG_A, "ATTEMPT", attempt.id);
      expect(history.map((e) => [e.sequence, e.toState])).toEqual([[1, "QUEUED"]]);
    });

    it("leaves no attempt row when the admission event cannot be written", async () => {
      // The crash window Transaction C exists to close: an admitted attempt
      // with no cost decision would be refused at the boundary forever.
      const { request } = await seedChain(prisma, "txcroll");
      const poisoned = {
        ...ctx(),
        metadata: { requestRenderedPrompt: "a sunlit living room" },
      } as unknown as TransitionContext;

      await expect(
        repos.attempts.admit(
          ORG_A,
          attemptInput({ id: "sgen_txcroll", generationSceneRequestId: request.id }),
          poisoned,
        ),
      ).rejects.toThrow(/forbidden keys/);

      expect(await prisma.sceneGeneration.findUnique({ where: { id: "sgen_txcroll" } })).toBeNull();
      expect(
        await prisma.generationPricingSnapshot.findUnique({ where: { id: "price_sgen_txcroll" } }),
      ).toBeNull();
    });

    it("derives PRIMARY then SYSTEM_RECOVERY, and never reuses an ordinal", async () => {
      // Attempt kind is derived, not supplied: the first attempt on a request
      // is PRIMARY, every later one is SYSTEM_RECOVERY. A caller cannot make
      // the first a recovery, because there is no input for it.
      const { request } = await seedChain(prisma, "ord");
      const first = await admit("ord1", request.id);
      expect(first.attemptKind).toBe("PRIMARY");
      expect(first.attemptOrdinal).toBe(1);

      // The first must finish before another may be admitted: recovery is
      // sequential, not parallel paid work.
      await prisma.sceneGeneration.update({
        where: { id: first.id },
        data: { orchestrationState: "FAILED_TERMINAL", submissionBoundaryEnteredAt: new Date() },
      });

      const second = await admit("ord2", request.id, { pricingSnapshotId: "price_sgen_ord2" });
      expect(second.attemptKind).toBe("SYSTEM_RECOVERY");
      expect(second.attemptOrdinal).toBe(2);
      // Same derived identity — the same work, tried again.
      expect(second.requestHash).toBe(first.requestHash);
    });

    it("refuses a second attempt while one is still live", async () => {
      const { request } = await seedChain(prisma, "concurrent");
      await admit("conc1", request.id);
      const second = await repos.attempts.admit(
        ORG_A,
        attemptInput({
          id: "sgen_conc2",
          generationSceneRequestId: request.id,
          pricingSnapshotId: "price_sgen_conc2",
        }),
        ctx(),
      );
      expect(second.kind).toBe("ATTEMPT_ALREADY_ACTIVE");
      expect(await prisma.sceneGeneration.findUnique({ where: { id: "sgen_conc2" } })).toBeNull();
    });

    it("refuses two PRIMARY rows at the database", async () => {
      const { request } = await seedChain(prisma, "twoprimary");
      const first = await admit("twoprimary", request.id);
      await prisma.sceneGeneration.update({
        where: { id: first.id },
        data: { orchestrationState: "FAILED_TERMINAL", submissionBoundaryEnteredAt: new Date() },
      });
      // Bypassing the derivation entirely: the index still refuses.
      await expect(
        prisma.sceneGeneration.create({
          data: {
            id: "sgen_twoprimary_b",
            videoProjectId: PROJECT_A,
            sourceStoryboardSceneId: STORYBOARD_SCENE,
            assetId: ASSET_A,
            sourceAnalysisRevision: 1,
            requestHash: `sha256:v2:${"9".repeat(63)}1`,
            providerName: "wavespeed",
            providerModelId: "wavespeed-ai/open-video/image-to-video",
            requestCompiledPrompt: "p",
            requestDurationSeconds: 5,
            requestAspectRatio: "16:9",
            requestModelKey: "wavespeed-open-video",
            requestTargetOutputResolution: "1080p",
            requestNativeGenerationResolution: "1080p",
            requestResolutionNormalization: "NONE",
            requestNativeMeetsTarget: true,
            requestRenderedPrompt: "p",
            generationSceneRequestId: request.id,
            attemptOrdinal: 9,
            attemptKind: "PRIMARY",
            submissionCertainty: "PRE_SUBMISSION",
            orchestrationState: "FAILED_TERMINAL",
            submissionBoundaryEnteredAt: new Date(),
            pricingContractKey: "k",
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("refuses an attempt whose request belongs to nobody it can see", async () => {
      const outcome = await repos.attempts.admit(
        ORG_A,
        attemptInput({ id: "sgen_nope", generationSceneRequestId: "genreq_does_not_exist" }),
        ctx(),
      );
      expect(outcome.kind).toBe("REQUEST_NOT_FOUND");
    });
  });

  describe("the pricing decision must belong to the attempt", () => {
    it("refuses a WaveSpeed attempt priced with a fal/H3 Max contract", async () => {
      const { request } = await seedChain(prisma, "bind1");
      const outcome = await repos.attempts.admit(
        ORG_A,
        attemptInput({
          id: "sgen_bind1",
          generationSceneRequestId: request.id,
          providerName: "wavespeed",
          requestModelKey: "wavespeed-open-video",
          pricingSnapshot: domainSnapshot(H3_MAX_IDENTITY),
        }),
        ctx(),
      );
      expect(outcome.kind).toBe("PRICING_BINDING_INVALID");
      if (outcome.kind !== "PRICING_BINDING_INVALID") throw new Error("expected refusal");
      expect(outcome.reason).toBe("PROVIDER_MISMATCH");
      expect(await prisma.sceneGeneration.findUnique({ where: { id: "sgen_bind1" } })).toBeNull();
    });

    it("refuses a fal/H3 Max attempt priced with a WaveSpeed contract", async () => {
      const { request } = await seedChain(prisma, "bind2");
      const outcome = await repos.attempts.admit(
        ORG_A,
        attemptInput({
          id: "sgen_bind2",
          generationSceneRequestId: request.id,
          providerName: "fal",
          providerModelId: "fal-ai/minimax/hailuo-3-max/image-to-video",
          requestModelKey: "minimax-h3-max",
          pricingSnapshot: domainSnapshot(),
        }),
        ctx(),
      );
      if (outcome.kind !== "PRICING_BINDING_INVALID") throw new Error("expected refusal");
      expect(outcome.reason).toBe("PROVIDER_MISMATCH");
    });

    it("refuses the right provider with the wrong model key", async () => {
      const { request } = await seedChain(prisma, "bind3");
      const outcome = await repos.attempts.admit(
        ORG_A,
        attemptInput({
          id: "sgen_bind3",
          generationSceneRequestId: request.id,
          providerName: "wavespeed",
          requestModelKey: "some-other-wavespeed-model",
        }),
        ctx(),
      );
      if (outcome.kind !== "PRICING_BINDING_INVALID") throw new Error("expected refusal");
      expect(outcome.reason).toBe("MODEL_KEY_MISMATCH");
    });

    it("arms a correctly bound attempt", async () => {
      const { request } = await seedChain(prisma, "bindok");
      const attempt = await admit("bindok", request.id);
      const armed = await repos.attempts.armProviderBoundary({
        organizationId: ORG_A,
        id: attempt.id,
        expectedVersion: attempt.stateVersion,
        context: ctx({ eventType: "ARM" }),
      });
      expect(armed.kind).toBe("ARMED");
    });

    it("refuses to arm when the stored price names another provider", async () => {
      // Corrupt the binding directly, as a bad migration or console session
      // could. Existence is not enough: the boundary re-checks the binding.
      const { request } = await seedChain(prisma, "bindrot");
      const attempt = await admit("bindrot", request.id);
      await prisma.generationPricingSnapshot.update({
        where: { sceneGenerationId: attempt.id },
        data: { provider: "fal" },
      });
      const armed = await repos.attempts.armProviderBoundary({
        organizationId: ORG_A,
        id: attempt.id,
        expectedVersion: attempt.stateVersion,
        context: ctx(),
      });
      expect(armed.kind).toBe("PRICING_BINDING_INVALID");
      if (armed.kind !== "PRICING_BINDING_INVALID") throw new Error("expected refusal");
      expect(armed.reason).toBe("PROVIDER_MISMATCH");
      const row = await prisma.sceneGeneration.findUnique({ where: { id: attempt.id } });
      expect(row?.orchestrationState).toBe("QUEUED");
    });

    it("refuses to arm when the stored price names another contract", async () => {
      const { request } = await seedChain(prisma, "bindkey");
      const attempt = await admit("bindkey", request.id);
      await prisma.sceneGeneration.update({
        where: { id: attempt.id },
        data: { pricingContractKey: "some|other|contract" },
      });
      const armed = await repos.attempts.armProviderBoundary({
        organizationId: ORG_A,
        id: attempt.id,
        expectedVersion: attempt.stateVersion,
        context: ctx(),
      });
      if (armed.kind !== "PRICING_BINDING_INVALID") throw new Error("expected refusal");
      expect(armed.reason).toBe("CONTRACT_KEY_MISMATCH");
    });

    it("refuses to arm an attempt with no pricing snapshot at all", async () => {
      const { request } = await seedChain(prisma, "nosnap");
      const attempt = await admit("nosnap", request.id);
      await prisma.generationPricingSnapshot.delete({
        where: { sceneGenerationId: attempt.id },
      });
      const armed = await repos.attempts.armProviderBoundary({
        organizationId: ORG_A,
        id: attempt.id,
        expectedVersion: attempt.stateVersion,
        context: ctx(),
      });
      expect(armed.kind).toBe("MISSING_PRICING_SNAPSHOT");
      expect(await repos.events.listForAggregate(ORG_A, "ATTEMPT", attempt.id)).toHaveLength(1);
    });
  });

  describe("the provider submission boundary", () => {
    it("arms a priced attempt exactly once and records the boundary instant", async () => {
      const { request } = await seedChain(prisma, "arm");
      const attempt = await admit("arm", request.id);
      const outcome = await repos.attempts.armProviderBoundary({
        organizationId: ORG_A,
        id: attempt.id,
        expectedVersion: attempt.stateVersion,
        context: ctx({ eventType: "ARM_PROVIDER_BOUNDARY" }),
      });
      if (outcome.kind !== "ARMED") throw new Error("expected ARMED");
      expect(outcome.attempt.orchestrationState).toBe("SUBMITTING");
      expect(outcome.attempt.submissionBoundaryEnteredAt).not.toBeNull();

      const history = await repos.events.listForAggregate(ORG_A, "ATTEMPT", attempt.id);
      expect(history.map((e) => [e.sequence, e.fromState, e.toState])).toEqual([
        [1, null, "QUEUED"],
        [2, "QUEUED", "SUBMITTING"],
      ]);
    });

    /**
     * The phase completion requirement.
     *
     * Two workers race for the same attempt. Exactly one may be authorized to
     * call the provider; the other must receive a result that cannot be
     * mistaken for permission. Run concurrently rather than sequentially,
     * because a sequential test passes against an implementation with no
     * compare-and-set at all.
     */
    it("lets only one of two concurrent workers win the provider boundary", async () => {
      const { request } = await seedChain(prisma, "race");
      const attempt = await admit("race", request.id);

      const both = await Promise.all([
        repos.attempts.armProviderBoundary({
          organizationId: ORG_A,
          id: attempt.id,
          expectedVersion: attempt.stateVersion,
          context: ctx({ correlationId: "corr_worker_a" }),
        }),
        repos.attempts.armProviderBoundary({
          organizationId: ORG_A,
          id: attempt.id,
          expectedVersion: attempt.stateVersion,
          context: ctx({ correlationId: "corr_worker_b" }),
        }),
      ]);

      expect(both.filter((o) => o.kind === "ARMED")).toHaveLength(1);
      expect(both.filter((o) => o.kind === "LOST")).toEqual([{ kind: "LOST" }]);

      // Admission event plus exactly one arm event: the loser's transaction
      // rolled back entirely rather than leaving a claim it did not win.
      expect(await repos.events.listForAggregate(ORG_A, "ATTEMPT", attempt.id)).toHaveLength(2);
      const row = await prisma.sceneGeneration.findUnique({ where: { id: attempt.id } });
      expect(row?.stateVersion).toBe(1);
    });

    it("refuses a stale version even when the state still matches", async () => {
      const { request } = await seedChain(prisma, "stale");
      const attempt = await admit("stale", request.id);
      const wrong = await repos.attempts.armProviderBoundary({
        organizationId: ORG_A,
        id: attempt.id,
        expectedVersion: 7,
        context: ctx(),
      });
      expect(wrong.kind).toBe("LOST");
      const row = await prisma.sceneGeneration.findUnique({ where: { id: attempt.id } });
      expect(row?.orchestrationState).toBe("QUEUED");
    });

    it("cannot cross the same attempt over the boundary twice", async () => {
      const { request } = await seedChain(prisma, "twice");
      const attempt = await admit("twice", request.id);
      const first = await repos.attempts.armProviderBoundary({
        organizationId: ORG_A,
        id: attempt.id,
        expectedVersion: attempt.stateVersion,
        context: ctx(),
      });
      expect(first.kind).toBe("ARMED");
      // A second arming with the *correct* new version still fails: the state
      // is no longer QUEUED. A retry is a new row, never this one.
      const second = await repos.attempts.armProviderBoundary({
        organizationId: ORG_A,
        id: attempt.id,
        expectedVersion: attempt.stateVersion + 1,
        context: ctx(),
      });
      expect(second.kind).toBe("LOST");
    });
  });

  /**
   * The defect that made the frozen retry rule unreachable.
   *
   * The Phase 4A-2a index tested the legacy `state` column, which an
   * orchestrated attempt never advances — so a terminal orchestrated attempt
   * still looked active, and the recovery meant to replace it could not be
   * inserted.
   *
   * Request hashes are now **derived**, so the same-identity cases below arise
   * naturally rather than by fixture arrangement: an initial request and a
   * regeneration of the same scene, routed to the same model, are the same work
   * and therefore produce the same hash. Nothing here can perturb a hash to
   * sidestep the index, because nothing here supplies one.
   */
  describe("the active-request index reads both vocabularies", () => {
    /** Legacy rows predate V2 identity, so their hash carries no v2 prefix. */
    const LEGACY_HASH = `${"e".repeat(64)}`;

    async function legacyRow(id: string, state: "QUEUED" | "SUCCEEDED") {
      return prisma.sceneGeneration.create({
        data: {
          id,
          videoProjectId: PROJECT_A,
          sourceStoryboardSceneId: STORYBOARD_SCENE,
          assetId: ASSET_A,
          sourceAnalysisRevision: 1,
          requestHash: LEGACY_HASH,
          providerName: "wavespeed",
          providerModelId: "wavespeed-ai/open-video/image-to-video",
          state,
        },
      });
    }

    it("still blocks a duplicate against an active legacy row", async () => {
      await legacyRow("sgen_legacy_active", "QUEUED");
      await expect(legacyRow("sgen_legacy_dup", "QUEUED")).rejects.toMatchObject({
        code: "P2002",
      });
    });

    it("releases the identity for a terminal legacy row, unchanged", async () => {
      await legacyRow("sgen_legacy_done", "SUCCEEDED");
      await expect(legacyRow("sgen_legacy_after", "QUEUED")).resolves.toBeTruthy();
    });

    /**
     * Two logical requests for one scene produce one request identity.
     *
     * The initial request's attempt and a regeneration's attempt describe the
     * same work — same asset, prompt, duration, model — so their derived hashes
     * are equal. While the first is live the second must be refused; once it is
     * terminal the identity is released.
     */
    async function regenerationRequestOn(sceneId: string, suffix: string) {
      const admitted = await repos.requests.admitUserRegeneration(
        ORG_A,
        { id: `genreq_regen_${suffix}`, generationSceneId: sceneId, requestedByUserId: "usr" },
        ctx(),
      );
      if (admitted.kind !== "ADMITTED") throw new Error(`regen failed: ${admitted.kind}`);
      return admitted.request;
    }

    it.each([["QUEUED"], ["SUBMITTING"], ["PROCESSING"], ["RECONCILIATION_PENDING"]] as const)(
      "blocks a second logical request's attempt while the first is %s",
      async (state) => {
        const { scene, request } = await seedChain(prisma, `act${state}`);
        const first = await admit(`act${state}`, request.id);
        if (state !== "QUEUED") {
          await prisma.sceneGeneration.update({
            where: { id: first.id },
            data: {
              orchestrationState: state,
              submissionBoundaryEnteredAt: new Date(),
              ...(state === "RECONCILIATION_PENDING"
                ? {
                    submissionCertainty: "SUBMISSION_UNKNOWN",
                    reconciliationStartedAt: new Date(),
                    reconciliationDeadlineAt: new Date(Date.now() + 86_400_000),
                  }
                : {}),
            },
          });
        }
        const regen = await regenerationRequestOn(scene.id, `act${state}`);
        await expect(
          admit(`act${state}dup`, regen.id, { pricingSnapshotId: `price_act${state}dup` }),
        ).rejects.toMatchObject({ code: "P2002" });
      },
    );

    it.each([
      ["FAILED_RETRYABLE"],
      ["FAILED_TERMINAL"],
      ["RECONCILIATION_EXHAUSTED"],
      ["OUTPUT_VERIFIED"],
      ["CANCELLED_PRE_SUBMISSION"],
    ] as const)("permits a second request's attempt with the same hash after %s", async (state) => {
      const { scene, request } = await seedChain(prisma, `rel${state}`);
      const first = await admit(`rel${state}`, request.id);
      await prisma.sceneGeneration.update({
        where: { id: first.id },
        data: {
          orchestrationState: state,
          ...(state === "CANCELLED_PRE_SUBMISSION"
            ? {}
            : { submissionBoundaryEnteredAt: new Date() }),
        },
      });

      const regen = await regenerationRequestOn(scene.id, `rel${state}`);
      const second = await admit(`rel${state}rec`, regen.id, {
        pricingSnapshotId: `price_rel${state}rec`,
      });
      // Same derived identity, admitted because the first attempt finished.
      expect(second.requestHash).toBe(first.requestHash);
      expect(second.attemptKind).toBe("PRIMARY");
      expect(second.attemptOrdinal).toBe(1);
    });
  });

  describe("provider submission outcomes", () => {
    async function armed(suffix: string) {
      const { request } = await seedChain(prisma, suffix);
      const attempt = await admit(suffix, request.id);
      const outcome = await repos.attempts.armProviderBoundary({
        organizationId: ORG_A,
        id: attempt.id,
        expectedVersion: attempt.stateVersion,
        context: ctx(),
      });
      if (outcome.kind !== "ARMED") throw new Error("expected ARMED");
      return outcome.attempt;
    }

    it("records ACCEPTED with a real provider reference", async () => {
      const attempt = await armed("acc");
      const accepted = new Date("2026-09-04T01:00:00.000Z");
      const outcome = await repos.attempts.recordSubmissionOutcome({
        organizationId: ORG_A,
        id: attempt.id,
        expectedVersion: attempt.stateVersion,
        outcome: {
          certainty: "ACCEPTED",
          state: "PROCESSING",
          providerPredictionId: "pred_real_123",
          providerAcceptedAt: accepted,
        },
        normalizedErrorCode: null,
        context: ctx(),
      });
      if (outcome.kind !== "APPLIED") throw new Error("expected APPLIED");
      expect(outcome.value.submissionCertainty).toBe("ACCEPTED");
      expect(outcome.value.providerPredictionId).toBe("pred_real_123");
      expect(outcome.value.providerAcceptedAt?.toISOString()).toBe(accepted.toISOString());
    });

    it("records DEFINITIVELY_REJECTED with no provider reference", async () => {
      const attempt = await armed("rej");
      const outcome = await repos.attempts.recordSubmissionOutcome({
        organizationId: ORG_A,
        id: attempt.id,
        expectedVersion: attempt.stateVersion,
        outcome: {
          certainty: "DEFINITIVELY_REJECTED",
          state: "FAILED_TERMINAL",
          providerPredictionId: null,
        },
        normalizedErrorCode: "PROVIDER_REJECTED_REQUEST",
        context: ctx(),
      });
      if (outcome.kind !== "APPLIED") throw new Error("expected APPLIED");
      expect(outcome.value.providerPredictionId).toBeNull();
      expect(outcome.value.normalizedErrorCode).toBe("PROVIDER_REJECTED_REQUEST");
    });

    it("records SUBMISSION_UNKNOWN with a frozen reconciliation deadline", async () => {
      const attempt = await armed("unk");
      const started = new Date("2026-09-04T02:00:00.000Z");
      const outcome = await repos.attempts.recordSubmissionOutcome({
        organizationId: ORG_A,
        id: attempt.id,
        expectedVersion: attempt.stateVersion,
        outcome: {
          certainty: "SUBMISSION_UNKNOWN",
          state: "RECONCILIATION_PENDING",
          providerPredictionId: null,
          reconciliationStartedAt: started,
          reconciliationDeadlineAt: reconciliationDeadlineFrom(started),
        },
        normalizedErrorCode: "PROVIDER_SUBMISSION_TIMEOUT",
        context: ctx(),
      });
      if (outcome.kind !== "APPLIED") throw new Error("expected APPLIED");
      expect(outcome.value.providerPredictionId).toBeNull();
      expect(outcome.value.reconciliationDeadlineAt?.toISOString()).toBe(
        "2026-09-05T02:00:00.000Z",
      );
    });

    it("rejects a provider reference without ACCEPTED certainty at the database", async () => {
      const { request } = await seedChain(prisma, "fab");
      const attempt = await admit("fab", request.id);
      await expect(
        prisma.sceneGeneration.update({
          where: { id: attempt.id },
          data: {
            submissionCertainty: "SUBMISSION_UNKNOWN",
            orchestrationState: "RECONCILIATION_PENDING",
            reconciliationStartedAt: new Date(),
            reconciliationDeadlineAt: new Date(Date.now() + 1000),
            submissionBoundaryEnteredAt: new Date(),
            providerPredictionId: "pred_invented",
          },
        }),
      ).rejects.toThrow(/prediction_requires_accepted/);
    });

    it("rejects ACCEPTED with no provider reference at the database", async () => {
      // The other direction: a response that could not establish a reference
      // has not established acceptance either.
      const { request } = await seedChain(prisma, "accnull");
      const attempt = await admit("accnull", request.id);
      await expect(
        prisma.sceneGeneration.update({
          where: { id: attempt.id },
          data: {
            submissionCertainty: "ACCEPTED",
            orchestrationState: "PROCESSING",
            submissionBoundaryEnteredAt: new Date(),
          },
        }),
      ).rejects.toThrow(/accepted_requires_reference/);
    });

    it("rejects an uncertain attempt with no reconciliation deadline", async () => {
      const { request } = await seedChain(prisma, "nodeadline");
      const attempt = await admit("nodeadline", request.id);
      await expect(
        prisma.sceneGeneration.update({
          where: { id: attempt.id },
          data: {
            submissionCertainty: "SUBMISSION_UNKNOWN",
            orchestrationState: "RECONCILIATION_PENDING",
            submissionBoundaryEnteredAt: new Date(),
          },
        }),
      ).rejects.toThrow(/reconciliation_metadata/);
    });
  });

  describe("transition history is append-only and atomic", () => {
    it("commits a state change and its event together", async () => {
      const { job } = await seedChain(prisma, "atomic");
      const moved = await repos.jobs.transition({
        organizationId: ORG_A,
        id: job.id,
        expectedState: "CREATED",
        expectedVersion: 0,
        nextState: "RESERVING",
        context: ctx(),
      });
      expect(moved.kind).toBe("APPLIED");
      const history = await repos.events.listForAggregate(ORG_A, "JOB", job.id);
      expect(history.map((e) => [e.sequence, e.fromState, e.toState])).toEqual([
        [1, null, "CREATED"],
        [2, "CREATED", "RESERVING"],
      ]);
      expect(history.every((e) => e.organizationId === ORG_A)).toBe(true);
    });

    it("writes no event when a transition is lost", async () => {
      const { job } = await seedChain(prisma, "lost");
      const lost = await repos.jobs.transition({
        organizationId: ORG_A,
        id: job.id,
        expectedState: "CREATED",
        expectedVersion: 99,
        nextState: "RESERVING",
        context: ctx(),
      });
      expect(lost.kind).toBe("LOST");
      expect(await repos.events.listForAggregate(ORG_A, "JOB", job.id)).toHaveLength(1);
    });

    it("rolls the state change back when the event cannot be written", async () => {
      const { job } = await seedChain(prisma, "evtfail");
      const unsanitized = {
        ...ctx(),
        metadata: { requestCompiledPrompt: "a sunlit living room" },
      } as unknown as TransitionContext;

      await expect(
        repos.jobs.transition({
          organizationId: ORG_A,
          id: job.id,
          expectedState: "CREATED",
          expectedVersion: 0,
          nextState: "RESERVING",
          context: unsanitized,
        }),
      ).rejects.toThrow(/forbidden keys/);

      const row = await prisma.generationJob.findUnique({ where: { id: job.id } });
      expect(row?.state).toBe("CREATED");
      expect(row?.stateVersion).toBe(0);
      const dumped = JSON.stringify(
        await prisma.generationTransitionEvent.findMany({ where: { aggregateId: job.id } }),
      );
      expect(dumped).not.toContain("sunlit");
    });

    it("increases the sequence monotonically per aggregate", async () => {
      const { job } = await seedChain(prisma, "seq");
      let version = 0;
      // RESERVING -> RESERVED is absent: it belongs to Transaction B, and the
      // generic API refuses it.
      for (const [from, to] of [
        ["CREATED", "RESERVING"],
        ["RESERVING", "CANCELLED"],
      ] as const) {
        const moved = await repos.jobs.transition({
          organizationId: ORG_A,
          id: job.id,
          expectedState: from,
          expectedVersion: version,
          nextState: to,
          context: ctx(),
        });
        if (moved.kind !== "APPLIED") throw new Error("expected APPLIED");
        version = moved.value.stateVersion;
      }
      const history = await repos.events.listForAggregate(ORG_A, "JOB", job.id);
      expect(history.map((e) => e.sequence)).toEqual([1, 2, 3]);
    });

    it("refuses the edges that belong to an atomic primitive", async () => {
      // Adding a primitive achieves nothing if the same edge stays reachable
      // beside it: a caller could still produce a RESERVED job with no
      // reservation behind it.
      const { job, request } = await seedChain(prisma, "reserved");
      const moved = await repos.jobs.transition({
        organizationId: ORG_A,
        id: job.id,
        expectedState: "CREATED",
        expectedVersion: 0,
        nextState: "RESERVING",
        context: ctx(),
      });
      if (moved.kind !== "APPLIED") throw new Error("expected APPLIED");

      const bypass = await repos.jobs.transition({
        organizationId: ORG_A,
        id: job.id,
        expectedState: "RESERVING",
        expectedVersion: moved.value.stateVersion,
        nextState: "RESERVED",
        context: ctx(),
      });
      expect(bypass.kind).toBe("TRANSITION_RESERVED");
      expect((await repos.jobs.findById(ORG_A, job.id))?.state).toBe("RESERVING");
      expect(await repos.reservations.findByJobId(ORG_A, job.id)).toBeNull();

      // Attempt admission owns PENDING -> GENERATING on a request.
      const startBypass = await repos.requests.transition({
        organizationId: ORG_A,
        id: request.id,
        expectedState: "PENDING",
        expectedVersion: 0,
        nextState: "GENERATING",
        context: ctx(),
      });
      expect(startBypass.kind).toBe("TRANSITION_RESERVED");

      // Transaction F owns GENERATING -> DELIVERED, and it is deferred.
      await admit("reserved", request.id);
      const current = await repos.requests.findById(ORG_A, request.id);
      expect(current?.state).toBe("GENERATING");
      const deliverBypass = await repos.requests.transition({
        organizationId: ORG_A,
        id: request.id,
        expectedState: "GENERATING",
        expectedVersion: current!.stateVersion,
        nextState: "DELIVERED",
        context: ctx(),
      });
      expect(deliverBypass.kind).toBe("TRANSITION_RESERVED");
      expect((await repos.requests.findById(ORG_A, request.id))?.state).toBe("GENERATING");
    });

    it("offers no update or delete method for history", () => {
      const repo = repos.events as unknown as Record<string, unknown>;
      expect(Object.keys(repo).sort()).toEqual(["listForAggregate", "listForCorrelation"]);
    });

    it("takes the event's organization from the operation, not from metadata", async () => {
      // Metadata is caller decoration. Reading tenancy out of it would let a
      // caller relabel whose history an event joins — and a mutation doing
      // exactly that survived until this test put a plausible value there.
      const { job } = await seedChain(prisma, "orgmeta");
      await repos.jobs.transition({
        organizationId: ORG_A,
        id: job.id,
        expectedState: "CREATED",
        expectedVersion: 0,
        nextState: "RESERVING",
        context: ctx({
          metadata: sanitizeTransitionMetadata({ billingCycleKey: "org_itest_orch_b" }),
        }),
      });
      const rows = await prisma.generationTransitionEvent.findMany({
        where: { aggregateId: job.id },
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.organizationId === ORG_A)).toBe(true);
    });

    it("never stores a prompt in transition metadata", async () => {
      const { job, scene } = await seedChain(prisma, "redact");
      expect(scene.snapshotCompiledPrompt).toContain("sunlit");
      await repos.jobs.transition({
        organizationId: ORG_A,
        id: job.id,
        expectedState: "CREATED",
        expectedVersion: 0,
        nextState: "RESERVING",
        context: ctx({
          metadata: sanitizeTransitionMetadata({
            generationJobId: job.id,
            qualityTier: "HIGH_QUALITY",
          }),
        }),
      });
      const dumped = JSON.stringify(
        await prisma.generationTransitionEvent.findMany({ where: { aggregateId: job.id } }),
      );
      expect(dumped).not.toContain("sunlit");
      expect(dumped).toContain("HIGH_QUALITY");
    });
  });

  describe("pricing snapshots are persisted verbatim", () => {
    it("round-trips every field of the domain decision without precision loss", async () => {
      const { request } = await seedChain(prisma, "price");
      const attempt = await admit("price", request.id);
      const domain = domainSnapshot(undefined, "HIGH_QUALITY_AI");
      const stored = await repos.pricing.findByAttemptId(ORG_A, attempt.id);
      if (stored === null) throw new Error("expected a stored snapshot");

      expect(stored.pricingVersion).toBe(domain.pricingVersion);
      expect(stored.provider).toBe(domain.provider);
      expect(stored.contractKey).toBe(domain.contractKey);
      expect(stored.contractFingerprint).toBe(domain.contractFingerprint);
      expect(stored.riskProfileKey).toBe(domain.riskProfileKey);
      expect(stored.riskBufferBps).toBe(domain.riskBufferBps);
      expect(stored.requestedSeconds).toBe(domain.requestedSeconds);
      expect(stored.billableSeconds).toBe(domain.billableSeconds);
      // BIGINT round-trip: the integers come back exactly, not as floats.
      expect(stored.estimatedStableCostMicroUsd).toBe(BigInt(domain.estimatedStableCostMicroUsd));
      expect(stored.pricingEffectiveAtEpochMs).toBe(BigInt(domain.pricingEffectiveAt));
      // OpenVideo: 5 billable seconds at 60,000 micro-USD, plus the 50%
      // high-quality buffer the parent job's tier requires.
      expect(stored.estimatedStableCostMicroUsd).toBe(300_000n);
      expect(stored.estimatedPlanningCostMicroUsd).toBe(450_000n);
      expect(stored.riskBufferBps).toBe(costRiskProfile("HIGH_QUALITY_AI").bufferBps);
    });

    it("is not rewritten when the in-memory catalog would price differently", async () => {
      const { request } = await seedChain(prisma, "frozen");
      const attempt = await admit("frozen", request.id);
      const later = domainSnapshot(undefined, "NORMAL_AI");
      expect(later.estimatedPlanningCostMicroUsd).toBe(390_000);
      const stored = await repos.pricing.findByAttemptId(ORG_A, attempt.id);
      expect(stored?.estimatedPlanningCostMicroUsd).toBe(450_000n);
      expect(stored?.riskProfileKey).toBe("HIGH_QUALITY_AI");
    });

    it("keeps an FX rate immutable and undeletable while a snapshot names it", async () => {
      const { request } = await seedChain(prisma, "fx");
      const attempt = await admit("fx", request.id);
      await prisma.fxRateSnapshot.create({
        data: {
          id: "fx_2026_09",
          baseCurrency: "USD",
          quoteCurrency: "JPY",
          rateNumerator: 150n,
          rateDenominator: 1n,
          effectiveAtEpochMs: BigInt(Date.parse("2026-09-04T00:00:00.000Z")),
          sourceReference: "fixture",
        },
      });
      await prisma.generationPricingSnapshot.update({
        where: { sceneGenerationId: attempt.id },
        data: { fxSnapshotId: "fx_2026_09" },
      });
      await expect(
        prisma.fxRateSnapshot.delete({ where: { id: "fx_2026_09" } }),
      ).rejects.toMatchObject({ code: "P2003" });
      await expect(
        prisma.fxRateSnapshot.create({
          data: {
            id: "fx_bad",
            baseCurrency: "USD",
            quoteCurrency: "JPY",
            rateNumerator: 0n,
            rateDenominator: 1n,
            effectiveAtEpochMs: 0n,
          },
        }),
      ).rejects.toThrow(/fx_rate_snapshots_rate_check/);
    });
  });

  describe("paid history cannot be cascade-deleted", () => {
    it("refuses to delete a project, job, scene, request or attempt that carries history", async () => {
      const { job, scene, request } = await seedChain(prisma, "del");
      const attempt = await admit("del", request.id);
      await expect(
        prisma.videoProject.delete({ where: { id: PROJECT_A } }),
      ).rejects.toMatchObject({ code: "P2003" });
      await expect(prisma.generationJob.delete({ where: { id: job.id } })).rejects.toMatchObject({
        code: "P2003",
      });
      await expect(
        prisma.generationScene.delete({ where: { id: scene.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
      await expect(
        prisma.sceneGenerationRequest.delete({ where: { id: request.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
      await expect(
        prisma.sceneGeneration.delete({ where: { id: attempt.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("survives storyboard recomposition and asset retention", async () => {
      const { scene } = await seedChain(prisma, "prov");
      expect(
        await prisma.storyboardScene.findUnique({ where: { id: STORYBOARD_SCENE } }),
      ).toBeNull();
      const reloaded = await repos.scenes.findById(ORG_A, scene.id);
      expect(reloaded?.sourceStoryboardSceneId).toBe(STORYBOARD_SCENE);
    });
  });
});
