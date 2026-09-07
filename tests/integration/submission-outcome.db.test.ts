import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFixedSubmissionClock,
  createPricingSnapshot,
  createProviderPricingCatalog,
  createSubmissionOutcomeService,
  defaultReconciliationPolicy,
  epochMillisFromDate,
  staleSubmittingBoundary,
  STALE_SUBMISSION_RECOVERY_EVENT_TYPE,
  SUBMISSION_OUTCOME_EVENT_TYPE,
  type EpochMillis,
  type FxSnapshot,
  type PricingSnapshot,
  type ProviderSubmissionObservation,
  type SubmissionClock,
} from "@app/domain";
import {
  createPaidSubmissionAuthorizationRepository,
  createSubmissionOutcomeRepository,
} from "@app/database";
import {
  ASSET_A,
  ctx,
  dropTenants,
  HAS_DB,
  OPEN_VIDEO_IDENTITY,
  ORG_A,
  ORG_B,
  PROJECT_A,
  PROJECT_B,
  repositories,
  seedTenants,
  STORYBOARD_SCENE,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * Submission outcome persistence against live PostgreSQL.
 *
 * Everything here writes down news that has already been observed. No provider
 * is constructed, no HTTP client exists in the service's dependencies, and
 * nothing in this phase asks a provider anything — reconciliation that *polls*
 * is a later phase.
 */

const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
/** A second pool, so a lock held on one connection genuinely blocks the other. */
const other = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
/** A third pool, used only to hold a lock while the other two contend for it. */
const blocker = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);

const BOUNDARY = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));
const POLICY = defaultReconciliationPolicy();
const STALE_AT = staleSubmittingBoundary(BOUNDARY, POLICY);
const CYCLE = "2026-09";
const FX_ID = "fx_outcome";

const FX: FxSnapshot = {
  id: FX_ID,
  baseCurrency: "USD",
  quoteCurrency: "JPY",
  rateNumerator: 150,
  rateDenominator: 1,
  effectiveAt: epochMillisFromDate(new Date("2026-09-01T00:00:00.000Z")),
  sourceReference: "itest",
};

const ACCEPTED: ProviderSubmissionObservation = {
  kind: "ACCEPTED",
  providerPredictionId: "pred_live",
  providerAcceptedAt: BOUNDARY,
};
const UNKNOWN: ProviderSubmissionObservation = {
  kind: "SUBMISSION_UNKNOWN",
  normalizedErrorCode: "TIMEOUT",
};

function service(
  client: PrismaClient = prisma,
  clock: SubmissionClock = createFixedSubmissionClock(BOUNDARY),
) {
  return createSubmissionOutcomeService({
    outcomes: createSubmissionOutcomeRepository(client),
    clock,
    policy: POLICY,
  });
}

function snapshotFor(seconds: number): PricingSnapshot {
  const contract = createProviderPricingCatalog().findByIdentity(OPEN_VIDEO_IDENTITY);
  if (contract === undefined) throw new Error("expected a pricing contract");
  const taken = createPricingSnapshot({
    contract,
    riskProfileKey: "NORMAL_AI",
    requestedSeconds: seconds,
    pricingEffectiveAt: epochMillisFromDate(new Date("2026-09-04T00:00:00.000Z")),
    fx: FX,
  });
  if (!taken.ok) throw new Error("expected a pricing snapshot");
  return taken.value;
}

/** A chain whose attempt has already crossed into `SUBMITTING`. */
async function seedSubmittingAttempt(
  suffix: string,
  options: {
    readonly organizationId?: string;
    readonly videoProjectId?: string;
    readonly reserve?: boolean;
  } = {},
) {
  const organizationId = options.organizationId ?? ORG_A;
  const videoProjectId = options.videoProjectId ?? PROJECT_A;
  const repos = repositories(prisma);

  const created = await repos.jobs.create(
    organizationId,
    {
      id: `genjob_${suffix}`,
      videoProjectId,
      requestedByUserId: "usr_itest",
      qualityTier: "NORMAL",
      requestedDurationSeconds: 30,
    },
    ctx(),
  );
  if (created.kind !== "CREATED") throw new Error(`job: ${created.kind}`);

  if (options.reserve !== false) {
    const moved = await repos.jobs.transition({
      organizationId,
      id: created.job.id,
      expectedState: "CREATED",
      expectedVersion: 0,
      nextState: "RESERVING",
      context: ctx(),
    });
    if (moved.kind !== "APPLIED") throw new Error("expected APPLIED");
    const reserved = await repos.reservations.reserve(
      organizationId,
      {
        reservationId: `genres_${suffix}`,
        generationJobId: created.job.id,
        expectedJobVersion: moved.value.stateVersion,
        billingCycleKey: CYCLE,
        billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
        billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
      },
      ctx(),
    );
    if (reserved.kind !== "RESERVED") throw new Error(`reservation: ${reserved.kind}`);
  }

  const scene = await repos.scenes.create(
    organizationId,
    {
      id: `genscene_${suffix}`,
      generationJobId: created.job.id,
      position: 0,
      sourceStoryboardSceneId: STORYBOARD_SCENE,
      sourceAssetId: ASSET_A,
      sourceAnalysisRevision: 1,
      snapshotDurationSeconds: 5,
      snapshotCameraMotion: "SLOW_PAN",
      snapshotCompiledPrompt: `a sunlit living room, cinematic (${suffix})`,
    },
    ctx(),
  );
  if (scene === null) throw new Error("scene not created");

  const request = await repos.requests.createInitial(
    organizationId,
    { id: `genreq_${suffix}`, generationSceneId: scene.id, requestedByUserId: "usr_itest" },
    ctx(),
  );
  if (request === null) throw new Error("request not created");

  const admitted = await repos.attempts.admit(
    organizationId,
    {
      id: `sgen_${suffix}`,
      generationSceneRequestId: request.id,
      providerName: "wavespeed",
      providerModelId: "wavespeed-ai/open-video/image-to-video",
      requestModelKey: "wavespeed-open-video",
      requestRenderedPrompt: "a sunlit living room, cinematic, slow pan",
      requestNativeGenerationResolution: "1080p",
      requestResolutionNormalization: "NONE",
      requestNativeMeetsTarget: true,
      pricingSnapshotId: `price_sgen_${suffix}`,
      pricingSnapshot: snapshotFor(5),
      fxSnapshot: FX,
    },
    ctx(),
  );
  if (admitted.kind !== "ADMITTED") throw new Error(`attempt: ${admitted.kind}`);

  // Cross the boundary exactly as Phase 4C-3B-2F-1's gate does, so the row this
  // phase acts on is the row that phase produces.
  const armed = await repos.attempts.armProviderBoundary({
    organizationId,
    id: admitted.attempt.id,
    expectedVersion: admitted.attempt.stateVersion,
    context: ctx(),
  });
  if (armed.kind !== "ARMED") throw new Error(`arm: ${armed.kind}`);
  // Pin the boundary instant so every deadline in the suite is deterministic.
  await prisma.sceneGeneration.update({
    where: { id: admitted.attempt.id },
    data: { submissionBoundaryEnteredAt: new Date(BOUNDARY) },
  });

  return { job: created.job, scene, request, attempt: armed.attempt };
}

function settled<T>(promise: Promise<T>): { done: () => boolean; value: Promise<T> } {
  let finished = false;
  const value = promise.finally(() => {
    finished = true;
  });
  void value.catch(() => undefined);
  return { done: () => finished, value };
}

async function breathe(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function reservationOf(jobId: string) {
  return prisma.generationReservation.findFirstOrThrow({
    where: { generationJobId: jobId },
  });
}

describe.skipIf(!HAS_DB)("submission outcome persistence", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
    await other.$disconnect();
    await blocker.$disconnect();
  });

  describe("the three outcomes", () => {
    it("records an acceptance with its provider reference exactly once", async () => {
      const { attempt, job } = await seedSubmittingAttempt("acc");
      const outcome = await service().recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: ACCEPTED,
        context: ctx(),
      });
      expect(outcome).toMatchObject({ kind: "APPLIED", attemptId: attempt.id });

      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("PROCESSING");
      expect(row.submissionCertainty).toBe("ACCEPTED");
      expect(row.providerPredictionId).toBe("pred_live");
      expect(row.providerAcceptedAt).not.toBeNull();
      // Acceptance resolves the entitlement question rather than suspending it.
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
    });

    it.each([
      ["terminal", false, "FAILED_TERMINAL"],
      ["retryable", true, "FAILED_RETRYABLE"],
    ] as const)("records a %s definitive rejection", async (_label, retryable, state) => {
      const { attempt, job } = await seedSubmittingAttempt(`rej${retryable ? "r" : "t"}`);
      const outcome = await service().recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: { kind: "DEFINITIVELY_REJECTED", retryable, normalizedErrorCode: "E" },
        context: ctx(),
      });
      expect(outcome).toMatchObject({ kind: "APPLIED" });

      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe(state);
      expect(row.submissionCertainty).toBe("DEFINITIVELY_REJECTED");
      expect(row.providerPredictionId).toBeNull();
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
    });

    it("records uncertainty and suspends the hold in the same commit", async () => {
      const { attempt, job } = await seedSubmittingAttempt("unk");
      const outcome = await service().recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: UNKNOWN,
        context: ctx(),
      });
      expect(outcome).toMatchObject({ kind: "APPLIED" });

      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("RECONCILIATION_PENDING");
      expect(row.submissionCertainty).toBe("SUBMISSION_UNKNOWN");
      expect(row.providerPredictionId).toBeNull();
      // Anchored to the boundary, not to now.
      expect(row.reconciliationStartedAt?.getTime()).toBe(BOUNDARY);
      expect(row.reconciliationDeadlineAt?.getTime()).toBe(
        BOUNDARY + POLICY.reconciliationWindowMs,
      );
      expect((await reservationOf(job.id)).state).toBe("RECONCILIATION_HOLD");
    });

    it("writes the outcome event under the service's own label", async () => {
      const { attempt } = await seedSubmittingAttempt("evt");
      await service().recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: ACCEPTED,
        context: ctx({ eventType: "CALLER_CHOSEN" }),
      });
      const history = await repositories(prisma).events.listForAggregate(
        ORG_A,
        "ATTEMPT",
        attempt.id,
      );
      expect(history.map((e) => [e.fromState, e.toState])).toEqual([
        [null, "QUEUED"],
        ["QUEUED", "SUBMITTING"],
        ["SUBMITTING", "PROCESSING"],
      ]);
      expect(history[2]?.eventType).toBe(SUBMISSION_OUTCOME_EVENT_TYPE);
      expect(history[2]?.eventType).not.toBe("CALLER_CHOSEN");
    });
  });

  describe("replay", () => {
    it("is exact: no second event, no timestamp moves, no deadline extended", async () => {
      const { attempt, job } = await seedSubmittingAttempt("replay");
      const first = service();
      expect(
        (
          await first.recordObservation({
            organizationId: ORG_A,
            attemptId: attempt.id,
            observation: UNKNOWN,
            context: ctx(),
          })
        ).kind,
      ).toBe("APPLIED");

      const after = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      const eventsBefore = (
        await repositories(prisma).events.listForAggregate(ORG_A, "ATTEMPT", attempt.id)
      ).length;
      const heldBefore = await reservationOf(job.id);

      // The same news again, ten hours later on a different clock.
      const replayed = await service(
        prisma,
        createFixedSubmissionClock((BOUNDARY + 10 * 60 * 60 * 1000) as EpochMillis),
      ).recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: UNKNOWN,
        context: ctx(),
      });
      expect(replayed).toEqual({ kind: "REPLAYED", attemptId: attempt.id });

      const now = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(now.stateVersion).toBe(after.stateVersion);
      expect(now.reconciliationStartedAt?.getTime()).toBe(
        after.reconciliationStartedAt?.getTime(),
      );
      expect(now.reconciliationDeadlineAt?.getTime()).toBe(
        after.reconciliationDeadlineAt?.getTime(),
      );
      expect(
        (await repositories(prisma).events.listForAggregate(ORG_A, "ATTEMPT", attempt.id)).length,
      ).toBe(eventsBefore);
      const heldAfter = await reservationOf(job.id);
      expect(heldAfter.stateVersion).toBe(heldBefore.stateVersion);
      expect(heldAfter.state).toBe("RECONCILIATION_HOLD");
    });

    it("does not re-stamp providerAcceptedAt on an accepted replay", async () => {
      // The provider reference is persisted exactly once. A replay that
      // re-stamped it would move the record of when the provider took the work.
      const { attempt } = await seedSubmittingAttempt("accreplay");
      await service().recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: ACCEPTED,
        context: ctx(),
      });
      const first = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });

      await service().recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: { ...ACCEPTED, providerAcceptedAt: (BOUNDARY + 99_000) as EpochMillis },
        context: ctx(),
      });
      const second = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: attempt.id },
      });
      expect(second.providerAcceptedAt?.getTime()).toBe(first.providerAcceptedAt?.getTime());
      expect(second.stateVersion).toBe(first.stateVersion);
    });
  });

  describe("conflicting observations fail closed", () => {
    it("refuses a second, different provider reference and writes nothing", async () => {
      const { attempt } = await seedSubmittingAttempt("conflict");
      await service().recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: ACCEPTED,
        context: ctx(),
      });
      const before = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: attempt.id },
      });

      expect(
        await service().recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: { ...ACCEPTED, providerPredictionId: "pred_other" },
          context: ctx(),
        }),
      ).toEqual({ kind: "CONFLICTING_OBSERVATION", reason: "PROVIDER_REFERENCE_MISMATCH" });

      const after = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(after.providerPredictionId).toBe("pred_live");
      expect(after.stateVersion).toBe(before.stateVersion);
    });

    it("refuses uncertainty over a recorded acceptance", async () => {
      const { attempt, job } = await seedSubmittingAttempt("uoveracc");
      await service().recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: ACCEPTED,
        context: ctx(),
      });
      expect(
        await service().recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: UNKNOWN,
          context: ctx(),
        }),
      ).toEqual({ kind: "CONFLICTING_OBSERVATION", reason: "CERTAINTY_MISMATCH" });
      // And the entitlement was never suspended by the refused observation.
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
    });
  });

  describe("stale-SUBMITTING recovery", () => {
    it("refuses before the threshold and applies at it", async () => {
      const { attempt } = await seedSubmittingAttempt("stale");
      const early = await service(
        prisma,
        createFixedSubmissionClock((STALE_AT - 1) as EpochMillis),
      ).enterUncertaintyForStaleSubmitting({
        organizationId: ORG_A,
        attemptId: attempt.id,
        normalizedErrorCode: null,
        context: ctx(),
      });
      expect(early).toEqual({ kind: "NOT_STALE_YET", staleAt: STALE_AT });
      expect(
        (await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } }))
          .orchestrationState,
      ).toBe("SUBMITTING");

      const atThreshold = await service(
        prisma,
        createFixedSubmissionClock(STALE_AT),
      ).enterUncertaintyForStaleSubmitting({
        organizationId: ORG_A,
        attemptId: attempt.id,
        normalizedErrorCode: null,
        context: ctx(),
      });
      expect(atThreshold).toMatchObject({ kind: "APPLIED" });
      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("RECONCILIATION_PENDING");
      expect(row.submissionCertainty).toBe("SUBMISSION_UNKNOWN");
      // Never back to QUEUED, and no provider reference invented.
      expect(row.providerPredictionId).toBeNull();
    });

    it("produces the same deadline as a direct observation would", async () => {
      // The property that makes the two entry paths' race benign: both anchor
      // to the boundary, so neither can grant itself a longer window.
      const direct = await seedSubmittingAttempt("deadA");
      const swept = await seedSubmittingAttempt("deadB");
      await service().recordObservation({
        organizationId: ORG_A,
        attemptId: direct.attempt.id,
        observation: UNKNOWN,
        context: ctx(),
      });
      await service(
        prisma,
        createFixedSubmissionClock((STALE_AT + 3_600_000) as EpochMillis),
      ).enterUncertaintyForStaleSubmitting({
        organizationId: ORG_A,
        attemptId: swept.attempt.id,
        normalizedErrorCode: null,
        context: ctx(),
      });

      const a = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: direct.attempt.id },
      });
      const b = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: swept.attempt.id },
      });
      expect(b.reconciliationDeadlineAt?.getTime()).toBe(a.reconciliationDeadlineAt?.getTime());
      expect(b.reconciliationStartedAt?.getTime()).toBe(a.reconciliationStartedAt?.getTime());
    });

    it("labels the recovery event distinctly from a direct observation", async () => {
      const { attempt } = await seedSubmittingAttempt("stalelabel");
      await service(prisma, createFixedSubmissionClock(STALE_AT)).enterUncertaintyForStaleSubmitting(
        {
          organizationId: ORG_A,
          attemptId: attempt.id,
          normalizedErrorCode: null,
          context: ctx(),
        },
      );
      const history = await repositories(prisma).events.listForAggregate(
        ORG_A,
        "ATTEMPT",
        attempt.id,
      );
      expect(history.at(-1)?.eventType).toBe(STALE_SUBMISSION_RECOVERY_EVENT_TYPE);
    });
  });

  describe("the reservation matrix", () => {
    it("moves RESERVED to RECONCILIATION_HOLD and records the event", async () => {
      const { attempt, job } = await seedSubmittingAttempt("resv");
      await service().recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: UNKNOWN,
        context: ctx(),
      });
      expect((await reservationOf(job.id)).state).toBe("RECONCILIATION_HOLD");
      const history = await repositories(prisma).events.listForAggregate(
        ORG_A,
        "RESERVATION",
        `genres_resv`,
      );
      expect(history.map((e) => e.toState)).toContain("RECONCILIATION_HOLD");
    });

    it("leaves a CONSUMED reservation consumed", async () => {
      // A post-delivery regeneration's unit is already spent. Suspending it
      // would re-open an entitlement the customer already used.
      const { attempt, job } = await seedSubmittingAttempt("resvcons");
      await prisma.generationReservation.updateMany({
        where: { generationJobId: job.id },
        data: { state: "CONSUMED", consumedAt: new Date() },
      });
      const before = await reservationOf(job.id);

      expect(
        (
          await service().recordObservation({
            organizationId: ORG_A,
            attemptId: attempt.id,
            observation: UNKNOWN,
            context: ctx(),
          })
        ).kind,
      ).toBe("APPLIED");

      const after = await reservationOf(job.id);
      expect(after.state).toBe("CONSUMED");
      expect(after.stateVersion).toBe(before.stateVersion);
      // And provider reality was still recorded.
      expect(
        (await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } }))
          .orchestrationState,
      ).toBe("RECONCILIATION_PENDING");
    });

    it("leaves a RELEASED reservation released and still records the outcome", async () => {
      const { attempt, job } = await seedSubmittingAttempt("resvrel");
      await prisma.generationReservation.updateMany({
        where: { generationJobId: job.id },
        data: { state: "RELEASED", releasedAt: new Date() },
      });
      expect(
        (
          await service().recordObservation({
            organizationId: ORG_A,
            attemptId: attempt.id,
            observation: UNKNOWN,
            context: ctx(),
          })
        ).kind,
      ).toBe("APPLIED");
      expect((await reservationOf(job.id)).state).toBe("RELEASED");
      expect(
        (await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } }))
          .orchestrationState,
      ).toBe("RECONCILIATION_PENDING");
    });

    it("records provider reality even with no reservation at all", async () => {
      // The entitlement bookkeeping is an anomaly; the provider may still have
      // been paid. Losing that fact is the more expensive mistake by far.
      const { attempt } = await seedSubmittingAttempt("noresv", { reserve: false });
      expect(
        (
          await service().recordObservation({
            organizationId: ORG_A,
            attemptId: attempt.id,
            observation: UNKNOWN,
            context: ctx(),
          })
        ).kind,
      ).toBe("APPLIED");
      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("RECONCILIATION_PENDING");
      expect(row.reconciliationDeadlineAt?.getTime()).toBe(
        BOUNDARY + POLICY.reconciliationWindowMs,
      );
    });

    it("consumes no customer units on any path", async () => {
      const { attempt, job } = await seedSubmittingAttempt("noquota");
      const before = await reservationOf(job.id);
      await service().recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: UNKNOWN,
        context: ctx(),
      });
      const after = await reservationOf(job.id);
      expect(after.reservedTotalVideoUnits).toBe(before.reservedTotalVideoUnits);
      expect(after.reservedHighQualityUnits).toBe(before.reservedHighQualityUnits);
      expect(after.consumedAt).toBeNull();
      // And no new reservation was minted.
      expect(
        await prisma.generationReservation.count({ where: { generationJobId: job.id } }),
      ).toBe(1);
    });

    it("creates no SYSTEM_RECOVERY attempt and consumes no regeneration right", async () => {
      const { attempt, scene } = await seedSubmittingAttempt("norecov");
      await service().recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: UNKNOWN,
        context: ctx(),
      });
      expect(
        await prisma.sceneGeneration.count({
          where: { generationSceneRequestId: `genreq_norecov` },
        }),
      ).toBe(1);
      expect(
        await prisma.sceneGenerationRequest.count({ where: { generationSceneId: scene.id } }),
      ).toBe(1);
    });
  });

  describe("tenant isolation", () => {
    it("answers a cross-tenant attempt exactly as it answers a missing one", async () => {
      const { attempt } = await seedSubmittingAttempt("tenant");
      expect(
        await service().recordObservation({
          organizationId: ORG_B,
          attemptId: attempt.id,
          observation: ACCEPTED,
          context: ctx(),
        }),
      ).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
      expect(
        (await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } }))
          .orchestrationState,
      ).toBe("SUBMITTING");
    });

    it("cannot record an outcome for another tenant's attempt via its own project", async () => {
      const foreign = await seedSubmittingAttempt("tenantb", {
        organizationId: ORG_B,
        videoProjectId: PROJECT_B,
      });
      expect(
        await service().recordObservation({
          organizationId: ORG_A,
          attemptId: foreign.attempt.id,
          observation: ACCEPTED,
          context: ctx(),
        }),
      ).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
    });
  });

  describe("concurrency", () => {
    it("lets exactly one of two identical acceptances apply; the other replays", async () => {
      const { attempt } = await seedSubmittingAttempt("raceacc");
      const results = await Promise.all([
        service(prisma).recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: ACCEPTED,
          context: ctx(),
        }),
        service(other).recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: ACCEPTED,
          context: ctx(),
        }),
      ]);
      const kinds = results.map((r) => r.kind).sort();
      expect(kinds).toEqual(["APPLIED", "REPLAYED"]);
      // One event for the outcome, not two.
      const history = await repositories(prisma).events.listForAggregate(
        ORG_A,
        "ATTEMPT",
        attempt.id,
      );
      expect(history.filter((e) => e.toState === "PROCESSING")).toHaveLength(1);
    });

    it("refuses the loser when two acceptances name different references", async () => {
      const { attempt } = await seedSubmittingAttempt("raceref");
      const results = await Promise.all([
        service(prisma).recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: ACCEPTED,
          context: ctx(),
        }),
        service(other).recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: { ...ACCEPTED, providerPredictionId: "pred_rival" },
          context: ctx(),
        }),
      ]);
      const kinds = results.map((r) => r.kind).sort();
      expect(kinds).toEqual(["APPLIED", "CONFLICTING_OBSERVATION"]);

      // Whichever won, exactly one reference is on file and it is one of the two.
      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(["pred_live", "pred_rival"]).toContain(row.providerPredictionId);
    });

    it("never lets an acceptance and an unknown both land", async () => {
      // Provider reality must not be overwritten by a presumption of loss, and
      // a presumption must not be overwritten by a late acceptance either —
      // one of them wins durably and the other is refused.
      const { attempt, job } = await seedSubmittingAttempt("raceunk");
      const results = await Promise.all([
        service(prisma).recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: ACCEPTED,
          context: ctx(),
        }),
        service(other).recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: UNKNOWN,
          context: ctx(),
        }),
      ]);
      const kinds = results.map((r) => r.kind).sort();
      expect(kinds).toEqual(["APPLIED", "CONFLICTING_OBSERVATION"]);

      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      // Exactly one of the two coherent outcomes, never a blend of both.
      if (row.submissionCertainty === "ACCEPTED") {
        expect(row.orchestrationState).toBe("PROCESSING");
        expect(row.providerPredictionId).toBe("pred_live");
        expect((await reservationOf(job.id)).state).toBe("RESERVED");
      } else {
        expect(row.submissionCertainty).toBe("SUBMISSION_UNKNOWN");
        expect(row.orchestrationState).toBe("RECONCILIATION_PENDING");
        expect(row.providerPredictionId).toBeNull();
        expect((await reservationOf(job.id)).state).toBe("RECONCILIATION_HOLD");
      }
    });

    it("lets a direct unknown and a stale sweep agree rather than conflict", async () => {
      const { attempt } = await seedSubmittingAttempt("racestale");
      const late = createFixedSubmissionClock((STALE_AT + 60_000) as EpochMillis);
      const results = await Promise.all([
        service(prisma, late).recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: UNKNOWN,
          context: ctx(),
        }),
        service(other, late).enterUncertaintyForStaleSubmitting({
          organizationId: ORG_A,
          attemptId: attempt.id,
          normalizedErrorCode: null,
          context: ctx(),
        }),
      ]);
      // Both routes compute identical durable state, so the loser replays
      // rather than conflicting.
      expect(results.map((r) => r.kind).sort()).toEqual(["APPLIED", "REPLAYED"]);
      const history = await repositories(prisma).events.listForAggregate(
        ORG_A,
        "ATTEMPT",
        attempt.id,
      );
      expect(history.filter((e) => e.toState === "RECONCILIATION_PENDING")).toHaveLength(1);
    });

    it("serializes against a Phase 2F-1 cost admission holding the same locks", async () => {
      // The two phases contend for real: an attempt entering
      // RECONCILIATION_PENDING starts counting uncertain provider cost against
      // the Safety Guard, so an authorization reading exposure while an outcome
      // lands would decide on a total that is mid-flight. They serialize
      // because this phase takes the *same* organization+cycle advisory lock
      // and the same reservation row, in the same order — only in a stronger
      // mode, because it may suspend the entitlement the gate merely reads.
      const { attempt, job } = await seedSubmittingAttempt("crossphase");

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const authorization = createPaidSubmissionAuthorizationRepository(blocker).withCostAdmission(
        { organizationId: ORG_A, attemptId: attempt.id },
        async (session) => {
          // Read facts inside the held locks, exactly as the gate does, then
          // stay in the transaction without arming.
          await session.loadFacts();
          await held;
          return null;
        },
      );

      let stillBlocked: boolean;
      try {
        await breathe(4);
        const blocked = settled(
          service(prisma).recordObservation({
            organizationId: ORG_A,
            attemptId: attempt.id,
            observation: UNKNOWN,
            context: ctx(),
          }),
        );
        await breathe();
        stillBlocked = !blocked.done();
        release();
        await authorization;
        expect(stillBlocked).toBe(true);
        expect((await blocked.value).kind).toBe("APPLIED");
      } finally {
        release();
      }
      // The gate's transaction committed without arming anything; the outcome
      // landed afterwards, on the row the gate had finished looking at.
      expect((await reservationOf(job.id)).state).toBe("RECONCILIATION_HOLD");
    });

    it("blocks uncertainty entry while a reservation writer holds the row", async () => {
      // The reservation is locked FOR UPDATE for the whole transaction, so an
      // entitlement transition and an uncertainty entry cannot interleave.
      // Whichever commits first, the other sees its result.
      const { attempt, job } = await seedSubmittingAttempt("racerel");

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writer = other.$transaction(
        async (tx) => {
          await tx.$executeRaw`
            UPDATE "generation_reservations"
               SET "state" = 'RELEASED'::"GenerationReservationState",
                   "stateVersion" = "stateVersion" + 1,
                   "releasedAt" = NOW()
             WHERE "generationJobId" = ${job.id}
          `;
          await held;
        },
        { timeout: 8_000 },
      );

      let stillBlocked: boolean;
      try {
        await breathe(4);
        const blocked = settled(
          service(prisma).recordObservation({
            organizationId: ORG_A,
            attemptId: attempt.id,
            observation: UNKNOWN,
            context: ctx(),
          }),
        );
        await breathe();
        stillBlocked = !blocked.done();
        release();
        await writer;
        expect(stillBlocked).toBe(true);

        // Provider reality is still recorded; the released hold is not revived.
        expect((await blocked.value).kind).toBe("APPLIED");
      } finally {
        release();
      }
      expect((await reservationOf(job.id)).state).toBe("RELEASED");
      expect(
        (await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } }))
          .orchestrationState,
      ).toBe("RECONCILIATION_PENDING");
    });
  });
});
