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

    it("lets exactly one of two concurrent revision starts succeed", async () => {
      const chain = await revisableChain();
      const results = await Promise.allSettled([
        startRevision(chain.scene.id, `genreq_r1_${chain.tag}`),
        startRevision(chain.scene.id, `genreq_r2_${chain.tag}`),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      const kinds = results.map((r) => (r.status === "fulfilled" ? r.value.kind : "REJECTED"));
      expect(kinds.filter((k) => k === "ADMITTED")).toHaveLength(1);

      const stored = await prisma.sceneGenerationRequest.findMany({
        where: { generationSceneId: chain.scene.id, kind: "USER_REGENERATION" },
      });
      expect(stored).toHaveLength(1);
      // The job moved exactly once, not twice.
      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: chain.job.id } });
      expect(job.state).toBe("GENERATING");
    });

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
