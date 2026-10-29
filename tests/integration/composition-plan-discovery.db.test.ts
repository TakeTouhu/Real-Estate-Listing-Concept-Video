import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CompositionPlanRunner } from "@app/domain";
import { createDeliverableCompositionPlanRepository } from "@app/database";
import { AppError } from "@app/shared";
import {
  ctx,
  dropTenants,
  HAS_DB,
  ORG_A,
  ORG_B,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";
import {
  makeCurrentDeliverable,
  seedPlanChain,
  worldSnapshot,
  type ChainOptions,
  type PlanChain,
} from "./deliverable-composition-fixture";

/**
 * GS-8 (ADR-0104): finding the jobs Transaction I would plan, and the dormant
 * runner that plans them, against live PostgreSQL.
 *
 * The query is a hint and Transaction I the authority, so every refusal case
 * below shows both halves: the query does not offer the job, and Transaction I
 * refuses it. A job the query offered and Transaction I refused would hold the
 * head of every batch.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const repository = createDeliverableCompositionPlanRepository(prisma);

const T0 = new Date("2026-10-01T00:00:00.000Z");
const T1 = new Date("2026-10-02T00:00:00.000Z");
const T2 = new Date("2026-10-03T00:00:00.000Z");

let versionSeq = 0;

function runner() {
  let correlation = 0;
  return new CompositionPlanRunner({
    repository,
    ids: { nextDeliverableVersionId: () => `gdv_gs8_${++versionSeq}` },
    context: () => ctx({ correlationId: `corr_gs8_${++correlation}` }),
  });
}

async function admit(jobId: string, organizationId = ORG_A) {
  versionSeq += 1;
  return repository.admitCompositionPlan({
    organizationId,
    generationJobId: jobId,
    deliverableVersionId: `gdv_gs8_${versionSeq}`,
    context: ctx(),
  });
}

async function createdAt(chain: PlanChain, at: Date): Promise<void> {
  await prisma.generationJob.update({ where: { id: chain.jobId }, data: { createdAt: at } });
}

/** A first video, ready to plan. */
async function composable(options: ChainOptions = {}): Promise<PlanChain> {
  return seedPlanChain(prisma, options);
}

/** A recomposition: a current deliverable whose hold was spent. */
async function recomposable(options: ChainOptions = {}): Promise<PlanChain> {
  const chain = await seedPlanChain(prisma, { ...options, reservationState: "CONSUMED" });
  await makeCurrentDeliverable(prisma, chain.jobId, "sha256:deliverable-input:v1:prior");
  return chain;
}

RUN("composition plan discovery and its runner (ADR-0104)", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  // -----------------------------------------------------------------------
  describe("what is offered", () => {
    it("offers both cycles, oldest first by creation then id, up to the limit, with their organizations", async () => {
      // Inserted against id order, so neither the heap nor the ids alone give
      // the expected order.
      const c = await recomposable({ tag: "gs8_c" });
      const b = await composable({ tag: "gs8_b", organizationId: ORG_B });
      const a = await composable({ tag: "gs8_a" });
      const d = await composable({ tag: "gs8_d" });
      await createdAt(c, T0);
      await createdAt(b, T1);
      await createdAt(a, T1);
      await createdAt(d, T2);

      expect(await repository.findCompositionPlanCandidates({ limit: 3 })).toEqual([
        { organizationId: ORG_A, generationJobId: c.jobId },
        { organizationId: ORG_A, generationJobId: a.jobId },
        { organizationId: ORG_B, generationJobId: b.jobId },
      ]);
      expect(await repository.findCompositionPlanCandidates({ limit: 100 })).toHaveLength(4);
    });

    it("refuses an unusable limit itself, since it is public", async () => {
      for (const bad of [0, 101, 2.5]) {
        await expect(repository.findCompositionPlanCandidates({ limit: bad })).rejects.toThrow(
          AppError,
        );
      }
    });

    it("offers a job whose verdict is bound to other bytes, so its pass reports the defect", async () => {
      const chain = await composable({ scenes: { 1: { receiptSha256: "d".repeat(64) } } });
      const before = await worldSnapshot(prisma);

      const report = await runner().runOnce(10);

      expect(report).toEqual({
        planned: 0,
        failed: 1,
        outcomes: [
          {
            generationJobId: chain.jobId,
            outcome: { kind: "FAILED", code: "SOURCE_RECEIPT_BINDING_CONFLICT" },
          },
        ],
      });
      expect(await worldSnapshot(prisma)).toEqual(before);
    });
  });

  // -----------------------------------------------------------------------
  describe("what Transaction I refuses is never offered, so it holds no place", () => {
    const refusals: readonly [string, () => Promise<PlanChain>, string][] = [
      ["a job generating", () => composable({ jobState: "GENERATING" }), "NOT_ELIGIBLE"],
      ["a job already planned", () => composable({ jobState: "COMPOSITION_PENDING" }), "DEFECT"],
      ["a job delivered", () => composable({ jobState: "DELIVERABLE_READY" }), "NOT_ELIGIBLE"],
      ["a job failed", () => composable({ jobState: "FAILED_TERMINAL" }), "NOT_ELIGIBLE"],
      ["no video with its hold spent", () => composable({ reservationState: "CONSUMED" }), "NOT_ELIGIBLE"],
      [
        "a video with its hold not spent",
        async () => {
          const chain = await composable();
          await makeCurrentDeliverable(prisma, chain.jobId, "sha256:deliverable-input:v1:prior");
          return chain;
        },
        "NOT_ELIGIBLE",
      ],
      [
        "a video with its hold in reconciliation",
        async () => {
          const chain = await composable({ reservationState: "RECONCILIATION_HOLD" });
          await makeCurrentDeliverable(prisma, chain.jobId, "sha256:deliverable-input:v1:prior");
          return chain;
        },
        "NOT_ELIGIBLE",
      ],
      ["a hold in reconciliation",() => composable({ reservationState: "RECONCILIATION_HOLD" }), "NOT_ELIGIBLE"],
      ["a hold released", () => composable({ reservationState: "RELEASED" }), "NOT_ELIGIBLE"],
      ["a hold being taken", () => composable({ reservationState: "RESERVING" }), "NOT_ELIGIBLE"],
      [
        "no hold at all",
        async () => {
          const chain = await composable();
          await prisma.generationReservation.delete({ where: { id: chain.reservationId } });
          return chain;
        },
        "NOT_ELIGIBLE",
      ],
      ["no scene", () => composable({ sceneCount: 0 }), "NOT_FOUND"],
      ["a scene not READY", () => composable({ scenes: { 1: { sceneState: "REVISING" } } }), "NOT_ELIGIBLE"],
      [
        "a scene with no delivered pointer",
        () => composable({ scenes: { 1: { noDeliveredPointer: true } } }),
        "NOT_ELIGIBLE",
      ],
      [
        "a selected request not DELIVERED",
        () => composable({ scenes: { 1: { requestState: "GENERATING" } } }),
        "NOT_ELIGIBLE",
      ],
      [
        "a selected request with no attempt",
        async () => {
          const chain = await composable();
          const scene = chain.scenes[1]!;
          await prisma.managedOutputMediaValidation.delete({ where: { id: scene.validationId } });
          await prisma.sceneGeneration.delete({ where: { id: scene.attemptId } });
          return chain;
        },
        "NOT_ELIGIBLE",
      ],
      [
        "a latest attempt not OUTPUT_VERIFIED",
        () => composable({ scenes: { 1: { orchestrationState: "PROCESSING" } } }),
        "NOT_ELIGIBLE",
      ],
      ["a newer attempt with no verdict", () => composable({ scenes: { 1: { supersede: true } } }), "NOT_ELIGIBLE"],
      ["a verdict still PENDING", () => composable({ scenes: { 1: { validation: "PENDING" } } }), "NOT_ELIGIBLE"],
      ["a verdict INVALID_MEDIA", () => composable({ scenes: { 1: { validation: "INVALID_MEDIA" } } }), "NOT_ELIGIBLE"],
      ["no verdict at all", () => composable({ scenes: { 1: { validation: "NONE" } } }), "NOT_ELIGIBLE"],
    ];

    for (const [name, seed, answer] of refusals) {
      it(`passes over ${name} to the next job`, async () => {
        const refused = await seed();
        const ready = await composable();
        await createdAt(refused, T0);
        await createdAt(ready, T1);

        expect(await repository.findCompositionPlanCandidates({ limit: 1 })).toEqual([
          { organizationId: ORG_A, generationJobId: ready.jobId },
        ]);
        // And it is a refusal, not a job the query merely overlooked.
        if (answer === "DEFECT") {
          await expect(admit(refused.jobId)).rejects.toMatchObject({ code: "PARTIAL_PLAN_STATE" });
        } else {
          expect((await admit(refused.jobId)).kind).toBe(answer);
        }
      });
    }
  });

  // -----------------------------------------------------------------------
  describe("the runner", () => {
    it("plans each ready job once, with its own version id, then finds nothing", async () => {
      const first = await composable();
      const again = await recomposable();
      await createdAt(first, T0);
      await createdAt(again, T1);
      const start = versionSeq;

      const report = await runner().runOnce(10);

      expect(report.planned).toBe(2);
      expect(report.failed).toBe(0);
      expect(report.outcomes).toEqual([
        {
          generationJobId: first.jobId,
          outcome: expect.objectContaining({
            kind: "PLANNED",
            deliverableVersionId: `gdv_gs8_${start + 1}`,
            ordinal: 1,
          }),
        },
        {
          generationJobId: again.jobId,
          outcome: expect.objectContaining({
            kind: "PLANNED",
            deliverableVersionId: `gdv_gs8_${start + 2}`,
            ordinal: 2,
          }),
        },
      ]);
      for (const chain of [first, again]) {
        const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: chain.jobId } });
        expect(job.state).toBe("COMPOSITION_PENDING");
      }
      const events = await prisma.generationTransitionEvent.findMany({
        where: { aggregateId: { in: [first.jobId, again.jobId] } },
        orderBy: { sequence: "asc" },
      });
      expect(events.map((e) => [e.aggregateId, e.toState, e.correlationId])).toEqual([
        [first.jobId, "COMPOSITION_PENDING", "corr_gs8_1"],
        [again.jobId, "COMPOSITION_PENDING", "corr_gs8_2"],
      ]);

      const before = await worldSnapshot(prisma);
      expect(await runner().runOnce(10)).toEqual({ planned: 0, failed: 0, outcomes: [] });
      expect(await worldSnapshot(prisma)).toEqual(before);
    });
  });
});
