import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFixedSubmissionClock,
  createPricingSnapshot,
  createProviderPricingCatalog,
  createSubmissionOutcomeService,
  epochMillisFromDate,
  parseSubmissionDiagnosticCode,
  staleSubmittingBoundary,
  STALE_SUBMISSION_RECOVERY_EVENT_TYPE,
  SUBMISSION_UNCERTAINTY_HOLD_EVENT_TYPE,
  SUBMISSION_OUTCOME_EVENT_TYPE,
  type EpochMillis,
  type FxSnapshot,
  type PricingSnapshot,
  type ProviderSubmissionObservation,
  type ReconciliationPolicy,
  type SubmissionClock,
  type SubmissionDiagnosticCode,
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
/**
 * A fixture, not a product policy. There is deliberately no shipped default
 * stale-`SUBMITTING` threshold: how long an attempt may sit at the boundary
 * before it is presumed lost is a production-activation decision.
 */
const POLICY: ReconciliationPolicy = {
  reconciliationWindowMs: 24 * 60 * 60 * 1000,
  staleSubmittingAfterMs: 15 * 60 * 1000,
};

/** Codes exist only by passing the safe-code boundary. */
function code(value: string): SubmissionDiagnosticCode {
  const parsed = parseSubmissionDiagnosticCode(value);
  if (!parsed.ok || parsed.code === null) throw new Error(`not a safe code: ${value}`);
  return parsed.code;
}
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
};
const UNKNOWN: ProviderSubmissionObservation = {
  kind: "SUBMISSION_UNKNOWN",
  normalizedErrorCode: code("TIMEOUT"),
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
    /** Rewrites the seeded request's kind, to reach the entitlement matrix. */
    readonly requestKind?: "INITIAL" | "USER_REGENERATION";
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

  if (options.requestKind === "USER_REGENERATION") {
    // A post-delivery regeneration. Reached by rewriting the seeded row rather
    // than driving the regeneration admission path, which needs a delivered
    // video this suite has no interest in producing.
    await prisma.sceneGenerationRequest.update({
      where: { id: request.id },
      data: { kind: "USER_REGENERATION", userRegenerationOrdinal: 1 },
    });
  }

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
        observation: { kind: "DEFINITIVELY_REJECTED", retryable, normalizedErrorCode: code("E") },
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

    it("stamps providerAcceptedAt from the service clock and never re-stamps it", async () => {
      // The caller cannot supply this instant — the observation has no field
      // for it — so it comes from the clock read after the lock. A replay on a
      // later clock must not move it: that would rewrite when money started
      // being spent.
      const { attempt } = await seedSubmittingAttempt("accreplay");
      const acceptedAt = (BOUNDARY + 4_000) as EpochMillis;
      await service(prisma, createFixedSubmissionClock(acceptedAt)).recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: ACCEPTED,
        context: ctx(),
      });
      const first = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(first.providerAcceptedAt?.getTime()).toBe(acceptedAt);

      const replayed = await service(
        prisma,
        createFixedSubmissionClock((BOUNDARY + 99_000) as EpochMillis),
      ).recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: ACCEPTED,
        context: ctx(),
      });
      expect(replayed).toEqual({ kind: "REPLAYED", attemptId: attempt.id });

      const second = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: attempt.id },
      });
      expect(second.providerAcceptedAt?.getTime()).toBe(acceptedAt);
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
      // The deadline is boundary-derived, so the two routes agree on it even
      // though one of them looked hours later. That is what stops a delayed
      // sweeper granting itself a longer window than a prompt observer.
      expect(b.reconciliationDeadlineAt?.getTime()).toBe(a.reconciliationDeadlineAt?.getTime());
      // The *start* is a different fact — when each route first durably
      // concluded it did not know — so it does not agree, and must not.
      expect(b.reconciliationStartedAt?.getTime()).not.toBe(
        a.reconciliationStartedAt?.getTime(),
      );
      expect(a.reconciliationStartedAt?.getTime()).toBe(BOUNDARY);
      expect(b.reconciliationStartedAt?.getTime()).toBe(STALE_AT + 3_600_000);
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

  describe("replay identity is provider reality, not landing state", () => {
    // The correction this round turned on. An accepted attempt whose execution
    // has moved on has not contradicted its acceptance, and refusing there
    // would demand a human adjudicate a duplicate delivery of unchanged news.
    const advanced = [
      "PROCESSING",
      "PROVIDER_SUCCEEDED",
      "OUTPUT_INGESTING",
      "OUTPUT_VERIFIED",
    ] as const;

    async function acceptThenAdvance(suffix: string, state: (typeof advanced)[number]) {
      const seeded = await seedSubmittingAttempt(suffix);
      await service().recordObservation({
        organizationId: ORG_A,
        attemptId: seeded.attempt.id,
        observation: ACCEPTED,
        context: ctx(),
      });
      if (state !== "PROCESSING") {
        await prisma.sceneGeneration.update({
          where: { id: seeded.attempt.id },
          data: { orchestrationState: state },
        });
      }
      return seeded;
    }

    it.each(advanced)("replays the same acceptance at %s", async (state) => {
      const { attempt } = await acceptThenAdvance(`adv${state.slice(0, 6)}`, state);
      const before = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: attempt.id },
      });
      const eventsBefore = (
        await repositories(prisma).events.listForAggregate(ORG_A, "ATTEMPT", attempt.id)
      ).length;

      expect(
        await service(
          prisma,
          createFixedSubmissionClock((BOUNDARY + 9 * 60 * 60 * 1000) as EpochMillis),
        ).recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: ACCEPTED,
          context: ctx(),
        }),
      ).toEqual({ kind: "REPLAYED", attemptId: attempt.id });

      // Zero rows, zero events. The attempt is not dragged backwards.
      const after = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: attempt.id },
      });
      expect(after.orchestrationState).toBe(state);
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.providerAcceptedAt?.getTime()).toBe(before.providerAcceptedAt?.getTime());
      expect(
        (await repositories(prisma).events.listForAggregate(ORG_A, "ATTEMPT", attempt.id)).length,
      ).toBe(eventsBefore);
    });

    it.each(advanced)("still conflicts on a different reference at %s", async (state) => {
      const { attempt } = await acceptThenAdvance(`rv${state.slice(0, 6)}`, state);
      expect(
        await service().recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: { ...ACCEPTED, providerPredictionId: "pred_rival" },
          context: ctx(),
        }),
      ).toEqual({ kind: "CONFLICTING_OBSERVATION", reason: "PROVIDER_REFERENCE_MISMATCH" });
      expect(
        (await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } }))
          .providerPredictionId,
      ).toBe("pred_live");
    });

    it("replays uncertainty after the reconciliation window was exhausted", async () => {
      // RECONCILIATION_EXHAUSTED says the window closed while provider reality
      // was still unknown — a later fact about how long nobody found out, not a
      // contradiction of the original observation.
      const { attempt } = await seedSubmittingAttempt("exhausted");
      await service().recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: UNKNOWN,
        context: ctx(),
      });
      await prisma.sceneGeneration.update({
        where: { id: attempt.id },
        data: { orchestrationState: "RECONCILIATION_EXHAUSTED" },
      });
      const before = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: attempt.id },
      });
      const eventsBefore = (
        await repositories(prisma).events.listForAggregate(ORG_A, "ATTEMPT", attempt.id)
      ).length;

      expect(
        await service(
          prisma,
          createFixedSubmissionClock((BOUNDARY + 40 * 60 * 60 * 1000) as EpochMillis),
        ).recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: UNKNOWN,
          context: ctx(),
        }),
      ).toEqual({ kind: "REPLAYED", attemptId: attempt.id });

      const after = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: attempt.id },
      });
      // Never dragged back to RECONCILIATION_PENDING, and no timestamp moved.
      expect(after.orchestrationState).toBe("RECONCILIATION_EXHAUSTED");
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.reconciliationStartedAt?.getTime()).toBe(
        before.reconciliationStartedAt?.getTime(),
      );
      expect(after.reconciliationDeadlineAt?.getTime()).toBe(
        before.reconciliationDeadlineAt?.getTime(),
      );
      expect(
        (await repositories(prisma).events.listForAggregate(ORG_A, "ATTEMPT", attempt.id)).length,
      ).toBe(eventsBefore);
    });
  });

  describe("the two reconciliation instants are different facts", () => {
    it("starts uncertainty at the clock and deadlines it from the boundary", async () => {
      const { attempt } = await seedSubmittingAttempt("twoinstants");
      const swept = (STALE_AT + 3 * 60 * 60 * 1000) as EpochMillis;
      await service(prisma, createFixedSubmissionClock(swept)).enterUncertaintyForStaleSubmitting(
        {
          organizationId: ORG_A,
          attemptId: attempt.id,
          normalizedErrorCode: null,
          context: ctx(),
        },
      );
      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      // When the system first durably concluded it did not know — hours after
      // the boundary, and not backdated to it.
      expect(row.reconciliationStartedAt?.getTime()).toBe(swept);
      expect(row.reconciliationStartedAt?.getTime()).not.toBe(BOUNDARY);
      // The deadline is a different fact and does not move with the clock.
      expect(row.reconciliationDeadlineAt?.getTime()).toBe(
        BOUNDARY + POLICY.reconciliationWindowMs,
      );
    });

    it("persists an already-past deadline rather than inventing a live one", async () => {
      // Whether that uncertainty is exhausted is Phase 2G-2's decision.
      const { attempt } = await seedSubmittingAttempt("pastdeadline");
      const wayLate = (BOUNDARY + 30 * 60 * 60 * 1000) as EpochMillis;
      expect(
        (
          await service(
            prisma,
            createFixedSubmissionClock(wayLate),
          ).enterUncertaintyForStaleSubmitting({
            organizationId: ORG_A,
            attemptId: attempt.id,
            normalizedErrorCode: null,
            context: ctx(),
          })
        ).kind,
      ).toBe("APPLIED");
      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.reconciliationDeadlineAt?.getTime()).toBe(
        BOUNDARY + POLICY.reconciliationWindowMs,
      );
      expect(row.reconciliationDeadlineAt!.getTime()).toBeLessThan(wayLate);
      expect(row.orchestrationState).toBe("RECONCILIATION_PENDING");
    });

    it("does not move reconciliationStartedAt on a replay from a later clock", async () => {
      const { attempt } = await seedSubmittingAttempt("startstable");
      const first = (BOUNDARY + 60_000) as EpochMillis;
      await service(prisma, createFixedSubmissionClock(first)).recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: UNKNOWN,
        context: ctx(),
      });
      expect(
        await service(
          prisma,
          createFixedSubmissionClock((BOUNDARY + 5 * 60 * 60 * 1000) as EpochMillis),
        ).recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: UNKNOWN,
          context: ctx(),
        }),
      ).toEqual({ kind: "REPLAYED", attemptId: attempt.id });
      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.reconciliationStartedAt?.getTime()).toBe(first);
    });
  });

  describe("entitlement anomalies are durable, never a refusal", () => {
    /**
     * Read the anomaly back from the database alone.
     *
     * Deliberately goes through persistence rather than the service's return
     * value: a crash between commit and the caller reading that value must not
     * erase the only record that an anomaly existed.
     */
    async function anomalyOf(attemptId: string): Promise<unknown> {
      const history = await repositories(prisma).events.listForAggregate(
        ORG_A,
        "ATTEMPT",
        attemptId,
      );
      return history.at(-1)?.safeMetadata["entitlementAnomaly"];
    }

    it("calls USER_REGENERATION over a CONSUMED reservation normal", async () => {
      const { attempt, job } = await seedSubmittingAttempt("regencons", {
        requestKind: "USER_REGENERATION",
      });
      await prisma.generationReservation.updateMany({
        where: { generationJobId: job.id },
        data: { state: "CONSUMED", consumedAt: new Date() },
      });
      const before = await reservationOf(job.id);

      expect(
        await service().recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: UNKNOWN,
          context: ctx(),
        }),
      ).toMatchObject({ kind: "APPLIED", entitlementAnomaly: "NONE" });

      const after = await reservationOf(job.id);
      expect(after.state).toBe("CONSUMED");
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(await anomalyOf(attempt.id)).toBe("NONE");
    });

    it("records INITIAL over a CONSUMED reservation as an anomaly, and still writes", async () => {
      const { attempt, job } = await seedSubmittingAttempt("initcons");
      await prisma.generationReservation.updateMany({
        where: { generationJobId: job.id },
        data: { state: "CONSUMED", consumedAt: new Date() },
      });
      const before = await reservationOf(job.id);

      expect(
        await service().recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: UNKNOWN,
          context: ctx(),
        }),
      ).toMatchObject({
        kind: "APPLIED",
        entitlementAnomaly: "INITIAL_RESERVATION_ALREADY_CONSUMED",
      });

      const after = await reservationOf(job.id);
      expect(after.state).toBe("CONSUMED");
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(
        (await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } }))
          .orchestrationState,
      ).toBe("RECONCILIATION_PENDING");
      // Cold-read: reconstructable from the database alone, with no live
      // process left to report it.
      expect(await anomalyOf(attempt.id)).toBe("INITIAL_RESERVATION_ALREADY_CONSUMED");
    });

    it("records a missing reservation durably", async () => {
      const { attempt } = await seedSubmittingAttempt("anomnores", { reserve: false });
      expect(
        await service().recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: UNKNOWN,
          context: ctx(),
        }),
      ).toMatchObject({ kind: "APPLIED", entitlementAnomaly: "RESERVATION_MISSING" });
      expect(await anomalyOf(attempt.id)).toBe("RESERVATION_MISSING");
    });

    it("records a released reservation durably", async () => {
      const { attempt, job } = await seedSubmittingAttempt("anomrel");
      await prisma.generationReservation.updateMany({
        where: { generationJobId: job.id },
        data: { state: "RELEASED", releasedAt: new Date() },
      });
      expect(
        await service().recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: UNKNOWN,
          context: ctx(),
        }),
      ).toMatchObject({ kind: "APPLIED", entitlementAnomaly: "RESERVATION_RELEASED" });
      expect((await reservationOf(job.id)).state).toBe("RELEASED");
      expect(await anomalyOf(attempt.id)).toBe("RESERVATION_RELEASED");
    });

    it("labels the reservation hold with its own event type", async () => {
      // The attempt event says what a provider did; this says a customer's
      // entitlement was suspended because nobody could say what the provider
      // did. An operator querying entitlement suspensions must not have to know
      // which attempt-side route caused each one.
      const { attempt, job } = await seedSubmittingAttempt("holdevt");
      await service().recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: UNKNOWN,
        context: ctx({ eventType: "CALLER_CHOSEN" }),
      });
      const reservationHistory = await repositories(prisma).events.listForAggregate(
        ORG_A,
        "RESERVATION",
        `genres_holdevt`,
      );
      const hold = reservationHistory.filter((e) => e.toState === "RECONCILIATION_HOLD");
      expect(hold).toHaveLength(1);
      expect(hold[0]?.eventType).toBe(SUBMISSION_UNCERTAINTY_HOLD_EVENT_TYPE);
      expect(hold[0]?.eventType).not.toBe(SUBMISSION_OUTCOME_EVENT_TYPE);
      expect(hold[0]?.eventType).not.toBe("CALLER_CHOSEN");

      // And the attempt's own event keeps its own label.
      const attemptHistory = await repositories(prisma).events.listForAggregate(
        ORG_A,
        "ATTEMPT",
        attempt.id,
      );
      expect(attemptHistory.at(-1)?.eventType).toBe(SUBMISSION_OUTCOME_EVENT_TYPE);
      expect((await reservationOf(job.id)).state).toBe("RECONCILIATION_HOLD");
    });

    it("writes no reservation event when no reservation transition happened", async () => {
      const { attempt } = await seedSubmittingAttempt("noholdevt");
      await service().recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: ACCEPTED,
        context: ctx(),
      });
      const reservationHistory = await repositories(prisma).events.listForAggregate(
        ORG_A,
        "RESERVATION",
        `genres_noholdevt`,
      );
      expect(
        reservationHistory.filter((e) => e.eventType === SUBMISSION_UNCERTAINTY_HOLD_EVENT_TYPE),
      ).toHaveLength(0);
      expect(await anomalyOf(attempt.id)).toBe("NONE");
    });
  });

  describe("hostile diagnostic codes never reach the database", () => {
    it.each([
      ["a signed URL", "https://signed.example/path?token=SECRET"],
      ["a bearer credential", "Bearer secret-token"],
      ["a customer prompt", "a sunlit living room, cinematic"],
      ["raw provider text", "Provider returned 429: too many requests"],
      ["a line break", "TIMEOUT\nAuthorization: Bearer leaked"],
    ])("refuses %s and writes nothing", async (label, hostile) => {
      const { attempt } = await seedSubmittingAttempt(`hostile${label.length}`);
      expect(
        await service().recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: {
            kind: "SUBMISSION_UNKNOWN",
            normalizedErrorCode: hostile as SubmissionDiagnosticCode,
          },
          context: ctx(),
        }),
      ).toEqual({ kind: "OBSERVATION_MALFORMED" });

      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("SUBMITTING");
      expect(row.normalizedErrorCode).toBeNull();
    });

    it("refuses hostile text on the stale-recovery route too", async () => {
      const { attempt } = await seedSubmittingAttempt("hostilestale");
      expect(
        await service(
          prisma,
          createFixedSubmissionClock(STALE_AT),
        ).enterUncertaintyForStaleSubmitting({
          organizationId: ORG_A,
          attemptId: attempt.id,
          normalizedErrorCode: "Bearer secret-token" as SubmissionDiagnosticCode,
          context: ctx(),
        }),
      ).toEqual({ kind: "OBSERVATION_MALFORMED" });
      expect(
        (await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } }))
          .orchestrationState,
      ).toBe("SUBMITTING");
    });

    it("persists a well-formed code unchanged", async () => {
      const { attempt } = await seedSubmittingAttempt("goodcode");
      await service().recordObservation({
        organizationId: ORG_A,
        attemptId: attempt.id,
        observation: { kind: "SUBMISSION_UNKNOWN", normalizedErrorCode: code("CONNECTION_RESET") },
        context: ctx(),
      });
      expect(
        (await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } }))
          .normalizedErrorCode,
      ).toBe("CONNECTION_RESET");
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

    it("lets a direct unknown and a stale sweep agree, on two different clocks", async () => {
      // The clocks differ deliberately. Now that `reconciliationStartedAt` comes
      // from each worker's own clock, the two routes no longer compute an
      // identical row — so the property being tested is sharper than before:
      // replay identity is *provider reality*, and bookkeeping about when each
      // worker happened to learn it must not turn the loser into a conflict.
      const { attempt } = await seedSubmittingAttempt("racestale");
      const T1 = (STALE_AT + 60_000) as EpochMillis;
      const T2 = (STALE_AT + 7 * 60 * 1000) as EpochMillis;
      expect(T1).not.toBe(T2);

      const results = await Promise.all([
        service(prisma, createFixedSubmissionClock(T1)).recordObservation({
          organizationId: ORG_A,
          attemptId: attempt.id,
          observation: UNKNOWN,
          context: ctx(),
        }),
        service(other, createFixedSubmissionClock(T2)).enterUncertaintyForStaleSubmitting({
          organizationId: ORG_A,
          attemptId: attempt.id,
          normalizedErrorCode: null,
          context: ctx(),
        }),
      ]);
      expect(results.map((r) => r.kind).sort()).toEqual(["APPLIED", "REPLAYED"]);

      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      // The start belongs to whichever route committed first, whole — never a
      // blend, and never overwritten by the loser.
      expect([T1, T2]).toContain(row.reconciliationStartedAt?.getTime());
      // The deadline is identical whichever won, because it is boundary-derived.
      expect(row.reconciliationDeadlineAt?.getTime()).toBe(
        BOUNDARY + POLICY.reconciliationWindowMs,
      );

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
