import {
  createAttemptFailureSettlementRepository,
  createFailedJobSceneClosureRepository,
} from "@app/database";
import {
  FailedJobSceneClosureRunner,
  epochMillis,
  type FailedJobSceneClosureOutcome,
} from "@app/domain";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  addAttempts,
  addSiblingScene,
  endAttempt,
  eventsOf,
  seedAttemptFailure,
  type AttemptEnd,
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
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * ADR-0084 against live PostgreSQL: once a job has failed, each of its other
 * open scenes closes, as soon as nothing of it is at the provider.
 *
 * Each job fails the way it does in production, through the attempt failure
 * settlement (ADR-0083), which releases its Unit. Every attempt is admitted
 * through the real admission primitive and only its end is written by hand
 * (`attempt-failure-fixture.ts`). Nothing here calls a provider.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const closure = createFailedJobSceneClosureRepository(prisma);
const settlement = createAttemptFailureSettlementRepository(prisma);
const repos = repositories(prisma);

const FAILED_AT = Date.UTC(2026, 8, 26, 9, 0, 0);
const NOW = Date.UTC(2026, 8, 26, 10, 0, 0);

interface Sibling {
  readonly chain: AttemptFailureChain;
  readonly sceneId: string;
  readonly requestId: string;
  readonly attemptIds: readonly string[];
}

let position = 0;

/**
 * Another scene of `chain`'s job, in `state`. A started one with `attempts` has
 * them admitted while its job is still generating, as production admits them.
 */
async function sibling(
  chain: AttemptFailureChain,
  state: "PENDING" | "GENERATING" | "READY",
  attempts: readonly AttemptEnd[] = [],
): Promise<Sibling> {
  position += 1;
  const added = await addSiblingScene(prisma, chain, position, state);
  const attemptIds = await addAttempts(
    prisma,
    chain.organizationId,
    added.requestId,
    `${chain.tag}_${position}_`,
    attempts,
  );
  return { chain, ...added, attemptIds };
}

/** Fail the chain's job the way production does, releasing its Unit. */
async function failJob(chain: AttemptFailureChain): Promise<void> {
  const settled = await settlement.settleAttemptFailure({
    organizationId: chain.organizationId,
    generationSceneRequestId: chain.requestId,
    settledAt: FAILED_AT,
    context: ctx({ correlationId: `corr_fail_${chain.tag}`, actorType: "WORKER" }),
  });
  expect(settled).toEqual({ kind: "SETTLED", settlement: "INITIAL_FAILED", unitReleased: true });
}

function close(scene: Sibling, organizationId = scene.chain.organizationId) {
  return closure.closeFailedJobScene({
    organizationId,
    generationSceneId: scene.sceneId,
    closedAt: NOW,
    context: ctx({ correlationId: `corr_${scene.sceneId}`, actorType: "WORKER" }),
  });
}

async function candidateIds(limit = 100): Promise<string[]> {
  return (await closure.findFailedJobSceneCandidates({ limit })).map((c) => c.generationSceneId);
}

/** Every row a closure could touch, and the ones it must not, for "nothing was written". */
async function snapshot(scene: Sibling) {
  return {
    scene: await prisma.generationScene.findUniqueOrThrow({ where: { id: scene.sceneId } }),
    request: await prisma.sceneGenerationRequest.findUniqueOrThrow({ where: { id: scene.requestId } }),
    attempts: await prisma.sceneGeneration.findMany({
      where: { generationSceneRequestId: scene.requestId },
      orderBy: { attemptOrdinal: "asc" },
    }),
    job: await prisma.generationJob.findUniqueOrThrow({ where: { id: scene.chain.jobId } }),
    reservation: await prisma.generationReservation.findUniqueOrThrow({
      where: { id: scene.chain.reservationId ?? "" },
    }),
    events: await prisma.generationTransitionEvent.count(),
  };
}

/** Refused, never offered, and nothing written. */
async function expectRefused(scene: Sibling, reason: string): Promise<void> {
  const before = await snapshot(scene);
  expect(await candidateIds()).not.toContain(scene.sceneId);
  expect(await close(scene)).toEqual({ kind: "NOT_CLOSABLE", reason });
  expect(await snapshot(scene)).toEqual(before);
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

function closureEvent(scene: Sibling, from: string, to: string, eventType: string) {
  return [from, to, eventType, "FAILED_JOB_SCENE_CLOSURE", ORG_A, `corr_${scene.sceneId}`, "WORKER"];
}

/** How many backends wait on the cost-admission lock, or on the scene and job. */
async function blockedBackends(on: "advisory" | "chain"): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ wait_event: string | null; query: string }[]>(
    `SELECT wait_event, query FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'`,
  );
  return rows.filter((r) =>
    on === "advisory"
      ? r.wait_event === "advisory"
      : r.wait_event !== "advisory" && r.query.includes("FOR UPDATE OF j, s\n"),
  ).length;
}

async function waitForBlocked(count: number, on: "advisory" | "chain"): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if ((await blockedBackends(on)) >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

RUN("ADR-0084 — a failed job's open scenes close", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  describe("a scene that never started", () => {
    it("is cancelled with its pending request, and nothing that carries money moves", async () => {
      const chain = await seedAttemptFailure(prisma);
      const scene = await sibling(chain, "PENDING");
      await failJob(chain);
      const before = await snapshot(scene);

      expect(await close(scene)).toEqual({ kind: "CLOSED", scene: "CANCELLED", attemptsCancelled: 0 });

      const after = await snapshot(scene);
      expect([after.scene.state, after.scene.stateVersion, after.scene.currentDeliveredRequestId]).toEqual([
        "CANCELLED",
        before.scene.stateVersion + 1,
        null,
      ]);
      expect([
        after.request.state,
        after.request.stateVersion,
        after.request.failedAt,
        after.request.deliveredAt,
      ]).toEqual(["CANCELLED", before.request.stateVersion + 1, null, null]);
      expect(after.job).toEqual(before.job);
      expect(after.reservation).toEqual(before.reservation);
      expect(after.events).toBe(before.events + 2);
      expect(lastEvent(await eventsOf(prisma, scene.requestId))).toEqual(
        closureEvent(scene, "PENDING", "CANCELLED", "scene_request.cancelled"),
      );
      expect(lastEvent(await eventsOf(prisma, scene.sceneId))).toEqual(
        closureEvent(scene, "PENDING", "CANCELLED", "scene.cancelled"),
      );
    });
  });

  describe("a scene that started", () => {
    it("fails, cancelling the attempt still waiting to be sent", async () => {
      const chain = await seedAttemptFailure(prisma);
      const scene = await sibling(chain, "GENERATING", ["QUEUED"]);
      await failJob(chain);
      const before = await snapshot(scene);

      expect(await close(scene)).toEqual({
        kind: "CLOSED",
        scene: "FAILED_TERMINAL",
        attemptsCancelled: 1,
      });

      const after = await snapshot(scene);
      const [attemptBefore] = before.attempts;
      expect(after.attempts).toEqual([
        {
          ...attemptBefore,
          orchestrationState: "CANCELLED_PRE_SUBMISSION",
          stateVersion: (attemptBefore?.stateVersion ?? -1) + 1,
          updatedAt: after.attempts[0]?.updatedAt,
        },
      ]);
      // Never at the provider: nothing about a submission is recorded.
      expect([
        after.attempts[0]?.submissionCertainty,
        after.attempts[0]?.providerPredictionId,
        after.attempts[0]?.submissionBoundaryEnteredAt,
      ]).toEqual([attemptBefore?.submissionCertainty, null, null]);
      expect([
        after.request.state,
        after.request.stateVersion,
        after.request.failedAt,
        after.request.deliveredAt,
      ]).toEqual(["FAILED_TERMINAL", before.request.stateVersion + 1, new Date(NOW), null]);
      expect([after.scene.state, after.scene.stateVersion]).toEqual([
        "FAILED_TERMINAL",
        before.scene.stateVersion + 1,
      ]);
      expect(after.job).toEqual(before.job);
      expect(after.reservation).toEqual(before.reservation);
      expect(after.events).toBe(before.events + 3);
      expect(lastEvent(await eventsOf(prisma, scene.attemptIds[0] ?? ""))).toEqual(
        closureEvent(scene, "QUEUED", "CANCELLED_PRE_SUBMISSION", "attempt.cancelled_pre_submission"),
      );
      expect(lastEvent(await eventsOf(prisma, scene.requestId))).toEqual(
        closureEvent(scene, "GENERATING", "FAILED_TERMINAL", "scene_request.failed"),
      );
      expect(lastEvent(await eventsOf(prisma, scene.sceneId))).toEqual(
        closureEvent(scene, "GENERATING", "FAILED_TERMINAL", "scene.failed"),
      );
    });

    it("fails with its request cancelled when the request was never admitted", async () => {
      const chain = await seedAttemptFailure(prisma);
      const scene = await sibling(chain, "GENERATING");
      await failJob(chain);
      const before = await snapshot(scene);

      expect(await close(scene)).toEqual({
        kind: "CLOSED",
        scene: "FAILED_TERMINAL",
        attemptsCancelled: 0,
      });

      const after = await snapshot(scene);
      expect([after.scene.state, after.request.state, after.request.failedAt]).toEqual([
        "FAILED_TERMINAL",
        "CANCELLED",
        null,
      ]);
      expect(after.events).toBe(before.events + 2);
      expect(lastEvent(await eventsOf(prisma, scene.sceneId))).toEqual(
        closureEvent(scene, "GENERATING", "FAILED_TERMINAL", "scene.failed"),
      );
    });

    it.each([
      ["REJECTED"],
      ["REJECTED_RETRYABLE"],
      ["PROVIDER_FAILED"],
      ["EXHAUSTED"],
      ["CANCELLED"],
      ["OUTPUT_VERIFIED"],
    ] as const)("fails once its attempt ended %s, leaving the attempt as evidence", async (end) => {
      const chain = await seedAttemptFailure(prisma);
      const scene = await sibling(chain, "GENERATING", [end]);
      await failJob(chain);
      const before = await snapshot(scene);

      expect(await close(scene)).toEqual({
        kind: "CLOSED",
        scene: "FAILED_TERMINAL",
        attemptsCancelled: 0,
      });

      const after = await snapshot(scene);
      expect(after.attempts).toEqual(before.attempts);
      expect([after.scene.state, after.request.state, after.request.failedAt]).toEqual([
        "FAILED_TERMINAL",
        "FAILED_TERMINAL",
        new Date(NOW),
      ]);
      expect(after.job).toEqual(before.job);
      expect(after.reservation).toEqual(before.reservation);
      expect(after.events).toBe(before.events + 2);
    });

    it("cancels only the waiting attempt behind an ended one", async () => {
      const chain = await seedAttemptFailure(prisma);
      const scene = await sibling(chain, "GENERATING", ["REJECTED_RETRYABLE", "QUEUED"]);
      await failJob(chain);
      const before = await snapshot(scene);

      expect(await close(scene)).toEqual({
        kind: "CLOSED",
        scene: "FAILED_TERMINAL",
        attemptsCancelled: 1,
      });
      const after = await snapshot(scene);
      expect(after.attempts[0]).toEqual(before.attempts[0]);
      expect(after.attempts.map((a) => a.orchestrationState)).toEqual([
        "FAILED_RETRYABLE",
        "CANCELLED_PRE_SUBMISSION",
      ]);
    });

    it("waits while an attempt may be at the provider, then closes once it ends", async () => {
      const chain = await seedAttemptFailure(prisma);
      const scene = await sibling(chain, "GENERATING", ["PROCESSING"]);
      await failJob(chain);

      await expectRefused(scene, "ATTEMPT_IN_FLIGHT");

      await endAttempt(prisma, ORG_A, scene.attemptIds[0] ?? "", "PROVIDER_FAILED");
      expect(await candidateIds()).toEqual([scene.sceneId]);
      expect(await close(scene)).toEqual({
        kind: "CLOSED",
        scene: "FAILED_TERMINAL",
        attemptsCancelled: 0,
      });
    });

    it("admits no further attempt once its request failed", async () => {
      const chain = await seedAttemptFailure(prisma);
      const scene = await sibling(chain, "GENERATING", ["QUEUED"]);
      await failJob(chain);
      await close(scene);

      expect(
        await repos.attempts.admit(
          ORG_A,
          attemptInput({ id: `sgen_${scene.sceneId}_late`, generationSceneRequestId: scene.requestId }),
          ctx(),
        ),
      ).toEqual({ kind: "REQUEST_NOT_ADMITTING" });
    });
  });

  describe("what is not closed, and never offered", () => {
    it("a scene that is ready", async () => {
      const chain = await seedAttemptFailure(prisma);
      const scene = await sibling(chain, "READY");
      await failJob(chain);
      await expectRefused(scene, "SCENE_NOT_OPEN");
    });

    it("the scene whose settlement failed the job", async () => {
      const chain = await seedAttemptFailure(prisma);
      await failJob(chain);
      await expectRefused(
        { chain, sceneId: chain.sceneId, requestId: chain.requestId, attemptIds: chain.attemptIds },
        "SCENE_NOT_OPEN",
      );
    });

    it("a scene already closed, answered as not open, writing nothing", async () => {
      const chain = await seedAttemptFailure(prisma);
      const scene = await sibling(chain, "GENERATING", ["QUEUED"]);
      await failJob(chain);
      expect(await candidateIds()).toEqual([scene.sceneId]);
      await close(scene);
      await expectRefused(scene, "SCENE_NOT_OPEN");
      expect(await candidateIds()).toEqual([]);
    });

    it.each([["GENERATING"], ["CANCELLED"]] as const)("a scene of a job that is %s", async (state) => {
      const chain = await seedAttemptFailure(prisma);
      const scene = await sibling(chain, "PENDING");
      if (state === "CANCELLED") {
        await prisma.generationJob.update({ where: { id: chain.jobId }, data: { state } });
      }
      await expectRefused(scene, "JOB_NOT_FAILED");
    });

    // Shapes no workflow writes for a job that never delivered, written by hand.
    it.each([
      ["a second request", "SECOND_REQUEST"],
      ["a pointer naming a rendition", "POINTER"],
      ["a generating request under a scene that never started", "SCENE_BEHIND"],
      ["a delivered request", "DELIVERED_REQUEST"],
      ["a regeneration request", "REGENERATION"],
      ["a request already failed", "CLOSED_REQUEST"],
      ["an attempt under a pending request", "PENDING_WITH_ATTEMPT"],
    ] as const)("a scene with %s", async (_label, shape) => {
      const chain = await seedAttemptFailure(prisma);
      const started = !["SECOND_REQUEST", "POINTER", "REGENERATION"].includes(shape);
      const scene = await sibling(chain, started ? "GENERATING" : "PENDING", started ? ["REJECTED"] : []);
      await failJob(chain);
      if (shape === "SECOND_REQUEST") {
        await prisma.sceneGenerationRequest.create({
          data: {
            id: `${scene.requestId}_regen`,
            generationSceneId: scene.sceneId,
            kind: "USER_REGENERATION",
            userRegenerationOrdinal: 1,
            requestedByUserId: "usr_itest",
          },
        });
      } else if (shape === "POINTER") {
        await prisma.generationScene.update({
          where: { id: scene.sceneId },
          data: { currentDeliveredRequestId: scene.requestId },
        });
      } else if (shape === "SCENE_BEHIND") {
        await prisma.generationScene.update({ where: { id: scene.sceneId }, data: { state: "PENDING" } });
      } else if (shape === "DELIVERED_REQUEST") {
        await prisma.sceneGenerationRequest.update({
          where: { id: scene.requestId },
          data: { deliveredAt: new Date("2026-09-03T00:00:00.000Z") },
        });
      } else if (shape === "REGENERATION") {
        await prisma.sceneGenerationRequest.update({
          where: { id: scene.requestId },
          data: { kind: "USER_REGENERATION", userRegenerationOrdinal: 1 },
        });
      } else if (shape === "CLOSED_REQUEST") {
        await prisma.sceneGenerationRequest.update({
          where: { id: scene.requestId },
          data: { state: "FAILED_TERMINAL", failedAt: new Date("2026-09-03T00:00:00.000Z") },
        });
      } else {
        await prisma.sceneGenerationRequest.update({
          where: { id: scene.requestId },
          data: { state: "PENDING" },
        });
      }
      await expectRefused(scene, "SHAPE_CONFLICT");
    });
  });

  describe("tenancy", () => {
    it("finds nothing for another organization's scene, and closes nothing", async () => {
      const chain = await seedAttemptFailure(prisma);
      const scene = await sibling(chain, "GENERATING", ["QUEUED"]);
      await failJob(chain);
      const before = await snapshot(scene);

      expect(await close(scene, ORG_B)).toEqual({ kind: "NOT_FOUND" });
      expect(await snapshot(scene)).toEqual(before);
    });

    it("names each candidate's own organization", async () => {
      const a = await seedAttemptFailure(prisma);
      const sceneA = await sibling(a, "PENDING");
      await failJob(a);
      const b = await seedAttemptFailure(prisma, { organizationId: ORG_B });
      const sceneB = await sibling(b, "PENDING");
      await failJob(b);

      expect(await closure.findFailedJobSceneCandidates({ limit: 10 })).toEqual([
        { organizationId: ORG_A, generationSceneId: sceneA.sceneId },
        { organizationId: ORG_B, generationSceneId: sceneB.sceneId },
      ]);
      expect((await close(sceneB)).kind).toBe("CLOSED");
      expect((await snapshot(sceneA)).scene.state).toBe("PENDING");
    });
  });

  describe("discovery", () => {
    it("offers exactly what the closure closes, oldest first and bounded", async () => {
      const chain = await seedAttemptFailure(prisma);
      const closable = [
        await sibling(chain, "PENDING"),
        await sibling(chain, "GENERATING"),
        await sibling(chain, "GENERATING", ["QUEUED"]),
        await sibling(chain, "GENERATING", ["PROVIDER_FAILED"]),
      ];
      const refused = [
        await sibling(chain, "GENERATING", ["PROCESSING"]),
        await sibling(chain, "READY"),
      ];
      await failJob(chain);
      const live = await seedAttemptFailure(prisma);
      refused.push(await sibling(live, "PENDING"));

      const order = await prisma.generationScene.findMany({
        where: { id: { in: closable.map((s) => s.sceneId) } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      expect(await candidateIds()).toEqual(order.map((s) => s.id));
      expect(await candidateIds(1)).toEqual([order[0]?.id]);

      for (const scene of closable) expect((await close(scene)).kind).toBe("CLOSED");
      for (const scene of refused) expect((await close(scene)).kind).toBe("NOT_CLOSABLE");
      expect(await candidateIds()).toEqual([]);
    });

    it.each([[0], [101], [1.5]])("refuses a bound of %s rather than clamping it", async (limit) => {
      await expect(closure.findFailedJobSceneCandidates({ limit })).rejects.toThrow(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
    });
  });

  describe("the dormant runner", () => {
    it("closes every candidate once, then finds none", async () => {
      const chain = await seedAttemptFailure(prisma);
      const pending = await sibling(chain, "PENDING");
      const waiting = await sibling(chain, "GENERATING", ["QUEUED"]);
      await sibling(chain, "GENERATING", ["PROCESSING"]);
      await failJob(chain);
      let n = 0;
      const runner = new FailedJobSceneClosureRunner({
        repository: closure,
        clock: () => epochMillis(NOW),
        context: () => ctx({ correlationId: `corr_pass_${++n}`, actorType: "WORKER" }),
      });

      const first = await runner.runOnce(10);
      expect([first.closed, first.attemptsCancelled, first.failed]).toEqual([2, 1, 0]);
      expect(new Set(first.outcomes.map((o) => o.generationSceneId))).toEqual(
        new Set([pending.sceneId, waiting.sceneId]),
      );
      expect(await runner.runOnce(10)).toEqual({
        closed: 0,
        attemptsCancelled: 0,
        failed: 0,
        outcomes: [],
      });
    });
  });

  describe("concurrency and lock order", () => {
    it("closes once when two closures race", async () => {
      const chain = await seedAttemptFailure(prisma);
      const scene = await sibling(chain, "GENERATING", ["QUEUED"]);
      await failJob(chain);
      const other = new PrismaClient();
      try {
        const rival = createFailedJobSceneClosureRepository(other);
        const outcomes: FailedJobSceneClosureOutcome[] = await Promise.all([
          close(scene),
          rival.closeFailedJobScene({
            organizationId: ORG_A,
            generationSceneId: scene.sceneId,
            closedAt: NOW,
            context: ctx(),
          }),
        ]);
        expect(outcomes.map((o) => o.kind).sort()).toEqual(["CLOSED", "NOT_CLOSABLE"]);
        expect(outcomes).toContainEqual({ kind: "NOT_CLOSABLE", reason: "SCENE_NOT_OPEN" });
      } finally {
        await other.$disconnect();
      }
      expect(
        (await eventsOf(prisma, scene.attemptIds[0] ?? "")).filter(
          (e) => e.toState === "CANCELLED_PRE_SUBMISSION",
        ),
      ).toHaveLength(1);
      expect((await eventsOf(prisma, scene.sceneId)).filter((e) => e.toState === "FAILED_TERMINAL")).toHaveLength(1);
    });

    // The paid-submission gate takes the organization and billing-cycle lock
    // before it moves an attempt toward the provider. Waiting for that lock, the
    // closure decides from what the gate committed: an attempt it sent is in
    // flight, and the scene stays open.
    it("waits for the cost-admission lock, then decides from what its holder committed", async () => {
      const chain = await seedAttemptFailure(prisma);
      const scene = await sibling(chain, "GENERATING", ["QUEUED"]);
      await failJob(chain);
      const attemptId = scene.attemptIds[0] ?? "";
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
          await tx.$executeRaw`
            UPDATE "scene_generations"
               SET "orchestrationState" = 'SUBMITTING'::"GenerationAttemptState",
                   "submissionBoundaryEnteredAt" = CURRENT_TIMESTAMP
             WHERE "id" = ${attemptId}`;
        },
        { timeout: 30_000 },
      );
      try {
        await held;
        const closing = close(scene).then(
          (outcome) => outcome,
          (error: unknown) => `threw: ${String(error)}`,
        );
        expect(await waitForBlocked(1, "advisory")).toBe(true);
        release();
        await holding;
        expect(await closing).toEqual({ kind: "NOT_CLOSABLE", reason: "ATTEMPT_IN_FLIGHT" });
      } finally {
        release();
        await holding.catch(() => undefined);
        await holder.$disconnect();
      }
      const after = await snapshot(scene);
      expect([after.attempts[0]?.orchestrationState, after.request.state, after.scene.state]).toEqual([
        "SUBMITTING",
        "GENERATING",
        "GENERATING",
      ]);
    });

    // Transactions H and K take the cost-admission lock and then the job; on a
    // failed job they are refused, but only after taking both. Were the closure
    // to lock the job first, the two would deadlock; taking the advisory lock
    // first, it simply waits.
    it("waits behind an advisory-first writer that then needs the job, instead of deadlocking", async () => {
      const chain = await seedAttemptFailure(prisma);
      const scene = await sibling(chain, "GENERATING", ["QUEUED"]);
      await failJob(chain);
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
          await tx.$queryRaw`
            SELECT pg_advisory_xact_lock(
              hashtext(${`paid-submission:${ORG_A}`}),
              hashtext(${"cycle:2026-09"})
            )::text AS locked
          `;
          ready();
          await jobTurn;
          await tx.$queryRaw`SELECT "id" FROM "generation_jobs" WHERE "id" = ${chain.jobId} FOR UPDATE`;
        },
        { timeout: 30_000 },
      );
      try {
        await held;
        const closing = close(scene).then(
          (outcome) => outcome,
          (error: unknown) => `threw: ${String(error)}`,
        );
        expect(await waitForBlocked(1, "advisory")).toBe(true);
        mayLockJob();
        await holding;
        expect(await closing).toEqual({
          kind: "CLOSED",
          scene: "FAILED_TERMINAL",
          attemptsCancelled: 1,
        });
      } finally {
        mayLockJob();
        await holding.catch(() => undefined);
        await holder.$disconnect();
      }
    });

    // Transaction F, revision start and media recovery lock the job and take no
    // advisory lock. The closure, holding the advisory lock, waits for the job
    // and then closes from what that writer committed.
    it("waits behind a writer holding the job, then closes", async () => {
      const chain = await seedAttemptFailure(prisma);
      const scene = await sibling(chain, "GENERATING", ["QUEUED"]);
      await failJob(chain);
      const holder = new PrismaClient();
      let mayCommit: () => void = () => undefined;
      const commitTurn = new Promise<void>((resolve) => {
        mayCommit = resolve;
      });
      let ready: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const holding = holder.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "generation_jobs" WHERE "id" = ${chain.jobId} FOR UPDATE`;
          ready();
          await commitTurn;
        },
        { timeout: 30_000 },
      );
      try {
        await held;
        const closing = close(scene).then(
          (outcome) => outcome,
          (error: unknown) => `threw: ${String(error)}`,
        );
        expect(await waitForBlocked(1, "chain")).toBe(true);
        expect((await snapshot(scene)).attempts[0]?.orchestrationState).toBe("QUEUED");
        mayCommit();
        await holding;
        expect(await closing).toEqual({
          kind: "CLOSED",
          scene: "FAILED_TERMINAL",
          attemptsCancelled: 1,
        });
      } finally {
        mayCommit();
        await holding.catch(() => undefined);
        await holder.$disconnect();
      }
    });
  });
});
