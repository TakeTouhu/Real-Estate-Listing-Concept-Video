import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createGenerationJobRepository,
  createGenerationPricingSnapshotRepository,
  createGenerationReservationRepository,
  createGenerationSceneRepository,
  createGenerationTransitionEventRepository,
  createSceneGenerationAttemptRepository,
  createSceneGenerationRequestRepository,
} from "@app/database";
import {
  costRiskProfile,
  createPricingSnapshot,
  createProviderPricingCatalog,
  epochMillisFromDate,
  reconciliationDeadlineFrom,
  sanitizeTransitionMetadata,
  type ProviderPricingIdentity,
  type TransitionContext,
} from "@app/domain";

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
const HAS_DB = Boolean(process.env.DATABASE_URL);

const ORG = "org_itest_orch";
const PROP = "prp_itest_orch";
const PROJECT = "vpr_itest_orch";
const ASSET = "ast_itest_orch";
const STORYBOARD_SCENE = "sbs_itest_orch";

const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);

const jobs = HAS_DB ? createGenerationJobRepository(prisma) : null;
const reservations = HAS_DB ? createGenerationReservationRepository(prisma) : null;
const scenes = HAS_DB ? createGenerationSceneRepository(prisma) : null;
const requests = HAS_DB ? createSceneGenerationRequestRepository(prisma) : null;
const attempts = HAS_DB ? createSceneGenerationAttemptRepository(prisma) : null;
const pricingSnapshots = HAS_DB ? createGenerationPricingSnapshotRepository(prisma) : null;
const events = HAS_DB ? createGenerationTransitionEventRepository(prisma) : null;

function ctx(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return {
    actorType: "SYSTEM",
    actorUserId: null,
    correlationId: "corr_itest",
    causationId: null,
    reasonCode: null,
    eventType: "TEST",
    metadata: sanitizeTransitionMetadata({}),
    ...overrides,
  };
}

const catalog = HAS_DB ? createProviderPricingCatalog() : null;
const H3_MAX_IDENTITY: ProviderPricingIdentity = {
  provider: "fal",
  pricingModelKey: "minimax-h3-max",
  generationMode: "image-to-video",
  nativeTier: "768P",
  audioMode: "none",
  durationBillingRuleId: "per-second",
  pricingVersion: "2026-09-02.1",
};

/** The domain's immutable pricing decision, computed exactly as production would. */
function domainSnapshot() {
  const contract = catalog!.findByIdentity(H3_MAX_IDENTITY);
  if (contract === undefined) throw new Error("expected the H3 Max pricing contract");
  const taken = createPricingSnapshot({
    contract,
    riskProfileKey: "NORMAL_AI",
    requestedSeconds: 5,
    pricingEffectiveAt: epochMillisFromDate(new Date("2026-09-04T00:00:00.000Z")),
  });
  if (!taken.ok) throw new Error("expected a pricing snapshot");
  return taken.value;
}

async function wipe(): Promise<void> {
  await prisma.generationTransitionEvent.deleteMany({});
  await prisma.generationPricingSnapshot.deleteMany({});
  await prisma.sceneGeneration.deleteMany({ where: { videoProjectId: PROJECT } });
  await prisma.sceneGenerationRequest.deleteMany({});
  await prisma.generationScene.deleteMany({});
  await prisma.generationReservation.deleteMany({});
  await prisma.generationJob.deleteMany({});
  await prisma.fxRateSnapshot.deleteMany({});
}

async function seedProject(): Promise<void> {
  await prisma.property.upsert({
    where: { id: PROP },
    update: {},
    create: {
      id: PROP,
      organizationId: ORG,
      name: "Orchestration fixture",
      propertyType: "APARTMENT",
      createdBy: "usr_itest",
    },
  });
  await prisma.mediaAsset.upsert({
    where: { id: ASSET },
    update: {},
    create: {
      id: ASSET,
      organizationId: ORG,
      propertyId: PROP,
      storageKey: `org/${ORG}/a/${ASSET}/normalized.jpg`,
      originalFilename: "a.jpg",
      status: "READY",
      createdBy: "usr_itest",
    },
  });
  await prisma.videoProject.upsert({
    where: { id: PROJECT },
    update: {},
    create: {
      id: PROJECT,
      organizationId: ORG,
      propertyId: PROP,
      name: "Orchestration project",
      durationSeconds: 60,
      aspectRatio: "16:9",
      targetOutputResolution: "1080p",
      createdBy: "usr_itest",
    },
  });
}

/** A full job → scene → request chain, ready for attempts. */
async function seedChain(suffix: string) {
  const job = await jobs!.create(
    {
      id: `genjob_${suffix}`,
      videoProjectId: PROJECT,
      requestedByUserId: "usr_itest",
      qualityTier: "HIGH_QUALITY",
      targetOutputResolution: "1080p",
      requestedDurationSeconds: 60,
      requiredVideoUnits: 2,
      requiredHighQualityUnits: 2,
    },
    ctx(),
  );
  const scene = await scenes!.create(
    {
      id: `genscene_${suffix}`,
      generationJobId: job.id,
      position: 0,
      sourceStoryboardSceneId: STORYBOARD_SCENE,
      sourceAssetId: ASSET,
      sourceAnalysisRevision: 1,
      snapshotDurationSeconds: 5,
      snapshotCameraMotion: "SLOW_PAN",
      snapshotCompiledPrompt: "a sunlit living room, cinematic",
    },
    ctx(),
  );
  const request = await requests!.create(
    {
      id: `genreq_${suffix}`,
      generationSceneId: scene.id,
      kind: "INITIAL",
      userRegenerationOrdinal: null,
      requestedByUserId: "usr_itest",
    },
    ctx(),
  );
  return { job, scene, request };
}

/** One provider attempt row, admitted but not yet priced. */
async function seedAttempt(
  suffix: string,
  requestId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = `sgen_${suffix}`;
  await prisma.sceneGeneration.create({
    data: {
      id,
      videoProjectId: PROJECT,
      sourceStoryboardSceneId: STORYBOARD_SCENE,
      assetId: ASSET,
      sourceAnalysisRevision: 1,
      requestHash: `${"a".repeat(63)}${suffix.slice(-1)}`,
      providerName: "wavespeed",
      providerModelId: "wavespeed-ai/open-video/image-to-video",
      generationSceneRequestId: requestId,
      attemptOrdinal: 1,
      attemptKind: "PRIMARY",
      submissionCertainty: "PRE_SUBMISSION",
      orchestrationState: "QUEUED",
      ...overrides,
    },
  });
  return id;
}

async function priceAttempt(attemptId: string, suffix: string): Promise<void> {
  await pricingSnapshots!.create({
    id: `price_${suffix}`,
    sceneGenerationId: attemptId,
    snapshot: domainSnapshot(),
  });
}

describe.skipIf(!HAS_DB)("generation orchestration persistence", () => {
  beforeEach(async () => {
    await wipe();
    await seedProject();
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await wipe();
    await prisma.videoProject.deleteMany({ where: { id: PROJECT } });
    await prisma.mediaAsset.deleteMany({ where: { id: ASSET } });
    await prisma.property.deleteMany({ where: { id: PROP } });
    await prisma.$disconnect();
  });

  describe("the provider submission boundary", () => {
    it("refuses to arm an attempt that has no pricing snapshot", async () => {
      // A refusal, not an instruction to go and create one mid-flight. An
      // attempt whose cost was never decided must not reach a provider.
      const { request } = await seedChain("nosnap");
      const attemptId = await seedAttempt("nosnap", request.id);

      const outcome = await attempts!.armProviderBoundary({
        id: attemptId,
        expectedVersion: 0,
        context: ctx({ eventType: "ARM" }),
      });

      expect(outcome.kind).toBe("MISSING_PRICING_SNAPSHOT");
      const row = await prisma.sceneGeneration.findUnique({ where: { id: attemptId } });
      expect(row?.orchestrationState).toBe("QUEUED");
      expect(row?.submissionBoundaryEnteredAt).toBeNull();
      // And no event was written for a transition that did not happen.
      expect(await events!.listForAggregate("ATTEMPT", attemptId)).toEqual([]);
    });

    it("arms a priced attempt exactly once and records the boundary instant", async () => {
      const { request } = await seedChain("arm");
      const attemptId = await seedAttempt("arm", request.id);
      await priceAttempt(attemptId, "arm");

      const outcome = await attempts!.armProviderBoundary({
        id: attemptId,
        expectedVersion: 0,
        context: ctx({ eventType: "ARM_PROVIDER_BOUNDARY" }),
      });

      expect(outcome.kind).toBe("ARMED");
      if (outcome.kind !== "ARMED") throw new Error("expected ARMED");
      expect(outcome.attempt.orchestrationState).toBe("SUBMITTING");
      expect(outcome.attempt.stateVersion).toBe(1);
      expect(outcome.attempt.submissionBoundaryEnteredAt).not.toBeNull();

      const history = await events!.listForAggregate("ATTEMPT", attemptId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        fromState: "QUEUED",
        toState: "SUBMITTING",
        sequence: 1,
      });
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
      const { request } = await seedChain("race");
      const attemptId = await seedAttempt("race", request.id);
      await priceAttempt(attemptId, "race");

      const both = await Promise.all([
        attempts!.armProviderBoundary({
          id: attemptId,
          expectedVersion: 0,
          context: ctx({ eventType: "ARM", correlationId: "corr_worker_a" }),
        }),
        attempts!.armProviderBoundary({
          id: attemptId,
          expectedVersion: 0,
          context: ctx({ eventType: "ARM", correlationId: "corr_worker_b" }),
        }),
      ]);

      const armed = both.filter((o) => o.kind === "ARMED");
      const lost = both.filter((o) => o.kind === "LOST");
      expect(armed).toHaveLength(1);
      expect(lost).toHaveLength(1);

      // The loser's outcome carries no attempt at all, so there is nothing for
      // a careless caller to submit.
      expect(lost[0]).toEqual({ kind: "LOST" });

      // Exactly one transition event exists: the loser's transaction rolled
      // back entirely rather than leaving a claim it did not win.
      const history = await events!.listForAggregate("ATTEMPT", attemptId);
      expect(history).toHaveLength(1);

      const row = await prisma.sceneGeneration.findUnique({ where: { id: attemptId } });
      expect(row?.stateVersion).toBe(1);
    });

    it("refuses a stale version even when the state still matches", async () => {
      const { request } = await seedChain("stale");
      const attemptId = await seedAttempt("stale", request.id);
      await priceAttempt(attemptId, "stale");

      const wrongVersion = await attempts!.armProviderBoundary({
        id: attemptId,
        expectedVersion: 7,
        context: ctx(),
      });
      expect(wrongVersion.kind).toBe("LOST");
      // Removing the version predicate would make this pass as ARMED, which is
      // how a worker holding a stale read re-arms a boundary someone else moved.
      const row = await prisma.sceneGeneration.findUnique({ where: { id: attemptId } });
      expect(row?.orchestrationState).toBe("QUEUED");
    });

    it("cannot cross the same attempt over the boundary twice", async () => {
      const { request } = await seedChain("twice");
      const attemptId = await seedAttempt("twice", request.id);
      await priceAttempt(attemptId, "twice");

      const first = await attempts!.armProviderBoundary({
        id: attemptId,
        expectedVersion: 0,
        context: ctx(),
      });
      expect(first.kind).toBe("ARMED");

      // A second arming with the *correct* new version still fails, because the
      // state is no longer QUEUED. A retry is a new row, never this one.
      const second = await attempts!.armProviderBoundary({
        id: attemptId,
        expectedVersion: 1,
        context: ctx(),
      });
      expect(second.kind).toBe("LOST");
      expect(await events!.listForAggregate("ATTEMPT", attemptId)).toHaveLength(1);
    });

    it("requires a new attempt row for a recovery", async () => {
      const { request } = await seedChain("recov");
      const first = await seedAttempt("recov1", request.id);
      await priceAttempt(first, "recov1");
      await attempts!.armProviderBoundary({ id: first, expectedVersion: 0, context: ctx() });
      await attempts!.recordSubmissionOutcome({
        id: first,
        expectedVersion: 1,
        outcome: {
          certainty: "DEFINITIVELY_REJECTED",
          state: "FAILED_TERMINAL",
          providerPredictionId: null,
        },
        normalizedErrorCode: "PROVIDER_REJECTED",
        context: ctx(),
      });

      // The recovery is a second row under the same logical request, with its
      // own ordinal and its own pricing snapshot.
      const second = await seedAttempt("recov2", request.id, {
        attemptOrdinal: 2,
        attemptKind: "SYSTEM_RECOVERY",
      });
      await priceAttempt(second, "recov2");
      const armed = await attempts!.armProviderBoundary({
        id: second,
        expectedVersion: 0,
        context: ctx(),
      });
      expect(armed.kind).toBe("ARMED");

      const all = await attempts!.listByRequestId(request.id);
      expect(all.map((a) => [a.attemptOrdinal, a.attemptKind])).toEqual([
        [1, "PRIMARY"],
        [2, "SYSTEM_RECOVERY"],
      ]);
      // The customer made one request; the platform made two provider attempts.
      expect(all).toHaveLength(2);
    });

    it("refuses a duplicate attempt ordinal on one request", async () => {
      const { request } = await seedChain("dupord");
      await seedAttempt("dupord1", request.id);
      await expect(seedAttempt("dupord2", request.id)).rejects.toMatchObject({ code: "P2002" });
    });
  });

  describe("provider submission outcomes", () => {
    async function armed(suffix: string) {
      const { request } = await seedChain(suffix);
      const attemptId = await seedAttempt(suffix, request.id);
      await priceAttempt(attemptId, suffix);
      await attempts!.armProviderBoundary({ id: attemptId, expectedVersion: 0, context: ctx() });
      return attemptId;
    }

    it("records ACCEPTED with a real provider reference", async () => {
      const attemptId = await armed("acc");
      const accepted = new Date("2026-09-04T01:00:00.000Z");
      const outcome = await attempts!.recordSubmissionOutcome({
        id: attemptId,
        expectedVersion: 1,
        outcome: {
          certainty: "ACCEPTED",
          state: "PROCESSING",
          providerPredictionId: "pred_real_123",
          providerAcceptedAt: accepted,
        },
        normalizedErrorCode: null,
        context: ctx({ eventType: "PROVIDER_ACCEPTED" }),
      });

      expect(outcome.kind).toBe("APPLIED");
      if (outcome.kind !== "APPLIED") throw new Error("expected APPLIED");
      expect(outcome.value.submissionCertainty).toBe("ACCEPTED");
      expect(outcome.value.orchestrationState).toBe("PROCESSING");
      expect(outcome.value.providerPredictionId).toBe("pred_real_123");
      expect(outcome.value.providerAcceptedAt?.toISOString()).toBe(accepted.toISOString());
    });

    it("records DEFINITIVELY_REJECTED with no provider reference", async () => {
      const attemptId = await armed("rej");
      const outcome = await attempts!.recordSubmissionOutcome({
        id: attemptId,
        expectedVersion: 1,
        outcome: {
          certainty: "DEFINITIVELY_REJECTED",
          state: "FAILED_TERMINAL",
          providerPredictionId: null,
        },
        normalizedErrorCode: "PROVIDER_REJECTED_REQUEST",
        context: ctx(),
      });
      if (outcome.kind !== "APPLIED") throw new Error("expected APPLIED");
      expect(outcome.value.submissionCertainty).toBe("DEFINITIVELY_REJECTED");
      expect(outcome.value.orchestrationState).toBe("FAILED_TERMINAL");
      expect(outcome.value.providerPredictionId).toBeNull();
      expect(outcome.value.normalizedErrorCode).toBe("PROVIDER_REJECTED_REQUEST");
    });

    it("records SUBMISSION_UNKNOWN with a frozen reconciliation deadline", async () => {
      const attemptId = await armed("unk");
      const started = new Date("2026-09-04T02:00:00.000Z");
      const outcome = await attempts!.recordSubmissionOutcome({
        id: attemptId,
        expectedVersion: 1,
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
      expect(outcome.value.submissionCertainty).toBe("SUBMISSION_UNKNOWN");
      expect(outcome.value.orchestrationState).toBe("RECONCILIATION_PENDING");
      // No fabricated reference. The provider may hold one; we do not know it.
      expect(outcome.value.providerPredictionId).toBeNull();
      expect(outcome.value.reconciliationDeadlineAt?.toISOString()).toBe(
        "2026-09-05T02:00:00.000Z",
      );
    });

    /**
     * The database refuses what the application might not.
     *
     * A CHECK rather than a code path, because this invariant has to survive a
     * migration script, a console session and any future service that forgot
     * the domain layer exists.
     */
    it("rejects a provider reference without ACCEPTED certainty at the database", async () => {
      const { request } = await seedChain("fab");
      const attemptId = await seedAttempt("fab", request.id);
      await expect(
        prisma.sceneGeneration.update({
          where: { id: attemptId },
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

    it("rejects an uncertain attempt with no reconciliation deadline", async () => {
      const { request } = await seedChain("nodeadline");
      const attemptId = await seedAttempt("nodeadline", request.id);
      await expect(
        prisma.sceneGeneration.update({
          where: { id: attemptId },
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
      const { job } = await seedChain("atomic");
      const moved = await jobs!.transition({
        id: job.id,
        expectedState: "CREATED",
        expectedVersion: 0,
        nextState: "RESERVING",
        context: ctx({ eventType: "JOB_RESERVING" }),
      });
      expect(moved.kind).toBe("APPLIED");

      const history = await events!.listForAggregate("JOB", job.id);
      expect(history.map((e) => [e.sequence, e.fromState, e.toState])).toEqual([
        [1, null, "CREATED"],
        [2, "CREATED", "RESERVING"],
      ]);
    });

    it("writes no event when a transition is lost", async () => {
      const { job } = await seedChain("lost");
      const lost = await jobs!.transition({
        id: job.id,
        expectedState: "CREATED",
        expectedVersion: 99,
        nextState: "RESERVING",
        context: ctx(),
      });
      expect(lost.kind).toBe("LOST");
      // Only the creation event. A lost transition leaves no trace claiming it
      // happened.
      expect(await events!.listForAggregate("JOB", job.id)).toHaveLength(1);
    });

    it("rolls the state change back when the event cannot be written", async () => {
      const { job } = await seedChain("evtfail");

      // A caller that bypassed sanitization and handed over a prompt. The cast
      // is the point: it is exactly what a future service written in a hurry
      // would produce, and the repository must still refuse.
      const unsanitized = {
        ...ctx(),
        metadata: { requestCompiledPrompt: "a sunlit living room" },
      } as unknown as TransitionContext;

      await expect(
        jobs!.transition({
          id: job.id,
          expectedState: "CREATED",
          expectedVersion: 0,
          nextState: "RESERVING",
          context: unsanitized,
        }),
      ).rejects.toThrow(/forbidden keys/);

      // The state did not move, and nothing leaked. An event that could not be
      // recorded means the transition did not happen — the CAS had already
      // succeeded inside the transaction when the event insert threw, so this
      // passing proves the rollback rather than the ordering.
      const row = await prisma.generationJob.findUnique({ where: { id: job.id } });
      expect(row?.state).toBe("CREATED");
      expect(row?.stateVersion).toBe(0);
      expect(await events!.listForAggregate("JOB", job.id)).toHaveLength(1);
      const dumped = JSON.stringify(
        await prisma.generationTransitionEvent.findMany({ where: { aggregateId: job.id } }),
      );
      expect(dumped).not.toContain("sunlit");
    });

    it("increases the sequence monotonically per aggregate", async () => {
      const { job } = await seedChain("seq");
      let version = 0;
      for (const [from, to] of [
        ["CREATED", "RESERVING"],
        ["RESERVING", "RESERVED"],
        ["RESERVED", "GENERATING"],
      ] as const) {
        const moved = await jobs!.transition({
          id: job.id,
          expectedState: from,
          expectedVersion: version,
          nextState: to,
          context: ctx(),
        });
        if (moved.kind !== "APPLIED") throw new Error("expected APPLIED");
        version = moved.value.stateVersion;
      }
      const history = await events!.listForAggregate("JOB", job.id);
      expect(history.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    });

    it("offers no update or delete method for history", () => {
      // The append-only guarantee is worth exactly as much as the narrowest
      // method on the interface.
      const repo = events! as unknown as Record<string, unknown>;
      expect(repo.update).toBeUndefined();
      expect(repo.delete).toBeUndefined();
      expect(Object.keys(repo).sort()).toEqual(["listForAggregate", "listForCorrelation"]);
    });

    it("never stores a prompt in transition metadata", async () => {
      const { job, scene } = await seedChain("redact");
      // The scene really does hold a prompt; the event must not.
      expect(scene.snapshotCompiledPrompt).toContain("sunlit");

      await jobs!.transition({
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

      const rows = await prisma.generationTransitionEvent.findMany({
        where: { aggregateId: job.id },
      });
      const dumped = JSON.stringify(rows);
      expect(dumped).not.toContain("sunlit");
      expect(dumped).not.toContain("cinematic");
      expect(dumped).toContain("HIGH_QUALITY");
    });
  });

  describe("the entitlement hold", () => {
    it("permits only one reservation per job", async () => {
      const { job } = await seedChain("res1");
      const base = {
        generationJobId: job.id,
        billingCycleKey: "2026-09",
        billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
        billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
        reservedTotalVideoUnits: 2,
        reservedHighQualityUnits: 2,
      };
      await reservations!.create({ id: "genres_a", ...base }, ctx());
      await expect(
        reservations!.create({ id: "genres_b", ...base }, ctx()),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("keeps its billing cycle through every later transition", async () => {
      // Reserved in September, delivered in October: September is charged. The
      // cycle is frozen at reservation and never recomputed from completion.
      const { job } = await seedChain("cycle");
      const created = await reservations!.create(
        {
          id: "genres_cycle",
          generationJobId: job.id,
          billingCycleKey: "2026-09",
          billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
          billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
          reservedTotalVideoUnits: 2,
          reservedHighQualityUnits: 2,
        },
        ctx(),
      );

      let version = created.stateVersion;
      for (const [from, to] of [
        ["RESERVING", "RESERVED"],
        ["RESERVED", "RECONCILIATION_HOLD"],
        ["RECONCILIATION_HOLD", "RESERVED"],
        ["RESERVED", "CONSUMED"],
      ] as const) {
        const moved = await reservations!.transition({
          id: created.id,
          expectedState: from,
          expectedVersion: version,
          nextState: to,
          context: ctx(),
        });
        if (moved.kind !== "APPLIED") throw new Error(`expected APPLIED for ${from} -> ${to}`);
        version = moved.value.stateVersion;
        expect(moved.value.billingCycleKey).toBe("2026-09");
      }

      const final = await reservations!.findByJobId(job.id);
      expect(final?.state).toBe("CONSUMED");
      expect(final?.billingCycleKey).toBe("2026-09");
      expect(final?.consumedAt).not.toBeNull();
    });

    it("stores 2 total and 2 high-quality units for a 60-second HQ job", async () => {
      const { job } = await seedChain("hq");
      const created = await reservations!.create(
        {
          id: "genres_hq",
          generationJobId: job.id,
          billingCycleKey: "2026-09",
          billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
          billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
          reservedTotalVideoUnits: 2,
          reservedHighQualityUnits: 2,
        },
        ctx(),
      );
      expect(created.reservedTotalVideoUnits).toBe(2);
      expect(created.reservedHighQualityUnits).toBe(2);
    });

    it("refuses negative units and high-quality above total at the database", async () => {
      const { job } = await seedChain("negunits");
      const base = {
        id: "genres_neg",
        generationJobId: job.id,
        billingCycleKey: "2026-09",
        billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
        billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
      };
      await expect(
        prisma.generationReservation.create({
          data: { ...base, reservedTotalVideoUnits: -1, reservedHighQualityUnits: 0 },
        }),
      ).rejects.toThrow(/generation_reservations_units_check/);
      await expect(
        prisma.generationReservation.create({
          data: { ...base, reservedTotalVideoUnits: 2, reservedHighQualityUnits: 3 },
        }),
      ).rejects.toThrow(/generation_reservations_units_check/);
    });
  });

  describe("the regeneration entitlement, enforced by the database", () => {
    it("refuses an INITIAL request carrying an ordinal", async () => {
      const { scene } = await seedChain("initord");
      await expect(
        prisma.sceneGenerationRequest.create({
          data: {
            id: "genreq_bad_initial",
            generationSceneId: scene.id,
            kind: "INITIAL",
            userRegenerationOrdinal: 1,
          },
        }),
      ).rejects.toThrow(/scene_generation_requests_ordinal_check/);
    });

    it.each([[0], [3], [99]])("refuses a user regeneration with ordinal %i", async (ordinal) => {
      const { scene } = await seedChain(`ord${ordinal}`);
      await expect(
        prisma.sceneGenerationRequest.create({
          data: {
            id: `genreq_bad_${ordinal}`,
            generationSceneId: scene.id,
            kind: "USER_REGENERATION",
            userRegenerationOrdinal: ordinal,
          },
        }),
      ).rejects.toThrow(/scene_generation_requests_ordinal_check/);
    });

    /**
     * Delivery and failure are timestamped by the transition that reaches them.
     *
     * Added because a mutation removing the `deliveredAt` write survived: the
     * entitlement is derived from `state`, so nothing observable broke — and
     * the column that records *when* a customer's right was spent would have
     * been silently empty on every row. That is the fact a billing dispute is
     * settled with.
     */
    it("records when a request was delivered and when one failed", async () => {
      const { scene } = await seedChain("stamps");
      const delivered = await requests!.create(
        {
          id: "genreq_stamp_ok",
          generationSceneId: scene.id,
          kind: "USER_REGENERATION",
          userRegenerationOrdinal: 1,
          requestedByUserId: "usr_itest",
        },
        ctx(),
      );
      const generating = await requests!.transition({
        id: delivered.id,
        expectedState: "PENDING",
        expectedVersion: delivered.stateVersion,
        nextState: "GENERATING",
        context: ctx(),
      });
      if (generating.kind !== "APPLIED") throw new Error("expected APPLIED");
      expect(generating.value.deliveredAt).toBeNull();

      const done = await requests!.transition({
        id: delivered.id,
        expectedState: "GENERATING",
        expectedVersion: generating.value.stateVersion,
        nextState: "DELIVERED",
        context: ctx(),
      });
      if (done.kind !== "APPLIED") throw new Error("expected APPLIED");
      expect(done.value.deliveredAt).not.toBeNull();
      expect(done.value.failedAt).toBeNull();

      const failed = await requests!.create(
        {
          id: "genreq_stamp_fail",
          generationSceneId: scene.id,
          kind: "USER_REGENERATION",
          userRegenerationOrdinal: 2,
          requestedByUserId: "usr_itest",
        },
        ctx(),
      );
      const gone = await requests!.transition({
        id: failed.id,
        expectedState: "PENDING",
        expectedVersion: failed.stateVersion,
        nextState: "FAILED_TERMINAL",
        context: ctx(),
      });
      if (gone.kind !== "APPLIED") throw new Error("expected APPLIED");
      expect(gone.value.failedAt).not.toBeNull();
      expect(gone.value.deliveredAt).toBeNull();
    });

    it("stores at most two regenerations per scene", async () => {
      const { scene } = await seedChain("twoonly");
      for (const ordinal of [1, 2]) {
        await requests!.create(
          {
            id: `genreq_ok_${ordinal}`,
            generationSceneId: scene.id,
            kind: "USER_REGENERATION",
            userRegenerationOrdinal: ordinal,
            requestedByUserId: "usr_itest",
          },
          ctx(),
        );
      }
      // A third has no ordinal left that the constraint will accept.
      await expect(
        prisma.sceneGenerationRequest.create({
          data: {
            id: "genreq_third",
            generationSceneId: scene.id,
            kind: "USER_REGENERATION",
            userRegenerationOrdinal: 3,
          },
        }),
      ).rejects.toThrow(/scene_generation_requests_ordinal_check/);
      // And reusing ordinal 1 collides with the unique index.
      await expect(
        prisma.sceneGenerationRequest.create({
          data: {
            id: "genreq_reuse",
            generationSceneId: scene.id,
            kind: "USER_REGENERATION",
            userRegenerationOrdinal: 1,
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });
  });

  describe("pricing snapshots are persisted verbatim", () => {
    it("round-trips every field of the domain decision without precision loss", async () => {
      const { request } = await seedChain("price");
      const attemptId = await seedAttempt("price", request.id);
      const domain = domainSnapshot();
      const stored = await pricingSnapshots!.create({
        id: "price_rt",
        sceneGenerationId: attemptId,
        snapshot: domain,
      });

      expect(stored.pricingVersion).toBe(domain.pricingVersion);
      expect(stored.provider).toBe(domain.provider);
      expect(stored.contractKey).toBe(domain.contractKey);
      expect(stored.contractFingerprint).toBe(domain.contractFingerprint);
      expect(stored.riskProfileKey).toBe(domain.riskProfileKey);
      expect(stored.riskBufferBps).toBe(domain.riskBufferBps);
      expect(stored.requestedSeconds).toBe(domain.requestedSeconds);
      expect(stored.billableSeconds).toBe(domain.billableSeconds);
      // BIGINT round-trip: the integers come back exactly, not as floats.
      expect(stored.estimatedStableCostMicroUsd).toBe(
        BigInt(domain.estimatedStableCostMicroUsd),
      );
      expect(stored.estimatedPlanningCostMicroUsd).toBe(
        BigInt(domain.estimatedPlanningCostMicroUsd),
      );
      expect(stored.pricingEffectiveAtEpochMs).toBe(BigInt(domain.pricingEffectiveAt));
      expect(stored.fxSnapshotId).toBeNull();

      // The known figures, restated as literals: 5s x 80,000 micro-USD, +30%.
      expect(stored.estimatedStableCostMicroUsd).toBe(400_000n);
      expect(stored.estimatedPlanningCostMicroUsd).toBe(520_000n);
      expect(stored.riskBufferBps).toBe(3_000);
    });

    it("is one-to-one with its attempt", async () => {
      const { request } = await seedChain("onesnap");
      const attemptId = await seedAttempt("onesnap", request.id);
      await priceAttempt(attemptId, "onesnap");
      await expect(
        pricingSnapshots!.create({
          id: "price_second",
          sceneGenerationId: attemptId,
          snapshot: domainSnapshot(),
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("is not rewritten when the in-memory catalog would price differently", async () => {
      const { request } = await seedChain("frozen");
      const attemptId = await seedAttempt("frozen", request.id);
      await priceAttempt(attemptId, "frozen");

      // A later decision at a different risk profile produces different
      // numbers; the stored row must not move with it.
      const later = createPricingSnapshot({
        contract: catalog!.findByIdentity(H3_MAX_IDENTITY)!,
        riskProfileKey: "HIGH_QUALITY_AI",
        requestedSeconds: 5,
        pricingEffectiveAt: epochMillisFromDate(new Date("2027-01-01T00:00:00.000Z")),
      });
      if (!later.ok) throw new Error("expected a snapshot");
      expect(later.value.estimatedPlanningCostMicroUsd).toBe(600_000);

      const stored = await pricingSnapshots!.findByAttemptId(attemptId);
      expect(stored?.estimatedPlanningCostMicroUsd).toBe(520_000n);
      expect(stored?.riskProfileKey).toBe("NORMAL_AI");
      expect(stored?.riskBufferBps).toBe(costRiskProfile("NORMAL_AI").bufferBps);
    });

    it("keeps an FX rate immutable and undeletable while a snapshot names it", async () => {
      const { request } = await seedChain("fx");
      const attemptId = await seedAttempt("fx", request.id);
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
      await prisma.generationPricingSnapshot.create({
        data: {
          id: "price_fx",
          sceneGenerationId: attemptId,
          pricingVersion: "2026-09-02.1",
          provider: "fal",
          contractKey: "k",
          contractFingerprint: "f",
          identityJson: {},
          stablePriceReferenceJson: {},
          riskProfileKey: "NORMAL_AI",
          riskBufferBps: 3_000,
          requestedSeconds: 5,
          billableSeconds: 5,
          estimatedStableCostMicroUsd: 400_000n,
          estimatedPlanningCostMicroUsd: 520_000n,
          pricingEffectiveAtEpochMs: 0n,
          fxSnapshotId: "fx_2026_09",
        },
      });

      // RESTRICT: a rate that priced a paid attempt cannot be deleted out from
      // under it.
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
      const { job, scene, request } = await seedChain("del");
      const attemptId = await seedAttempt("del", request.id);
      await priceAttempt(attemptId, "del");

      // Every link in the chain is RESTRICT, so no ordinary deletion anywhere
      // above a paid attempt can reach it.
      await expect(
        prisma.videoProject.delete({ where: { id: PROJECT } }),
      ).rejects.toMatchObject({ code: "P2003" });
      await expect(
        prisma.generationJob.delete({ where: { id: job.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
      await expect(
        prisma.generationScene.delete({ where: { id: scene.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
      await expect(
        prisma.sceneGenerationRequest.delete({ where: { id: request.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
      await expect(
        prisma.sceneGeneration.delete({ where: { id: attemptId } }),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("survives storyboard recomposition and asset retention", async () => {
      // Provenance ids carry no foreign key on purpose: recomposition deletes
      // storyboard scenes and retention removes assets, and neither may erase
      // the record of a call that may have been paid for.
      const { scene } = await seedChain("prov");
      expect(scene.sourceStoryboardSceneId).toBe(STORYBOARD_SCENE);
      const orphan = await prisma.storyboardScene.findUnique({
        where: { id: STORYBOARD_SCENE },
      });
      expect(orphan).toBeNull();
      const reloaded = await scenes!.findById(scene.id);
      expect(reloaded?.sourceStoryboardSceneId).toBe(STORYBOARD_SCENE);
    });
  });
});
