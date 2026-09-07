import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPaidSubmissionAuthorizationService,
  createPricingSnapshot,
  createProviderPricingCatalog,
  epochMillisFromDate,
  yen,
  type BillingCycleRevenueReader,
  type FxSnapshot,
  type PricingSnapshot,
  type SceneRevenueReader,
  type Yen,
} from "@app/domain";
import { createPaidSubmissionAuthorizationRepository } from "@app/database";
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
 * The paid submission gate against live PostgreSQL.
 *
 * Everything here ends at `SUBMITTING`. No provider is constructed, no HTTP
 * client exists in the service's dependencies, and nothing consumes the
 * authorization it returns — which is the whole shape of this dormant phase.
 */

const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
/** A second pool, so a lock held on one connection genuinely blocks the other. */
const other = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
/** A third pool, used only to hold a lock while the other two contend for it. */
const blocker = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);

const AT = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));

/**
 * Planning cost in yen for the fixture's two scene lengths.
 *
 * OpenVideo bills $0.06/second; NORMAL_AI adds a 30% risk buffer; the fixture
 * FX rate is ¥150/USD. 5s → $0.39 → ¥58, and 20s → $1.56 → ¥234. Written out
 * because several tests need revenue tight enough to discriminate, and a
 * generous round number would make them pass against an implementation that
 * counted the wrong things.
 */
const FIVE_SECOND_YEN = 58;
const TWENTY_SECOND_YEN = 234;
const CYCLE = "2026-09";
const FX_ID = "fx_paidgate";

/** ¥150 per USD, as an exact integer fraction. */
const FX: FxSnapshot = {
  id: FX_ID,
  baseCurrency: "USD",
  quoteCurrency: "JPY",
  rateNumerator: 150,
  rateDenominator: 1,
  effectiveAt: epochMillisFromDate(new Date("2026-09-01T00:00:00.000Z")),
  sourceReference: "itest",
};

/** Revenue readers standing in for the billing layer that does not exist yet. */
function revenueReaders(cycleYen: Yen | null, sceneYen: Yen | null) {
  const billingCycleRevenue: BillingCycleRevenueReader = {
    async revenueYen() {
      return cycleYen;
    },
  };
  const sceneRevenue: SceneRevenueReader = {
    async revenueYen() {
      return sceneYen;
    },
  };
  return { billingCycleRevenue, sceneRevenue };
}

function service(
  client: PrismaClient,
  cycleYen: Yen | null = yen(49_800),
  sceneYen: Yen | null = yen(3_320),
) {
  return createPaidSubmissionAuthorizationService({
    authorization: createPaidSubmissionAuthorizationRepository(client),
    ...revenueReaders(cycleYen, sceneYen),
  });
}

/** The OpenVideo snapshot, priced in USD and convertible through `FX`. */
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

/**
 * A complete NORMAL-tier chain whose route is authorized.
 *
 * The shared orchestration fixture builds HIGH_QUALITY jobs, which have no
 * authorized route by design — so this seeds its own, on the WaveSpeed
 * OpenVideo route that does.
 */
async function seedAuthorizableChain(
  client: PrismaClient,
  suffix: string,
  options: {
    readonly organizationId?: string;
    readonly videoProjectId?: string;
    readonly seconds?: number;
    readonly reserve?: boolean;
  } = {},
) {
  const organizationId = options.organizationId ?? ORG_A;
  const videoProjectId = options.videoProjectId ?? PROJECT_A;
  const seconds = options.seconds ?? 5;
  const repos = repositories(client);

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
  if (created.kind !== "CREATED") throw new Error(`job not created: ${created.kind}`);

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
    if (reserved.kind !== "RESERVED") throw new Error(`expected RESERVED: ${reserved.kind}`);
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
      snapshotDurationSeconds: seconds,
      snapshotCameraMotion: "SLOW_PAN",
      // Distinct per chain: the request hash is derived from the scene's facts,
      // and two identical chains would collide on the active-request identity
      // index rather than exercising the gate.
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
      pricingSnapshot: snapshotFor(seconds),
      fxSnapshot: FX,
    },
    ctx(),
  );
  if (admitted.kind !== "ADMITTED") throw new Error(`attempt not admitted: ${admitted.kind}`);

  return { job: created.job, scene, request, attempt: admitted.attempt };
}

async function authorize(
  client: PrismaClient,
  attemptId: string,
  organizationId = ORG_A,
  cycleYen: Yen | null = yen(49_800),
  sceneYen: Yen | null = yen(3_320),
) {
  return service(client, cycleYen, sceneYen).authorize({
    organizationId,
    attemptId,
    authorizationInstant: AT,
    context: ctx({ eventType: "PAID_SUBMISSION_AUTHORIZED" }),
  });
}

/** Resolves when `promise` settles; never rejects. Used to prove blocking. */
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

describe.skipIf(!HAS_DB)("the paid submission authorization gate", () => {
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

  describe("the authorized path", () => {
    it("arms the boundary and reports the committed version", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "ok");
      const outcome = await authorize(prisma, attempt.id);
      if (outcome.kind !== "AUTHORIZED") {
        throw new Error(`expected AUTHORIZED, got ${JSON.stringify(outcome)}`);
      }
      expect(outcome.attemptId).toBe(attempt.id);
      // The version reported is the one the database committed, not one the
      // gate predicted.
      expect(outcome.armedStateVersion).toBe(attempt.stateVersion + 1);

      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("SUBMITTING");
      expect(row.submissionBoundaryEnteredAt).not.toBeNull();
      // And nothing past the boundary: this phase ends here.
      expect(row.providerPredictionId).toBeNull();
      expect(row.submissionCertainty).toBe("PRE_SUBMISSION");
    });

    it("writes the QUEUED → SUBMITTING transition event as the boundary record", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "evt");
      await authorize(prisma, attempt.id);
      const history = await repositories(prisma).events.listForAggregate(
        ORG_A,
        "ATTEMPT",
        attempt.id,
      );
      expect(history.map((e) => [e.fromState, e.toState])).toEqual([
        [null, "QUEUED"],
        ["QUEUED", "SUBMITTING"],
      ]);
      // The existing mechanism, not a second audit table.
      expect(history[1]?.eventType).toBe("PAID_SUBMISSION_AUTHORIZED");
    });

    it("does not consume the customer's reservation", async () => {
      // Consumption happens at DELIVERABLE_READY, in a much later phase. A gate
      // that spent units on authorization would charge for work that has not
      // even been submitted.
      const { attempt, job } = await seedAuthorizableChain(prisma, "noconsume");
      const before = await prisma.generationReservation.findFirstOrThrow({
        where: { generationJobId: job.id },
      });
      const outcome = await authorize(prisma, attempt.id);
      expect(outcome.kind).toBe("AUTHORIZED");

      const after = await prisma.generationReservation.findFirstOrThrow({
        where: { generationJobId: job.id },
      });
      expect(after.state).toBe("RESERVED");
      expect(after.consumedAt).toBeNull();
      expect(after.releasedAt).toBeNull();
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.reservedTotalVideoUnits).toBe(before.reservedTotalVideoUnits);
      expect(after.reservedHighQualityUnits).toBe(before.reservedHighQualityUnits);
    });
  });

  describe("refusals leave the attempt exactly as it was", () => {
    it("does not move an attempt the guard hard-pauses", async () => {
      // ¥49,800 revenue against a projected profit below the ¥15,000 floor.
      const { attempt } = await seedAuthorizableChain(prisma, "hp");
      const outcome = await authorize(prisma, attempt.id, ORG_A, yen(1_000), yen(3_320));
      expect(outcome.kind).toBe("SAFETY_GUARD_HARD_PAUSE");

      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("QUEUED");
      expect(row.submissionBoundaryEnteredAt).toBeNull();
      expect(row.stateVersion).toBe(attempt.stateVersion);
    });

    it("writes no transition history for a state change that did not happen", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "nohist");
      await authorize(prisma, attempt.id, ORG_A, yen(1_000), yen(3_320));
      const history = await repositories(prisma).events.listForAggregate(
        ORG_A,
        "ATTEMPT",
        attempt.id,
      );
      // Only the admission event. A refusal discovered nothing about the
      // provider, so claiming an execution-state transition would be fiction.
      expect(history.map((e) => e.toState)).toEqual(["QUEUED"]);
    });

    it("refuses without an authoritative billing-cycle revenue", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "norev");
      const outcome = await authorize(prisma, attempt.id, ORG_A, null, yen(3_320));
      expect(outcome).toMatchObject({
        kind: "SAFETY_GUARD_HARD_PAUSE",
        reason: "BILLING_CYCLE_REVENUE_UNAVAILABLE",
      });
      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("QUEUED");
    });

    it("refuses an attempt whose job has no reservation", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "nores", { reserve: false });
      const outcome = await authorize(prisma, attempt.id);
      expect(outcome).toMatchObject({
        kind: "RESERVATION_INVALID",
        reason: "RESERVATION_MISSING",
      });
    });

    it.each([["RELEASED"], ["CONSUMED"], ["RECONCILIATION_HOLD"]] as const)(
      "refuses against a %s reservation",
      async (state) => {
        const { attempt, job } = await seedAuthorizableChain(prisma, `res${state}`);
        await prisma.generationReservation.updateMany({
          where: { generationJobId: job.id },
          data: { state },
        });
        const outcome = await authorize(prisma, attempt.id);
        expect(outcome.kind).toBe("RESERVATION_INVALID");
        const row = await prisma.sceneGeneration.findUniqueOrThrow({
          where: { id: attempt.id },
        });
        expect(row.orchestrationState).toBe("QUEUED");
      },
    );

    it("refuses an attempt whose submission is unknown, and never re-arms it", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "unknown");
      await prisma.sceneGeneration.update({
        where: { id: attempt.id },
        data: {
          orchestrationState: "RECONCILIATION_PENDING",
          submissionCertainty: "SUBMISSION_UNKNOWN",
          submissionBoundaryEnteredAt: new Date(),
          reconciliationStartedAt: new Date(),
          reconciliationDeadlineAt: new Date("2026-09-11T00:00:00.000Z"),
        },
      });
      const outcome = await authorize(prisma, attempt.id);
      expect(outcome).toMatchObject({
        kind: "ATTEMPT_NOT_ARMABLE",
        reason: "ATTEMPT_SUBMISSION_UNCERTAIN",
      });
      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      // Not reset to QUEUED, not re-armed, not touched.
      expect(row.orchestrationState).toBe("RECONCILIATION_PENDING");
      expect(row.submissionCertainty).toBe("SUBMISSION_UNKNOWN");
    });

    it("refuses a stale SUBMITTING rather than retrying it", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "stale");
      await prisma.sceneGeneration.update({
        where: { id: attempt.id },
        data: {
          orchestrationState: "SUBMITTING",
          submissionBoundaryEnteredAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      });
      const outcome = await authorize(prisma, attempt.id);
      expect(outcome).toMatchObject({
        kind: "ATTEMPT_NOT_ARMABLE",
        reason: "ATTEMPT_ALREADY_SUBMITTED",
      });
    });
  });

  describe("persisted pricing corruption", () => {
    it("refuses when the snapshot's risk profile no longer matches the job's tier", async () => {
      // Admission bound these together and the provider boundary re-checks them;
      // this is the row being corrupted in between. A HIGH_QUALITY_AI buffer on
      // a NORMAL job over-plans by twenty points, and the reverse under-plans —
      // either way the cost decision no longer describes this attempt.
      const { attempt } = await seedAuthorizableChain(prisma, "riskprof");
      await prisma.generationPricingSnapshot.updateMany({
        where: { sceneGenerationId: attempt.id },
        data: { riskProfileKey: "HIGH_QUALITY_AI" },
      });
      const outcome = await authorize(prisma, attempt.id);
      expect(outcome).toMatchObject({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_SNAPSHOT_BINDING_INVALID",
      });
      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("QUEUED");
    });

    it("refuses when the snapshot names a different provider", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "provmis");
      await prisma.generationPricingSnapshot.updateMany({
        where: { sceneGenerationId: attempt.id },
        data: { provider: "fal" },
      });
      const outcome = await authorize(prisma, attempt.id);
      expect(outcome).toMatchObject({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_SNAPSHOT_BINDING_INVALID",
      });
    });
  });

  describe("tenant isolation", () => {
    it("answers a cross-tenant attempt exactly as it answers a missing one", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "tenant");
      const crossTenant = await authorize(prisma, attempt.id, ORG_B);
      const missing = await authorize(prisma, "sgen_does_not_exist", ORG_B);
      expect(crossTenant).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
      expect(crossTenant).toEqual(missing);

      // And it did not move.
      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("QUEUED");
    });

    it("never counts another tenant's exposure", async () => {
      // Organization B carries in-flight exposure that would hard-pause
      // organization A *if it were counted*. The revenue is deliberately tight:
      // with a generous cycle this test would pass against an implementation
      // that aggregated every tenant into one number, and prove nothing.
      const b = await seedAuthorizableChain(prisma, "expB", {
        organizationId: ORG_B,
        videoProjectId: PROJECT_B,
        seconds: 20,
      });
      await prisma.sceneGeneration.update({
        where: { id: b.attempt.id },
        data: { orchestrationState: "PROCESSING", submissionBoundaryEnteredAt: new Date() },
      });

      const a = await seedAuthorizableChain(prisma, "expA");
      // A's own 5s attempt is ¥58; B's 20s attempt is ¥234. Revenue leaves
      // ¥117 of headroom above the ¥15,000 floor after A's own cost — enough
      // for A alone, and not enough if B's exposure were included.
      const revenue = yen(15_000 + FIVE_SECOND_YEN + Math.floor(TWENTY_SECOND_YEN / 2));
      const outcome = await authorize(prisma, a.attempt.id, ORG_A, revenue);
      expect(outcome.kind).toBe("AUTHORIZED");
    });
  });

  describe("exposure aggregation", () => {
    it("counts an uncertain sibling's planning cost against the guard", async () => {
      // A ¥1,000,000 cycle would comfortably absorb one attempt. A sibling in
      // RECONCILIATION_PENDING at a 20-second planning cost must still count:
      // it may already have been billed.
      const sibling = await seedAuthorizableChain(prisma, "uncsib", { seconds: 20 });
      await prisma.sceneGeneration.update({
        where: { id: sibling.attempt.id },
        data: {
          orchestrationState: "RECONCILIATION_PENDING",
          submissionCertainty: "SUBMISSION_UNKNOWN",
          submissionBoundaryEnteredAt: new Date(),
          reconciliationStartedAt: new Date(),
          reconciliationDeadlineAt: new Date("2026-09-11T00:00:00.000Z"),
        },
      });

      const candidate = await seedAuthorizableChain(prisma, "unccand");
      // Revenue chosen so the candidate alone passes and the pair does not.
      const siblingCost = 20 * 60_000 * 1.3; // micro-USD, +30% NORMAL_AI buffer
      const siblingYen = Math.floor((siblingCost / 1_000_000) * 150);
      const revenue = yen(15_000 + siblingYen - 100);

      const withSibling = await authorize(prisma, candidate.attempt.id, ORG_A, revenue);
      expect(withSibling.kind).toBe("SAFETY_GUARD_HARD_PAUSE");

      // Resolve the sibling; the same candidate now fits.
      await prisma.sceneGeneration.update({
        where: { id: sibling.attempt.id },
        data: { orchestrationState: "FAILED_TERMINAL", submissionCertainty: "DEFINITIVELY_REJECTED" },
      });
      const without = await authorize(prisma, candidate.attempt.id, ORG_A, revenue);
      expect(without.kind).toBe("AUTHORIZED");
    });

    it("does not count a sibling from another billing cycle", async () => {
      const sibling = await seedAuthorizableChain(prisma, "cyclesib", { seconds: 20 });
      await prisma.generationReservation.updateMany({
        where: { generationJobId: sibling.job.id },
        data: { billingCycleKey: "2026-08" },
      });
      await prisma.sceneGeneration.update({
        where: { id: sibling.attempt.id },
        data: { orchestrationState: "PROCESSING", submissionBoundaryEnteredAt: new Date() },
      });

      const candidate = await seedAuthorizableChain(prisma, "cyclecand");
      // Tight for the same reason as the cross-tenant case: with a generous
      // cycle the sibling's ¥234 would disappear into the headroom and the test
      // would pass whether or not the cycle scope existed.
      const revenue = yen(15_000 + FIVE_SECOND_YEN + Math.floor(TWENTY_SECOND_YEN / 2));
      const outcome = await authorize(prisma, candidate.attempt.id, ORG_A, revenue);
      // Last month's exposure must not block this month's work.
      expect(outcome.kind).toBe("AUTHORIZED");
    });
  });

  describe("concurrency", () => {
    it("lets exactly one of two workers arm the same attempt", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "casrace");
      const results = await Promise.allSettled([
        authorize(prisma, attempt.id),
        authorize(other, attempt.id),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      const kinds = results.map((r) => (r.status === "fulfilled" ? r.value.kind : "REJECTED"));
      expect(kinds.filter((k) => k === "AUTHORIZED")).toHaveLength(1);
      // The loser is refused; it is never handed permission to POST.
      expect(kinds.filter((k) => k === "AUTHORIZED").length).toBe(1);

      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("SUBMITTING");
      expect(row.stateVersion).toBe(attempt.stateVersion + 1);
    });

    it("blocks a second authorization while the first holds the cost lock", async () => {
      // The discriminator for the serialization point. Without the
      // organization+cycle lock, both authorizations would read the same
      // exposure and both would decide it was affordable.
      const first = await seedAuthorizableChain(prisma, "lockA");
      const second = await seedAuthorizableChain(prisma, "lockB");

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = other.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT pg_advisory_xact_lock(
              hashtext(${`paid-submission:${ORG_A}`}),
              hashtext(${`cycle:${CYCLE}`})
            )::text AS locked
          `;
          await held;
        },
        { timeout: 20_000 },
      );

      await breathe(4);
      const blocked = settled(authorize(prisma, first.attempt.id));
      await breathe();
      expect(blocked.done()).toBe(false);

      release();
      await holder;
      expect((await blocked.value).kind).toBe("AUTHORIZED");

      // And the lock is released at commit, so the next one proceeds.
      expect((await authorize(prisma, second.attempt.id)).kind).toBe("AUTHORIZED");
    });

    it("cannot authorize two attempts that jointly cross the hard pause", async () => {
      // Each candidate alone leaves the cycle above the ¥15,000 floor; together
      // they do not. Two authorizations that both read the pre-commit exposure
      // would both say yes, which is exactly what the serialized cost-admission
      // decision exists to prevent.
      //
      // The overlap is *constructed* rather than hoped for. Measured directly,
      // two in-process authorizations complete one after another even on
      // separate pools — so a plain race passes against an implementation with
      // no lock at all and proves nothing. Instead a third connection takes the
      // same cost lock and holds it, both authorizations are started and
      // provably block on it, and only then is it released: they are then
      // genuinely contending, and the lock is what orders them.
      const a = await seedAuthorizableChain(prisma, "jointA", { seconds: 20 });
      const b = await seedAuthorizableChain(other, "jointB", { seconds: 20 });

      const oneCostYen = TWENTY_SECOND_YEN;
      // Room for one candidate and not for two.
      const revenue = yen(15_000 + oneCostYen + Math.floor(oneCostYen / 2));

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = blocker.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT pg_advisory_xact_lock(
              hashtext(${`paid-submission:${ORG_A}`}),
              hashtext(${`cycle:${CYCLE}`})
            )::text AS locked
          `;
          await held;
        },
        { timeout: 30_000 },
      );

      await breathe(4);
      const first = settled(authorize(prisma, a.attempt.id, ORG_A, revenue));
      const second = settled(authorize(other, b.attempt.id, ORG_A, revenue));

      // Both are waiting on the same cost lock, so neither has decided yet.
      await breathe();
      expect(first.done()).toBe(false);
      expect(second.done()).toBe(false);

      release();
      await holder;

      const results = await Promise.all([first.value, second.value]);
      const kinds = results.map((r) => r.kind);

      // Exactly one, not "at most one": the second must see the first's
      // committed exposure and refuse on the guard rather than by accident.
      expect(kinds.filter((k) => k === "AUTHORIZED")).toHaveLength(1);
      expect(kinds.filter((k) => k === "SAFETY_GUARD_HARD_PAUSE")).toHaveLength(1);

      const armed = await prisma.sceneGeneration.count({
        where: {
          id: { in: [a.attempt.id, b.attempt.id] },
          orchestrationState: "SUBMITTING",
        },
      });
      expect(armed).toBe(1);
    });
  });
});
