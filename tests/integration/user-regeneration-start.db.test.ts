import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ctx,
  dropTenants,
  HAS_DB,
  makeJobRevisable,
  ORG_A,
  PROJECT_A,
  repositories,
  seedChain,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * Revision start, as one atomic business fact.
 *
 * Before Phase 4C-3B-2H-3B-6C this created a request and stopped, leaving the
 * job and scene for "some future actor" that was never written — which is why
 * Phases 6A and 6B both carried "the REVISING actor must be proven to exist" as
 * a blocker. This suite is that proof.
 *
 * The other half is the MVP constraint: **one active regeneration per job**. It
 * is a schema limitation stated honestly, not a preference — with two revisions
 * in flight and one failing, nothing durable records which scene versions the
 * current deliverable was composed from, so a rollback target cannot be
 * determined. The job row is what enforces it.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const repos = repositories(prisma);

let seq = 0;

async function revisableChain() {
  seq += 1;
  const chain = await seedChain(prisma, `rev${seq}`, ORG_A, PROJECT_A, { revisable: true });
  return { ...chain, tag: `rev${seq}` };
}

async function startRevision(sceneId: string, id: string) {
  return repos.requests.admitUserRegeneration(
    ORG_A,
    { id, generationSceneId: sceneId, requestedByUserId: "usr_itest" },
    ctx({ actorType: "USER", actorUserId: "usr_itest", correlationId: "corr_revision" }),
  );
}

RUN("starting a user regeneration", () => {
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

  describe("the committed shape", () => {
    it("creates the request and moves the scene and job in one commit", async () => {
      const chain = await revisableChain();
      const before = {
        scene: await prisma.generationScene.findUniqueOrThrow({ where: { id: chain.scene.id } }),
        job: await prisma.generationJob.findUniqueOrThrow({ where: { id: chain.job.id } }),
      };

      const outcome = await startRevision(chain.scene.id, `genreq_start_${chain.tag}`);
      if (outcome.kind !== "ADMITTED") throw new Error(`expected ADMITTED, got ${outcome.kind}`);

      expect(outcome.request.state).toBe("PENDING");
      expect(outcome.request.kind).toBe("USER_REGENERATION");
      expect(outcome.request.userRegenerationOrdinal).toBe(1);

      const scene = await prisma.generationScene.findUniqueOrThrow({
        where: { id: chain.scene.id },
      });
      expect(scene.state).toBe("REVISING");
      expect(scene.stateVersion).toBe(before.scene.stateVersion + 1);
      // The customer keeps the rendition they have until a new one is delivered.
      expect(scene.currentDeliveredRequestId).toBe(chain.request.id);

      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: chain.job.id } });
      // Externally the committed state is GENERATING; the history says how.
      expect(job.state).toBe("GENERATING");
      expect(job.stateVersion).toBe(before.job.stateVersion + 2);
      expect(job.currentDeliverableVersionId).toBe(before.job.currentDeliverableVersionId);

      const reservation = await prisma.generationReservation.findUniqueOrThrow({
        where: { generationJobId: chain.job.id },
      });
      expect(reservation.state).toBe("CONSUMED");
    });

    it("records both job moves as separate events", async () => {
      const chain = await revisableChain();
      await startRevision(chain.scene.id, `genreq_ev_${chain.tag}`);

      const jobEvents = await prisma.generationTransitionEvent.findMany({
        where: { aggregateId: chain.job.id, aggregateType: "JOB" },
        orderBy: { createdAt: "asc" },
      });
      const revision = jobEvents.slice(-2).map((e) => [e.fromState, e.toState]);
      // Not one invented DELIVERABLE_READY -> GENERATING edge: both real moves.
      expect(revision).toEqual([
        ["DELIVERABLE_READY", "REVISING"],
        ["REVISING", "GENERATING"],
      ]);

      const sceneEvents = await prisma.generationTransitionEvent.findMany({
        where: { aggregateId: chain.scene.id, aggregateType: "SCENE" },
        orderBy: { createdAt: "asc" },
      });
      expect(sceneEvents.at(-1)).toMatchObject({ fromState: "READY", toState: "REVISING" });

      const requestEvents = await prisma.generationTransitionEvent.findMany({
        where: { aggregateType: "SCENE_REQUEST", toState: "PENDING" },
      });
      expect(requestEvents.some((e) => e.aggregateId === `genreq_ev_${chain.tag}`)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------

  describe("what a revision requires", () => {
    it("refuses a job that never delivered anything", async () => {
      const chain = await seedChain(prisma, "notdelivered");
      const outcome = await startRevision(chain.scene.id, "genreq_nd");
      expect(outcome.kind).toBe("JOB_NOT_REVISABLE");
      // And nothing moved.
      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: chain.job.id } });
      expect(job.state).toBe("CREATED");
    });

    it("refuses a job with no deliverable version", async () => {
      const chain = await revisableChain();
      await prisma.generationJob.update({
        where: { id: chain.job.id },
        data: { currentDeliverableVersionId: null },
      });
      expect((await startRevision(chain.scene.id, "genreq_nov")).kind).toBe("JOB_NOT_REVISABLE");
    });

    it("refuses a job whose entitlement is not consumed", async () => {
      const chain = await revisableChain();
      await prisma.generationReservation.update({
        where: { generationJobId: chain.job.id },
        data: { state: "RESERVED", consumedAt: null },
      });
      expect((await startRevision(chain.scene.id, "genreq_nc")).kind).toBe("JOB_NOT_REVISABLE");
    });

    it("refuses a scene that is not READY", async () => {
      const chain = await revisableChain();
      await prisma.generationScene.update({
        where: { id: chain.scene.id },
        data: { state: "REVISING" },
      });
      expect((await startRevision(chain.scene.id, "genreq_ns")).kind).toBe("SCENE_NOT_REVISABLE");
    });

    it("refuses a scene whose delivered pointer names nothing delivered", async () => {
      const chain = await revisableChain();
      await prisma.sceneGenerationRequest.update({
        where: { id: chain.request.id },
        data: { state: "FAILED_TERMINAL", deliveredAt: null },
      });
      expect((await startRevision(chain.scene.id, "genreq_np")).kind).toBe("SCENE_NOT_REVISABLE");
    });

    it("refuses an unknown or cross-tenant scene without writing anything", async () => {
      const outcome = await startRevision("genscene_does_not_exist", "genreq_missing");
      expect(outcome.kind).toBe("SCENE_NOT_FOUND");
      expect(
        await prisma.sceneGenerationRequest.count({ where: { id: "genreq_missing" } }),
      ).toBe(0);
    });
  });

  // -------------------------------------------------------------------------

  describe("one active regeneration per job", () => {
    it("refuses a second revision on a different scene of the same job", async () => {
      const chain = await revisableChain();
      // A second delivered scene in the same job, equally revisable on its own.
      const second = await prisma.generationScene.create({
        data: {
          id: `genscene_two_${chain.tag}`,
          generationJobId: chain.job.id,
          position: 1,
          sourceStoryboardSceneId: "sbs_itest_orch_gone",
          sourceAssetId: "ast_itest_orch_a",
          sourceAnalysisRevision: 1,
          snapshotDurationSeconds: 5,
          state: "READY",
        },
      });
      const secondInitial = await prisma.sceneGenerationRequest.create({
        data: {
          id: `genreq_two_${chain.tag}`,
          generationSceneId: second.id,
          kind: "INITIAL",
          state: "DELIVERED",
          deliveredAt: new Date(),
          requestedByUserId: "usr_itest",
        },
      });
      await prisma.generationScene.update({
        where: { id: second.id },
        data: { currentDeliveredRequestId: secondInitial.id },
      });

      const first = await startRevision(chain.scene.id, `genreq_a_${chain.tag}`);
      expect(first.kind).toBe("ADMITTED");

      // The job left DELIVERABLE_READY, and that *is* the mutex.
      const blocked = await startRevision(second.id, `genreq_b_${chain.tag}`);
      expect(blocked.kind).toBe("JOB_NOT_REVISABLE");
      expect(
        await prisma.sceneGenerationRequest.count({ where: { id: `genreq_b_${chain.tag}` } }),
      ).toBe(0);
    });

    it("refuses a second revision on the same scene", async () => {
      const chain = await revisableChain();
      expect((await startRevision(chain.scene.id, `genreq_x_${chain.tag}`)).kind).toBe("ADMITTED");
      // Re-arm the job so the refusal comes from the active-regeneration rule
      // rather than from the job state, which is the narrower claim.
      await makeJobRevisable(prisma, chain, `${chain.tag}b`);
      expect((await startRevision(chain.scene.id, `genreq_y_${chain.tag}`)).kind).toBe(
        "REGENERATION_ALREADY_ACTIVE",
      );
    });

    /**
     * Two revisions on **different** scenes of one job, forced into the critical
     * interleaving by a third session holding the Job row.
     *
     * ## Why the previous version of this test was not enough
     *
     * It raced two revisions on the *same* scene and accepted whatever order the
     * connection pool happened to produce. When the two serialized — which they
     * usually did — the second simply read the first's committed `PENDING`
     * regeneration and returned `REGENERATION_ALREADY_ACTIVE`, so the test passed
     * without either caller ever reaching the Job authority together. Mutation
     * M210, which deletes `FOR UPDATE OF j, s`, therefore survived roughly half
     * the time: a timing-dependent kill is not a regression.
     *
     * ## What this proves instead
     *
     * The invariant is not "eventually one transaction commits". It is that one
     * active `USER_REGENERATION` per Job is serialized **at the Job authority**,
     * and that the loser learns so through the application-owned outcome rather
     * than through a raw database error.
     *
     * With the Job lock in place:
     *
     * ```text
     * holder owns the Job row
     *   -> A and B both block at lockJobAndSceneForTenant, before reading anything
     *   -> holder releases
     *   -> one acquires the lock, reads DELIVERABLE_READY, completes revision start
     *   -> the other then acquires it, re-reads GENERATING, returns JOB_NOT_REVISABLE
     * ```
     *
     * Without it (M210), the initial SELECT no longer locks, so a plain read is
     * not blocked by the holder at all:
     *
     * ```text
     * A and B both read DELIVERABLE_READY and both pass the preconditions
     *   -> different scenes, so neither blocks on the other's scene row or index
     *   -> both create their request and both reach the Job UPDATE
     *   -> holder releases; one UPDATE wins
     *   -> the other matches zero rows and throws, instead of returning an outcome
     * ```
     *
     * So the assertion that *both* calls fulfil is what kills M210, and it kills
     * it for a reason the product cares about rather than by luck.
     */
    it("serializes two revisions on different scenes at the job authority", async () => {
      const chain = await revisableChain();

      // A second delivered scene in the same job. On its own it is exactly as
      // revisable as the first.
      const sceneB = await prisma.generationScene.create({
        data: {
          id: `genscene_b_${chain.tag}`,
          generationJobId: chain.job.id,
          position: 1,
          sourceStoryboardSceneId: "sbs_itest_orch_gone",
          sourceAssetId: "ast_itest_orch_a",
          sourceAnalysisRevision: 1,
          snapshotDurationSeconds: 5,
          state: "READY",
        },
      });
      const predecessorB = await prisma.sceneGenerationRequest.create({
        data: {
          id: `genreq_bpred_${chain.tag}`,
          generationSceneId: sceneB.id,
          kind: "INITIAL",
          state: "DELIVERED",
          deliveredAt: new Date("2026-08-01T00:00:00.000Z"),
          requestedByUserId: "usr_itest",
        },
      });
      await prisma.generationScene.update({
        where: { id: sceneB.id },
        data: { currentDeliveredRequestId: predecessorB.id },
      });

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

      /** Resolves when `promise` settles; never rejects. Used to prove blocking. */
      function settled<T>(promise: Promise<T>): {
        done: () => boolean;
        value: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>;
      } {
        let finished = false;
        const value = promise.then(
          (v) => {
            finished = true;
            return { ok: true as const, value: v };
          },
          (error: unknown) => {
            finished = true;
            return { ok: false as const, error };
          },
        );
        return { done: () => finished, value };
      }

      /** Backends waiting on a PostgreSQL lock. Observation only, never ordering. */
      async function blockedBackends(): Promise<number> {
        const rows = await prisma.$queryRawUnsafe<{ wait_event_type: string | null }[]>(
          `SELECT wait_event_type FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()`,
        );
        return rows.filter((r) => r.wait_event_type === "Lock").length;
      }

      let runA!: ReturnType<typeof settled<Awaited<ReturnType<typeof startRevision>>>>;
      let runB!: ReturnType<typeof settled<Awaited<ReturnType<typeof startRevision>>>>;
      let bothBlocked = false;

      const holderDone = holder
        .$transaction(
          async (tx) => {
            await tx.$queryRawUnsafe(
              `SELECT "id" FROM "generation_jobs" WHERE "id" = $1 FOR UPDATE`,
              chain.job.id,
            );
            holderHasLock();
            await holderMayFinish;
          },
          { timeout: 30_000, maxWait: 30_000 },
        )
        .catch(() => undefined);

      try {
        // The holder owns the Job row before either worker starts. The row lock
        // is the ordering authority; the polling below only observes it.
        await holderReady;

        runA = settled(
          repositories(workerA).requests.admitUserRegeneration(
            ORG_A,
            {
              id: `genreq_ra_${chain.tag}`,
              generationSceneId: chain.scene.id,
              requestedByUserId: "usr_itest",
            },
            ctx({ actorType: "USER", actorUserId: "usr_itest", correlationId: "corr_ra" }),
          ),
        );
        runB = settled(
          repositories(workerB).requests.admitUserRegeneration(
            ORG_A,
            {
              id: `genreq_rb_${chain.tag}`,
              generationSceneId: sceneB.id,
              requestedByUserId: "usr_itest",
            },
            ctx({ actorType: "USER", actorUserId: "usr_itest", correlationId: "corr_rb" }),
          ),
        );

        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          if ((await blockedBackends()) >= 2) {
            bothBlocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        // Released on every path, so a failing assertion above cannot strand the
        // Job row locked for the rest of the suite.
        releaseHolder();
      }
      await holderDone;

      // Both really contended, and neither had finished while the holder owned
      // the row. Without this the rest of the test could pass on two sequential
      // calls that never met.
      expect(bothBlocked).toBe(true);

      const [a, b] = await Promise.all([runA.value, runB.value]);

      // Neither call may reject. A uniqueness violation, an INTERNAL_ERROR or any
      // raw database error here is the failure M210 produces.
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) {
        throw new Error(
          `a revision start rejected instead of returning an outcome: ${String(
            (a.ok ? b : a).ok ? "" : ((a.ok ? b : a) as { error: unknown }).error,
          )}`,
        );
      }

      const kinds = [a.value.kind, b.value.kind].sort();
      expect(kinds).toEqual(["ADMITTED", "JOB_NOT_REVISABLE"]);

      // Exactly one regeneration exists across the whole job.
      const regenerations = await prisma.sceneGenerationRequest.findMany({
        where: {
          kind: "USER_REGENERATION",
          generationScene: { generationJobId: chain.job.id },
        },
      });
      expect(regenerations).toHaveLength(1);

      // Exactly one scene is revising; the loser's scene is untouched.
      const scenes = await prisma.generationScene.findMany({
        where: { generationJobId: chain.job.id },
        orderBy: { position: "asc" },
      });
      expect(scenes.filter((s) => s.state === "REVISING")).toHaveLength(1);
      expect(scenes.filter((s) => s.state === "READY")).toHaveLength(1);

      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: chain.job.id } });
      expect(job.state).toBe("GENERATING");

      // The job's revision-start pair happened exactly once, not twice.
      const jobEvents = await prisma.generationTransitionEvent.findMany({
        where: { aggregateId: chain.job.id, aggregateType: "JOB" },
        orderBy: { createdAt: "asc" },
      });
      const moves = jobEvents.map((e) => `${String(e.fromState)}->${String(e.toState)}`);
      expect(moves.filter((m) => m === "DELIVERABLE_READY->REVISING")).toHaveLength(1);
      expect(moves.filter((m) => m === "REVISING->GENERATING")).toHaveLength(1);

      // Nothing of the losing transaction survived — not the request it would
      // have created, not an event for it.
      const loserId =
        a.value.kind === "ADMITTED" ? `genreq_rb_${chain.tag}` : `genreq_ra_${chain.tag}`;
      expect(await prisma.sceneGenerationRequest.count({ where: { id: loserId } })).toBe(0);
      expect(
        await prisma.generationTransitionEvent.count({ where: { aggregateId: loserId } }),
      ).toBe(0);

      await Promise.all([holder.$disconnect(), workerA.$disconnect(), workerB.$disconnect()]);
    }, 60_000);

    it("allows another revision once the job is revisable again", async () => {
      const chain = await revisableChain();
      const first = await startRevision(chain.scene.id, `genreq_p_${chain.tag}`);
      if (first.kind !== "ADMITTED") throw new Error("expected ADMITTED");

      // What a rollback leaves behind: the request failed, the job delivered.
      await prisma.sceneGenerationRequest.update({
        where: { id: first.request.id },
        data: { state: "FAILED_TERMINAL", failedAt: new Date() },
      });
      await makeJobRevisable(prisma, chain, `${chain.tag}c`);

      const second = await startRevision(chain.scene.id, `genreq_q_${chain.tag}`);
      if (second.kind !== "ADMITTED") throw new Error(`expected ADMITTED, got ${second.kind}`);
      // The ordinal returns, because a failed regeneration spends no right.
      expect(second.request.userRegenerationOrdinal).toBe(1);
    });
  });

  // -------------------------------------------------------------------------

  describe("the generic APIs cannot assemble this", () => {
    it.each([
      ["DELIVERABLE_READY", "REVISING"],
      ["REVISING", "GENERATING"],
      ["GENERATING", "DELIVERABLE_READY"],
      ["GENERATING", "SCENES_READY"],
    ] as const)("refuses the reserved job edge %s -> %s", async (from, to) => {
      const chain = await revisableChain();
      const outcome = await repos.jobs.transition({
        organizationId: ORG_A,
        id: chain.job.id,
        expectedState: from,
        expectedVersion: 0,
        nextState: to,
        context: ctx(),
      });
      expect(outcome.kind).toBe("TRANSITION_RESERVED");
    });

    it.each([
      ["READY", "REVISING"],
      ["REVISING", "READY"],
      ["GENERATING", "READY"],
    ] as const)("refuses the reserved scene edge %s -> %s", async (from, to) => {
      const chain = await revisableChain();
      const outcome = await repos.scenes.transition({
        organizationId: ORG_A,
        id: chain.scene.id,
        expectedState: from,
        expectedVersion: 0,
        nextState: to,
        context: ctx(),
      });
      expect(outcome.kind).toBe("TRANSITION_RESERVED");
    });

    it("still allows the edges no atomic primitive owns", async () => {
      const chain = await seedChain(prisma, "generic");
      const scene = await prisma.generationScene.findUniqueOrThrow({
        where: { id: chain.scene.id },
      });
      const outcome = await repos.scenes.transition({
        organizationId: ORG_A,
        id: chain.scene.id,
        expectedState: "PENDING",
        expectedVersion: scene.stateVersion,
        nextState: "GENERATING",
        context: ctx(),
      });
      expect(outcome.kind).toBe("APPLIED");
    });
  });
});
