import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  attemptInput,
  ctx,
  dropTenants,
  HAS_DB,
  ORG_A,
  ORG_B,
  PROJECT_B,
  repositories,
  seedChain,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * Tenant isolation, with two real organizations.
 *
 * An id is not an authorization. The first version of these repositories took
 * bare ids, so any caller that obtained one — from a log, a support ticket, a
 * URL — could read or move another tenant's generation history. Every method is
 * now organization-scoped through the `VideoProject` ownership boundary, and
 * the assertions below are written from the attacker's side: organization A
 * holding organization B's ids.
 *
 * A cross-tenant id must behave exactly like a missing one. Not "denied" — a
 * distinguishable denial is itself a disclosure that the row exists.
 */
const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
const repos = HAS_DB ? repositories(prisma) : (null as unknown as ReturnType<typeof repositories>);

describe.skipIf(!HAS_DB)("organization A cannot reach organization B's generation data", () => {
  let b: Awaited<ReturnType<typeof seedChain>>;
  let bAttemptId: string;

  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
    b = await seedChain(prisma, "tenantb", ORG_B, PROJECT_B);
    const admitted = await repos.attempts.admit(
      ORG_B,
      attemptInput({
        id: "sgen_tenantb",
        generationSceneRequestId: b.request.id,
        sourceAssetId: "ast_itest_orch_b",
      }),
      ctx(),
    );
    if (admitted.kind !== "ADMITTED") throw new Error(`admission failed: ${admitted.kind}`);
    bAttemptId = admitted.attempt.id;
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  describe("reads", () => {
    it("cannot read B's job", async () => {
      expect(await repos.jobs.findById(ORG_A, b.job.id)).toBeNull();
      // And B can, so the null above is isolation rather than a broken fixture.
      expect(await repos.jobs.findById(ORG_B, b.job.id)).not.toBeNull();
    });

    it("cannot read B's reservation", async () => {
      const moved = await repos.jobs.transition({
        organizationId: ORG_B,
        id: b.job.id,
        expectedState: "CREATED",
        expectedVersion: 0,
        nextState: "RESERVING",
        context: ctx(),
      });
      if (moved.kind !== "APPLIED") throw new Error("expected APPLIED");
      await repos.reservations.reserve(
        ORG_B,
        {
          reservationId: "genres_tenantb",
          generationJobId: b.job.id,
          expectedJobVersion: moved.value.stateVersion,
          billingCycleKey: "2026-09",
          billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
          billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
        },
        ctx(),
      );
      expect(await repos.reservations.findByJobId(ORG_A, b.job.id)).toBeNull();
      expect(await repos.reservations.findByJobId(ORG_B, b.job.id)).not.toBeNull();
    });

    it("cannot read B's scene, by id or by listing its job", async () => {
      expect(await repos.scenes.findById(ORG_A, b.scene.id)).toBeNull();
      expect(await repos.scenes.listByJobId(ORG_A, b.job.id)).toEqual([]);
      expect(await repos.scenes.listByJobId(ORG_B, b.job.id)).toHaveLength(1);
    });

    it("cannot read B's scene request", async () => {
      expect(await repos.requests.findById(ORG_A, b.request.id)).toBeNull();
      expect(await repos.requests.listBySceneId(ORG_A, b.scene.id)).toEqual([]);
      expect(await repos.requests.listBySceneId(ORG_B, b.scene.id)).toHaveLength(1);
    });

    it("cannot read B's attempt", async () => {
      expect(await repos.attempts.findById(ORG_A, bAttemptId)).toBeNull();
      expect(await repos.attempts.listByRequestId(ORG_A, b.request.id)).toEqual([]);
      expect(await repos.attempts.listByRequestId(ORG_B, b.request.id)).toHaveLength(1);
    });

    it("cannot read B's pricing snapshot", async () => {
      // The cost of another tenant's generation is commercially sensitive on
      // its own, independently of the attempt it prices.
      expect(await repos.pricing.findByAttemptId(ORG_A, bAttemptId)).toBeNull();
      expect(await repos.pricing.findByAttemptId(ORG_B, bAttemptId)).not.toBeNull();
    });

    it("cannot read B's transition history, by aggregate or by correlation", async () => {
      expect(await repos.events.listForAggregate(ORG_A, "JOB", b.job.id)).toEqual([]);
      expect(await repos.events.listForAggregate(ORG_A, "ATTEMPT", bAttemptId)).toEqual([]);
      // Correlation ids are shared across the fixture on purpose: a scope that
      // keyed only on the aggregate would leak here.
      expect(await repos.events.listForCorrelation(ORG_A, "corr_itest")).toEqual([]);
      expect(
        (await repos.events.listForCorrelation(ORG_B, "corr_itest")).length,
      ).toBeGreaterThan(0);
    });
  });

  describe("writes", () => {
    it("cannot transition B's job, and leaves no event behind", async () => {
      const lost = await repos.jobs.transition({
        organizationId: ORG_A,
        id: b.job.id,
        expectedState: "CREATED",
        expectedVersion: 0,
        nextState: "RESERVING",
        context: ctx({ correlationId: "corr_attacker" }),
      });
      expect(lost.kind).toBe("LOST");

      const row = await prisma.generationJob.findUnique({ where: { id: b.job.id } });
      expect(row?.state).toBe("CREATED");
      expect(row?.stateVersion).toBe(0);
      // A failed cross-tenant operation writes no history at all — not even a
      // rejected-attempt record, which would itself confirm the row exists.
      expect(
        await prisma.generationTransitionEvent.findMany({
          where: { correlationId: "corr_attacker" },
        }),
      ).toEqual([]);
    });

    it("cannot transition B's scene or request", async () => {
      const scene = await repos.scenes.transition({
        organizationId: ORG_A,
        id: b.scene.id,
        expectedState: "PENDING",
        expectedVersion: 0,
        nextState: "GENERATING",
        context: ctx(),
      });
      expect(scene.kind).toBe("LOST");

      const request = await repos.requests.transition({
        organizationId: ORG_A,
        id: b.request.id,
        expectedState: "PENDING",
        expectedVersion: 0,
        nextState: "GENERATING",
        context: ctx(),
      });
      expect(request.kind).toBe("LOST");

      expect((await prisma.generationScene.findUnique({ where: { id: b.scene.id } }))?.state).toBe(
        "PENDING",
      );
    });

    it("cannot arm B's attempt", async () => {
      // The most valuable cross-tenant write there is: arming another tenant's
      // provider boundary spends their money.
      const armed = await repos.attempts.armProviderBoundary({
        organizationId: ORG_A,
        id: bAttemptId,
        expectedVersion: 0,
        context: ctx({ correlationId: "corr_attacker_arm" }),
      });
      expect(armed.kind).toBe("LOST");

      const row = await prisma.sceneGeneration.findUnique({ where: { id: bAttemptId } });
      expect(row?.orchestrationState).toBe("QUEUED");
      expect(row?.submissionBoundaryEnteredAt).toBeNull();
      expect(
        await prisma.generationTransitionEvent.findMany({
          where: { correlationId: "corr_attacker_arm" },
        }),
      ).toEqual([]);
    });

    it("cannot record a submission outcome on B's attempt", async () => {
      const armed = await repos.attempts.armProviderBoundary({
        organizationId: ORG_B,
        id: bAttemptId,
        expectedVersion: 0,
        context: ctx(),
      });
      if (armed.kind !== "ARMED") throw new Error("expected ARMED");

      const stolen = await repos.attempts.recordSubmissionOutcome({
        organizationId: ORG_A,
        id: bAttemptId,
        expectedVersion: armed.attempt.stateVersion,
        outcome: {
          certainty: "ACCEPTED",
          state: "PROCESSING",
          providerPredictionId: "pred_attacker",
          providerAcceptedAt: new Date(),
        },
        normalizedErrorCode: null,
        context: ctx(),
      });
      expect(stolen.kind).toBe("LOST");
      const row = await prisma.sceneGeneration.findUnique({ where: { id: bAttemptId } });
      expect(row?.providerPredictionId).toBeNull();
      expect(row?.submissionCertainty).toBe("PRE_SUBMISSION");
    });

    it("cannot admit an attempt onto B's request", async () => {
      const outcome = await repos.attempts.admit(
        ORG_A,
        attemptInput({ id: "sgen_attacker", generationSceneRequestId: b.request.id }),
        ctx(),
      );
      // Indistinguishable from a request that does not exist.
      expect(outcome.kind).toBe("REQUEST_NOT_FOUND");
      expect(await prisma.sceneGeneration.findUnique({ where: { id: "sgen_attacker" } })).toBeNull();
    });

    it("cannot admit a regeneration onto B's scene", async () => {
      const outcome = await repos.requests.admitUserRegeneration(
        ORG_A,
        {
          id: "genreq_attacker",
          generationSceneId: b.scene.id,
          requestedByUserId: "usr_attacker",
        },
        ctx(),
      );
      expect(outcome.kind).toBe("SCENE_NOT_FOUND");
    });

    it("cannot create a job on B's project", async () => {
      const created = await repos.jobs.create(
        ORG_A,
        {
          id: "genjob_attacker",
          videoProjectId: PROJECT_B,
          requestedByUserId: "usr_attacker",
          qualityTier: "NORMAL",
          targetOutputResolution: "1080p",
          requestedDurationSeconds: 30,
        },
        ctx(),
      );
      expect(created.kind).toBe("PROJECT_NOT_FOUND");
      expect(await prisma.generationJob.findUnique({ where: { id: "genjob_attacker" } })).toBeNull();
    });

    it("cannot create a scene on B's job", async () => {
      const scene = await repos.scenes.create(
        ORG_A,
        {
          id: "genscene_attacker",
          generationJobId: b.job.id,
          position: 1,
          sourceStoryboardSceneId: "sbs_x",
          sourceAssetId: "ast_x",
          sourceAnalysisRevision: 1,
          snapshotDurationSeconds: 5,
          snapshotCameraMotion: null,
          snapshotCompiledPrompt: null,
        },
        ctx(),
      );
      expect(scene).toBeNull();
    });

    it("cannot create an initial request on B's scene", async () => {
      const request = await repos.requests.createInitial(
        ORG_A,
        {
          id: "genreq_attacker_initial",
          generationSceneId: b.scene.id,
          requestedByUserId: "usr_attacker",
        },
        ctx(),
      );
      expect(request).toBeNull();
    });
  });

  it("stamps every event with the organization that produced it", async () => {
    // The column is set from the scoped operation, never read out of metadata:
    // metadata is caller decoration, and taking tenancy from it would let a
    // caller relabel whose history an event joins.
    const rows = await prisma.generationTransitionEvent.findMany({
      where: { aggregateId: b.job.id },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ORG_B)).toBe(true);
    expect(await prisma.generationTransitionEvent.count({ where: { organizationId: ORG_A } })).toBe(
      0,
    );
  });
});
