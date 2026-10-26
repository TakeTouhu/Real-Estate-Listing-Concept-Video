import { createAttemptFailureSettlementRepository } from "@app/database";
import {
  AttemptFailureSettlementRunner,
  epochMillis,
  type AttemptFailureSettlementOutcome,
} from "@app/domain";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  addAttempts,
  addSiblingScene,
  eventsOf,
  OUTPUTLESS_ENDS,
  seedAttemptFailure,
  type AttemptFailureChain,
} from "./attempt-failure-fixture";
import {
  attemptInput,
  ctx,
  dropTenants,
  HAS_DB,
  ORG_A,
  ORG_B,
  repositories,
  seedPriorDeliverable,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * ADR-0083 against live PostgreSQL: a scene request whose attempts ended without
 * a video settles its job, and an initial generation's Unit comes back.
 *
 * Every attempt is admitted through the real admission primitive and only its
 * end is written by hand (`attempt-failure-fixture.ts`). Nothing here calls a
 * provider.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const settlement = createAttemptFailureSettlementRepository(prisma);
const repos = repositories(prisma);

const NOW = Date.UTC(2026, 8, 26, 9, 0, 0);

function settle(chain: AttemptFailureChain, organizationId = chain.organizationId) {
  return settlement.settleAttemptFailure({
    organizationId,
    generationSceneRequestId: chain.requestId,
    settledAt: NOW,
    context: ctx({ correlationId: `corr_${chain.tag}`, actorType: "WORKER" }),
  });
}

async function candidateIds(limit = 100): Promise<string[]> {
  return (await settlement.findAttemptFailureCandidates({ limit })).map(
    (c) => c.generationSceneRequestId,
  );
}

/** Every row a settlement could touch, for "nothing was written". */
async function snapshot(chain: AttemptFailureChain) {
  return {
    request: await prisma.sceneGenerationRequest.findUniqueOrThrow({ where: { id: chain.requestId } }),
    scene: await prisma.generationScene.findUniqueOrThrow({ where: { id: chain.sceneId } }),
    job: await prisma.generationJob.findUniqueOrThrow({ where: { id: chain.jobId } }),
    reservation:
      chain.reservationId === null
        ? null
        : await prisma.generationReservation.findUniqueOrThrow({ where: { id: chain.reservationId } }),
    attempts: await prisma.sceneGeneration.findMany({
      where: { generationSceneRequestId: chain.requestId },
      orderBy: { attemptOrdinal: "asc" },
    }),
    events: await prisma.generationTransitionEvent.count(),
  };
}

/** Refused, never offered, and nothing written. */
async function expectRefused(chain: AttemptFailureChain, reason: string): Promise<void> {
  const before = await snapshot(chain);
  expect(await candidateIds()).toEqual([]);
  expect(await settle(chain)).toEqual({ kind: "NOT_SETTLEABLE", reason });
  expect(await snapshot(chain)).toEqual(before);
}

function lastEvent(events: Awaited<ReturnType<typeof eventsOf>>) {
  const last = events.at(-1);
  return [
    last?.fromState,
    last?.toState,
    last?.eventType,
    last?.reasonCode,
    last?.organizationId,
    last?.correlationId,
    last?.actorType,
  ];
}

/**
 * How many backends are waiting on the lock a settlement takes first: the
 * cost-admission advisory lock, or a reservation row's.
 */
async function blockedBackends(on: "reservation" | "advisory"): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ wait_event: string | null; query: string }[]>(
    `SELECT wait_event, query FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'`,
  );
  return rows.filter((r) =>
    on === "advisory"
      ? r.wait_event === "advisory"
      : r.wait_event !== "advisory" && r.query.includes("FOR UPDATE OF res"),
  ).length;
}

async function waitForBlocked(count: number, on: "reservation" | "advisory"): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if ((await blockedBackends(on)) >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

RUN("ADR-0083 — a scene whose attempts ended without a video settles its job", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  describe("an initial generation", () => {
    it.each(OUTPUTLESS_ENDS.map((end) => [end]))(
      "fails and releases its Unit when the attempt ended %s",
      async (end) => {
        const chain = await seedAttemptFailure(prisma, { attempts: [end] });
        const before = await snapshot(chain);

        expect(await settle(chain)).toEqual({
          kind: "SETTLED",
          settlement: "INITIAL_FAILED",
          unitReleased: true,
        });

        const after = await snapshot(chain);
        const at = new Date(NOW);
        expect([
          after.request.state,
          after.request.stateVersion,
          after.request.failedAt,
          after.request.deliveredAt,
        ]).toEqual(["FAILED_TERMINAL", before.request.stateVersion + 1, at, null]);
        expect([after.scene.state, after.scene.stateVersion, after.scene.currentDeliveredRequestId]).toEqual([
          "FAILED_TERMINAL",
          before.scene.stateVersion + 1,
          null,
        ]);
        expect([after.job.state, after.job.stateVersion, after.job.currentDeliverableVersionId]).toEqual([
          "FAILED_TERMINAL",
          before.job.stateVersion + 1,
          null,
        ]);
        expect([
          after.reservation?.state,
          after.reservation?.stateVersion,
          after.reservation?.releasedAt,
          after.reservation?.consumedAt,
        ]).toEqual(["RELEASED", (before.reservation?.stateVersion ?? -1) + 1, at, null]);
        // The attempts are evidence, and evidence is not rewritten.
        expect(after.attempts).toEqual(before.attempts);
        expect(after.events).toBe(before.events + 4);

        expect(lastEvent(await eventsOf(prisma, chain.requestId))).toEqual([
          "GENERATING",
          "FAILED_TERMINAL",
          "scene_request.failed",
          "ATTEMPT_FAILURE_SETTLEMENT",
          ORG_A,
          `corr_${chain.tag}`,
          "WORKER",
        ]);
        expect(lastEvent(await eventsOf(prisma, chain.sceneId))).toEqual([
          "GENERATING",
          "FAILED_TERMINAL",
          "scene.failed",
          "ATTEMPT_FAILURE_SETTLEMENT",
          ORG_A,
          `corr_${chain.tag}`,
          "WORKER",
        ]);
        expect(lastEvent(await eventsOf(prisma, chain.jobId))).toEqual([
          "GENERATING",
          "FAILED_TERMINAL",
          "job.scene_failed",
          "ATTEMPT_FAILURE_SETTLEMENT",
          ORG_A,
          `corr_${chain.tag}`,
          "WORKER",
        ]);
        expect(lastEvent(await eventsOf(prisma, chain.reservationId ?? ""))).toEqual([
          "RESERVED",
          "RELEASED",
          "reservation.released",
          "ATTEMPT_FAILURE_SETTLEMENT",
          ORG_A,
          `corr_${chain.tag}`,
          "WORKER",
        ]);
      },
    );

    it("releases a Unit held for reconciliation", async () => {
      const chain = await seedAttemptFailure(prisma, {
        attempts: ["EXHAUSTED"],
        reservationState: "RECONCILIATION_HOLD",
      });

      expect(await settle(chain)).toEqual({
        kind: "SETTLED",
        settlement: "INITIAL_FAILED",
        unitReleased: true,
      });

      const after = await snapshot(chain);
      expect([after.reservation?.state, after.reservation?.releasedAt]).toEqual([
        "RELEASED",
        new Date(NOW),
      ]);
      expect(lastEvent(await eventsOf(prisma, chain.reservationId ?? "")).slice(0, 3)).toEqual([
        "RECONCILIATION_HOLD",
        "RELEASED",
        "reservation.released",
      ]);
      expect(after.job.state).toBe("FAILED_TERMINAL");
    });

    it("fails the job and leaves alone a Unit reconciliation already released", async () => {
      const chain = await seedAttemptFailure(prisma, {
        attempts: ["EXHAUSTED"],
        reservationState: "RELEASED",
      });
      const before = await snapshot(chain);
      const reservationEvents = (await eventsOf(prisma, chain.reservationId ?? "")).length;

      expect(await settle(chain)).toEqual({
        kind: "SETTLED",
        settlement: "INITIAL_FAILED",
        unitReleased: false,
      });

      const after = await snapshot(chain);
      expect(after.reservation).toEqual(before.reservation);
      expect((await eventsOf(prisma, chain.reservationId ?? "")).length).toBe(reservationEvents);
      expect([after.request.state, after.scene.state, after.job.state]).toEqual([
        "FAILED_TERMINAL",
        "FAILED_TERMINAL",
        "FAILED_TERMINAL",
      ]);
      expect(after.events).toBe(before.events + 3);
    });

    it("settles a failed recovery after an earlier attempt produced a video", async () => {
      const chain = await seedAttemptFailure(prisma, { attempts: ["OUTPUT_VERIFIED", "REJECTED"] });

      expect(await settle(chain)).toEqual({
        kind: "SETTLED",
        settlement: "INITIAL_FAILED",
        unitReleased: true,
      });
      expect((await snapshot(chain)).reservation?.state).toBe("RELEASED");
    });

    it("answers a replay as settled, writing nothing, and is no longer a candidate", async () => {
      const chain = await seedAttemptFailure(prisma);
      expect(await candidateIds()).toEqual([chain.requestId]);
      await settle(chain);
      const before = await snapshot(chain);

      expect(await settle(chain)).toEqual({ kind: "NOT_SETTLEABLE", reason: "REQUEST_NOT_GENERATING" });
      expect(await snapshot(chain)).toEqual(before);
      expect(await candidateIds()).toEqual([]);
    });

    it("leaves a failed request that admits no further attempt", async () => {
      const chain = await seedAttemptFailure(prisma);
      await settle(chain);

      expect(
        await repos.attempts.admit(
          ORG_A,
          attemptInput({ id: `sgen_${chain.tag}_late`, generationSceneRequestId: chain.requestId }),
          ctx(),
        ),
      ).toEqual({ kind: "REQUEST_NOT_ADMITTING" });
    });

    it("refuses a later scene of a job that has already failed, writing nothing", async () => {
      const chain = await seedAttemptFailure(prisma);
      const sibling = await addSiblingScene(prisma, chain, 1, "GENERATING");
      await addAttempts(prisma, ORG_A, sibling.requestId, `${chain.tag}_s`, ["REJECTED"]);
      expect(await candidateIds()).toEqual([chain.requestId, sibling.requestId]);

      expect((await settle(chain)).kind).toBe("SETTLED");

      const siblingChain = { ...chain, sceneId: sibling.sceneId, requestId: sibling.requestId };
      const before = await snapshot(siblingChain);
      expect(await candidateIds()).toEqual([]);
      expect(await settle(siblingChain)).toEqual({
        kind: "NOT_SETTLEABLE",
        reason: "JOB_NOT_GENERATING",
      });
      expect(await snapshot(siblingChain)).toEqual(before);
      // The Unit was released once, by the first scene's settlement.
      expect((await eventsOf(prisma, chain.reservationId ?? "")).filter((e) => e.toState === "RELEASED")).toHaveLength(1);
    });
  });

  describe("a scene regeneration", () => {
    it.each(OUTPUTLESS_ENDS.map((end) => [end]))(
      "rolls back to the customer's video when the attempt ended %s, its Unit untouched",
      async (end) => {
        const chain = await seedAttemptFailure(prisma, {
          requestKind: "USER_REGENERATION",
          attempts: [end],
        });
        const before = await snapshot(chain);
        const predecessor = await prisma.sceneGenerationRequest.findUniqueOrThrow({
          where: { id: chain.predecessorRequestId ?? "" },
        });

        expect(await settle(chain)).toEqual({
          kind: "SETTLED",
          settlement: "REGENERATION_ROLLED_BACK",
          unitReleased: false,
        });

        const after = await snapshot(chain);
        expect([
          after.request.state,
          after.request.stateVersion,
          after.request.failedAt,
          after.request.deliveredAt,
        ]).toEqual(["FAILED_TERMINAL", before.request.stateVersion + 1, new Date(NOW), null]);
        expect([after.scene.state, after.scene.stateVersion, after.scene.currentDeliveredRequestId]).toEqual([
          "READY",
          before.scene.stateVersion + 1,
          chain.predecessorRequestId,
        ]);
        expect([after.job.state, after.job.stateVersion, after.job.currentDeliverableVersionId]).toEqual([
          "DELIVERABLE_READY",
          before.job.stateVersion + 1,
          before.job.currentDeliverableVersionId,
        ]);
        expect(after.reservation).toEqual(before.reservation);
        expect(after.attempts).toEqual(before.attempts);
        expect(
          await prisma.sceneGenerationRequest.findUniqueOrThrow({
            where: { id: chain.predecessorRequestId ?? "" },
          }),
        ).toEqual(predecessor);
        expect(after.events).toBe(before.events + 3);
        expect(lastEvent(await eventsOf(prisma, chain.sceneId)).slice(0, 4)).toEqual([
          "REVISING",
          "READY",
          "scene.revision_rolled_back",
          "ATTEMPT_FAILURE_SETTLEMENT",
        ]);
        expect(lastEvent(await eventsOf(prisma, chain.jobId)).slice(0, 4)).toEqual([
          "GENERATING",
          "DELIVERABLE_READY",
          "job.revision_rolled_back",
          "ATTEMPT_FAILURE_SETTLEMENT",
        ]);
      },
    );

    it("rolls back beside another scene that is ready", async () => {
      const chain = await seedAttemptFailure(prisma, { requestKind: "USER_REGENERATION" });
      await addSiblingScene(prisma, chain, 1, "READY");

      expect(await candidateIds()).toEqual([chain.requestId]);
      expect((await settle(chain)).kind).toBe("SETTLED");
    });

    it("refuses while another scene is not ready, writing nothing", async () => {
      const chain = await seedAttemptFailure(prisma, { requestKind: "USER_REGENERATION" });
      await addSiblingScene(prisma, chain, 1, "PENDING");
      const before = await snapshot(chain);

      expect(await candidateIds()).toEqual([]);
      expect(await settle(chain)).toEqual({ kind: "NOT_SETTLEABLE", reason: "SHAPE_CONFLICT" });
      expect(await snapshot(chain)).toEqual(before);
    });

    it("refuses while another regeneration is open, writing nothing", async () => {
      const chain = await seedAttemptFailure(prisma, { requestKind: "USER_REGENERATION" });
      const sibling = await addSiblingScene(prisma, chain, 1, "READY");
      // A shape revision start never leaves (one revision at a time), held here
      // to prove the settlement refuses it rather than choose a video.
      await prisma.sceneGenerationRequest.create({
        data: {
          id: `genreq_regen_${chain.tag}_1`,
          generationSceneId: sibling.sceneId,
          kind: "USER_REGENERATION",
          userRegenerationOrdinal: 1,
          state: "PENDING",
          requestedByUserId: "usr_itest",
        },
      });
      const before = await snapshot(chain);

      expect(await candidateIds()).toEqual([]);
      expect(await settle(chain)).toEqual({ kind: "NOT_SETTLEABLE", reason: "SHAPE_CONFLICT" });
      expect(await snapshot(chain)).toEqual(before);
    });

    it("refuses one whose scene is not revising", async () => {
      const chain = await seedAttemptFailure(prisma, { requestKind: "USER_REGENERATION" });
      await prisma.generationScene.update({ where: { id: chain.sceneId }, data: { state: "READY" } });
      await expectRefused(chain, "SHAPE_CONFLICT");
    });

    it("refuses one whose job holds no video", async () => {
      const chain = await seedAttemptFailure(prisma, { requestKind: "USER_REGENERATION" });
      await prisma.generationJob.update({
        where: { id: chain.jobId },
        data: { currentDeliverableVersionId: null },
      });
      await expectRefused(chain, "SHAPE_CONFLICT");
    });

    it("refuses one whose scene names a rendition that was never delivered", async () => {
      const chain = await seedAttemptFailure(prisma, { requestKind: "USER_REGENERATION" });
      await prisma.sceneGenerationRequest.update({
        where: { id: chain.predecessorRequestId ?? "" },
        data: { state: "FAILED_TERMINAL", deliveredAt: null, failedAt: new Date("2026-08-01T00:00:00.000Z") },
      });
      await expectRefused(chain, "SHAPE_CONFLICT");
    });

    it("refuses one whose Unit is not consumed, writing nothing", async () => {
      const chain = await seedAttemptFailure(prisma, {
        requestKind: "USER_REGENERATION",
        reservationState: "RESERVED",
      });
      const before = await snapshot(chain);

      expect(await candidateIds()).toEqual([]);
      expect(await settle(chain)).toEqual({
        kind: "NOT_SETTLEABLE",
        reason: "RESERVATION_NOT_SETTLEABLE",
      });
      expect(await snapshot(chain)).toEqual(before);
    });
  });

  describe("what is not settled, and never offered", () => {
    it.each([
      ["an attempt still generating", ["PROCESSING"], "ATTEMPT_NOT_FAILED"],
      ["an attempt not yet sent", ["QUEUED"], "ATTEMPT_NOT_FAILED"],
      ["a newest attempt that produced a video", ["REJECTED", "OUTPUT_VERIFIED"], "ATTEMPT_NOT_FAILED"],
      ["no attempt at all", [], "REQUEST_NOT_GENERATING"],
    ] as const)("a request with %s", async (_label, attempts, reason) => {
      const chain = await seedAttemptFailure(prisma, { attempts });
      const before = await snapshot(chain);

      expect(await candidateIds()).toEqual([]);
      expect(await settle(chain)).toEqual({ kind: "NOT_SETTLEABLE", reason });
      expect(await snapshot(chain)).toEqual(before);
    });

    it("a request whose older attempt is still open beside a newer failed one", async () => {
      // A shape admission never builds (one active attempt per request), held
      // here by hand: the settlement must ask about every attempt, not only the
      // newest.
      const chain = await seedAttemptFailure(prisma, { attempts: ["REJECTED", "REJECTED"] });
      await prisma.sceneGeneration.update({
        where: { id: chain.attemptIds[0] ?? "" },
        data: {
          orchestrationState: "PROCESSING",
          submissionCertainty: "ACCEPTED",
          providerPredictionId: `pred_${chain.tag}_open`,
          providerAcceptedAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      });
      await expectRefused(chain, "ATTEMPT_NOT_FAILED");
    });

    it("an initial request whose scene is not generating", async () => {
      const chain = await seedAttemptFailure(prisma);
      await prisma.generationScene.update({ where: { id: chain.sceneId }, data: { state: "PENDING" } });
      await expectRefused(chain, "SHAPE_CONFLICT");
    });

    it("an initial request whose scene already names a rendition", async () => {
      const chain = await seedAttemptFailure(prisma);
      await prisma.generationScene.update({
        where: { id: chain.sceneId },
        data: { currentDeliveredRequestId: chain.requestId },
      });
      await expectRefused(chain, "SHAPE_CONFLICT");
    });

    it("an initial request whose job already holds a video", async () => {
      const chain = await seedAttemptFailure(prisma);
      const versionId = await seedPriorDeliverable(prisma, chain.jobId, chain.tag);
      await prisma.generationJob.update({
        where: { id: chain.jobId },
        data: { currentDeliverableVersionId: versionId },
      });
      await expectRefused(chain, "SHAPE_CONFLICT");
    });

    it.each([["CONSUMED"], ["RESERVING"], [null]] as const)(
      "an initial generation whose Unit is %s",
      async (reservationState) => {
        const chain = await seedAttemptFailure(prisma, { reservationState });
        const before = await snapshot(chain);

        expect(await candidateIds()).toEqual([]);
        expect(await settle(chain)).toEqual({
          kind: "NOT_SETTLEABLE",
          reason: "RESERVATION_NOT_SETTLEABLE",
        });
        expect(await snapshot(chain)).toEqual(before);
      },
    );

    it("a job that is no longer generating", async () => {
      const chain = await seedAttemptFailure(prisma);
      await prisma.generationJob.update({ where: { id: chain.jobId }, data: { state: "SCENES_READY" } });
      const before = await snapshot(chain);

      expect(await candidateIds()).toEqual([]);
      expect(await settle(chain)).toEqual({ kind: "NOT_SETTLEABLE", reason: "JOB_NOT_GENERATING" });
      expect(await snapshot(chain)).toEqual(before);
    });
  });

  describe("tenancy", () => {
    it("finds nothing for another organization's request, and settles nothing", async () => {
      const chain = await seedAttemptFailure(prisma);
      const before = await snapshot(chain);

      expect(await settle(chain, ORG_B)).toEqual({ kind: "NOT_FOUND" });
      expect(await snapshot(chain)).toEqual(before);
    });

    it("names each candidate's own organization", async () => {
      const a = await seedAttemptFailure(prisma);
      const b = await seedAttemptFailure(prisma, { organizationId: ORG_B });

      expect(await settlement.findAttemptFailureCandidates({ limit: 10 })).toEqual([
        { organizationId: ORG_A, generationSceneRequestId: a.requestId },
        { organizationId: ORG_B, generationSceneRequestId: b.requestId },
      ]);
      expect((await settle(b)).kind).toBe("SETTLED");
      expect((await snapshot(a)).reservation?.state).toBe("RESERVED");
    });
  });

  describe("discovery", () => {
    it("offers exactly what the settlement settles, oldest first and bounded", async () => {
      const settleable = [
        await seedAttemptFailure(prisma, { attempts: ["PROVIDER_FAILED"] }),
        await seedAttemptFailure(prisma, { attempts: ["EXHAUSTED"], reservationState: "RECONCILIATION_HOLD" }),
        await seedAttemptFailure(prisma, { attempts: ["EXHAUSTED"], reservationState: "RELEASED" }),
        await seedAttemptFailure(prisma, { requestKind: "USER_REGENERATION", attempts: ["CANCELLED"] }),
      ];
      const refused = [
        await seedAttemptFailure(prisma, { attempts: ["PROCESSING"] }),
        await seedAttemptFailure(prisma, { reservationState: "CONSUMED" }),
        await seedAttemptFailure(prisma, { requestKind: "USER_REGENERATION", reservationState: "RELEASED" }),
        await seedAttemptFailure(prisma, { attempts: [] }),
      ];
      const order = await prisma.sceneGenerationRequest.findMany({
        where: { id: { in: settleable.map((c) => c.requestId) } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });

      expect(await candidateIds()).toEqual(order.map((r) => r.id));
      expect(await candidateIds(1)).toEqual([order[0]?.id]);

      for (const chain of settleable) expect((await settle(chain)).kind).toBe("SETTLED");
      for (const chain of refused) expect((await settle(chain)).kind).toBe("NOT_SETTLEABLE");
      expect(await candidateIds()).toEqual([]);
    });

    it.each([[0], [101], [1.5]])("refuses a bound of %s rather than clamping it", async (limit) => {
      await expect(settlement.findAttemptFailureCandidates({ limit })).rejects.toThrow(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
    });
  });

  describe("the dormant runner", () => {
    it("settles every candidate once, then finds none", async () => {
      const released = await seedAttemptFailure(prisma);
      const rolledBack = await seedAttemptFailure(prisma, { requestKind: "USER_REGENERATION" });
      await seedAttemptFailure(prisma, { attempts: ["PROCESSING"] });
      let n = 0;
      const runner = new AttemptFailureSettlementRunner({
        repository: settlement,
        clock: () => epochMillis(NOW),
        context: () => ctx({ correlationId: `corr_pass_${++n}`, actorType: "WORKER" }),
      });

      const first = await runner.runOnce(10);
      expect([first.settled, first.unitsReleased]).toEqual([2, 1]);
      expect(new Set(first.outcomes.map((o) => o.generationSceneRequestId))).toEqual(
        new Set([released.requestId, rolledBack.requestId]),
      );
      expect(await runner.runOnce(10)).toEqual({ settled: 0, unitsReleased: 0, outcomes: [] });
    });
  });

  describe("the generic transition API", () => {
    it("refuses to fail a generating request or scene on its own", async () => {
      const chain = await seedAttemptFailure(prisma);
      const before = await snapshot(chain);

      expect(
        await repos.requests.transition({
          organizationId: ORG_A,
          id: chain.requestId,
          expectedState: "GENERATING",
          expectedVersion: before.request.stateVersion,
          nextState: "FAILED_TERMINAL",
          context: ctx(),
        }),
      ).toEqual({ kind: "TRANSITION_RESERVED" });
      expect(
        await repos.scenes.transition({
          organizationId: ORG_A,
          id: chain.sceneId,
          expectedState: "GENERATING",
          expectedVersion: before.scene.stateVersion,
          nextState: "FAILED_TERMINAL",
          context: ctx(),
        }),
      ).toEqual({ kind: "TRANSITION_RESERVED" });
      expect(await snapshot(chain)).toEqual(before);
    });
  });

  describe("concurrency and lock order", () => {
    it("settles once when two settlements race", async () => {
      const chain = await seedAttemptFailure(prisma);
      const other = new PrismaClient();
      try {
        const rival = createAttemptFailureSettlementRepository(other);
        const outcomes: AttemptFailureSettlementOutcome[] = await Promise.all([
          settle(chain),
          rival.settleAttemptFailure({
            organizationId: ORG_A,
            generationSceneRequestId: chain.requestId,
            settledAt: NOW,
            context: ctx(),
          }),
        ]);
        expect(outcomes.map((o) => o.kind).sort()).toEqual(["NOT_SETTLEABLE", "SETTLED"]);
        expect(outcomes).toContainEqual({ kind: "NOT_SETTLEABLE", reason: "REQUEST_NOT_GENERATING" });
      } finally {
        await other.$disconnect();
      }
      expect(
        (await eventsOf(prisma, chain.reservationId ?? "")).filter((e) => e.toState === "RELEASED"),
      ).toHaveLength(1);
    });

    // Every entitlement release takes the organization and billing-cycle lock
    // before the reservation (`cost-admission-lock.ts`), so the paid-submission
    // gate cannot admit a send against a Unit this is releasing.
    it("waits for the cost-admission lock of its organization and cycle", async () => {
      const chain = await seedAttemptFailure(prisma);
      const holder = new PrismaClient();
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const holding = holder.$transaction(
        async (tx) => {
          // The formula every cost workflow derives, written out on purpose: if
          // it ever changes, this barrier stops blocking and the test fails.
          await tx.$queryRaw`
            SELECT pg_advisory_xact_lock(
              hashtext(${`paid-submission:${ORG_A}`}),
              hashtext(${"cycle:2026-09"})
            )::text AS locked
          `;
          ready();
          await released;
        },
        { timeout: 30_000 },
      );
      try {
        await held;
        const settling = settle(chain).then(
          (outcome) => outcome.kind,
          (error: unknown) => `threw: ${String(error)}`,
        );
        expect(await waitForBlocked(1, "advisory")).toBe(true);
        expect((await snapshot(chain)).reservation?.state).toBe("RESERVED");
        release();
        await holding;
        expect(await settling).toBe("SETTLED");
      } finally {
        release();
        await holding.catch(() => undefined);
        await holder.$disconnect();
      }
      expect((await snapshot(chain)).reservation?.state).toBe("RELEASED");
    });

    // A writer holding the reservation that then needs the job is the shape
    // Transactions G, H and I take. Were the settlement to lock the job first,
    // the two would deadlock; taking the reservation first, it simply waits.
    it("waits behind a reservation-first writer instead of deadlocking with it", async () => {
      const chain = await seedAttemptFailure(prisma);
      const holder = new PrismaClient();
      let mayLockJob: () => void = () => undefined;
      const jobTurn = new Promise<void>((resolve) => {
        mayLockJob = resolve;
      });
      let ready: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const holding = holder.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "generation_reservations" WHERE "id" = ${chain.reservationId} FOR UPDATE`;
          ready();
          await jobTurn;
          await tx.$queryRaw`SELECT "id" FROM "generation_jobs" WHERE "id" = ${chain.jobId} FOR UPDATE`;
        },
        { timeout: 30_000 },
      );
      try {
        await held;
        const settling = settle(chain).then(
          (outcome) => outcome.kind,
          (error: unknown) => `threw: ${String(error)}`,
        );
        expect(await waitForBlocked(1, "reservation")).toBe(true);
        mayLockJob();
        await holding;
        expect(await settling).toBe("SETTLED");
      } finally {
        mayLockJob();
        await holding.catch(() => undefined);
        await holder.$disconnect();
      }
      expect((await snapshot(chain)).reservation?.state).toBe("RELEASED");
    });
  });
});
