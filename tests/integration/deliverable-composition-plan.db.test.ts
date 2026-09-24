import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  COMPOSITION_PLAN_REASON_CODE,
  DELIVERABLE_PLANNED_EVENT_TYPE,
  DELIVERABLE_PLANNED_STATE,
  DeliverableCompositionDefect,
  JOB_COMPOSITION_PENDING_EVENT_TYPE,
  computeDeliverableInputFingerprint,
} from "@app/domain";
import { createDeliverableCompositionPlanRepository } from "@app/database";
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
  DIGEST,
  NEWER_DIGEST,
  SIZE,
  makeCurrentDeliverable,
  seedPlanChain,
  worldSnapshot,
  type ChainOptions,
  type PlanChain,
} from "./deliverable-composition-fixture";

/**
 * Transaction I against live PostgreSQL.
 *
 * The unit suite proves the fingerprint is a function. What only a database can
 * prove is that the SQL agrees: that the per-Scene authorities are actually in
 * the predicates, that a version and its input rows and the Job move as one row
 * set or not at all, that a rolled-back admission leaves *nothing* behind — not
 * even an event — and that the customer's current deliverable pointer is exactly
 * where it was before.
 *
 * Nothing here composes anything. No `ffmpeg`, no `ffprobe`, no object store.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const repository = createDeliverableCompositionPlanRepository(prisma);

let versionSeq = 0;

async function admit(jobId: string, organizationId = ORG_A) {
  versionSeq += 1;
  return repository.admitCompositionPlan({
    organizationId,
    generationJobId: jobId,
    deliverableVersionId: `gdv_itest_${versionSeq}`,
    context: ctx(),
  });
}

async function job(jobId: string) {
  return prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
}

async function inputsOf(versionId: string) {
  return prisma.generationDeliverableInput.findMany({
    where: { deliverableVersionId: versionId },
    orderBy: { position: "asc" },
  });
}

async function eventsFor(aggregateId: string) {
  return prisma.generationTransitionEvent.findMany({
    where: { aggregateId },
    orderBy: { sequence: "asc" },
  });
}

/** The fingerprint the chain's own durable rows say the plan must carry. */
function expectedFingerprint(
  chain: PlanChain,
  target: { targetOutputResolution: string; targetAspectRatio: string; requestedDurationSeconds: number },
) {
  return computeDeliverableInputFingerprint(
    target,
    chain.scenes.map((scene) => ({
      position: scene.position,
      generationSceneId: scene.sceneId,
      sceneGenerationRequestId: scene.requestId,
      sceneGenerationAttemptId: scene.attemptId,
      mediaValidationId: scene.validationId,
      sourceSha256: DIGEST,
      sourceSizeBytes: BigInt(SIZE),
    })),
  );
}

const TARGET = {
  targetOutputResolution: "1080p",
  targetAspectRatio: "16:9",
  requestedDurationSeconds: 60,
};

RUN("deliverable composition plan admission (Transaction I)", () => {
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
  describe("the two legitimate composition cycles", () => {
    it("admits ordinal 1 for an initial composition", async () => {
      const chain = await seedPlanChain(prisma);
      const result = await admit(chain.jobId);

      expect(result.kind).toBe("PLANNED");
      if (result.kind !== "PLANNED") return;
      expect(result.ordinal).toBe(1);
      expect(result.inputFingerprint).toBe(expectedFingerprint(chain, TARGET));

      const after = await job(chain.jobId);
      expect(after.state).toBe("COMPOSITION_PENDING");
      // The whole point of Phase 5A's restraint: nothing was published.
      expect(after.currentDeliverableVersionId).toBeNull();

      const inputs = await inputsOf(result.deliverableVersionId);
      expect(inputs.map((row) => row.position)).toEqual([0, 1]);
      expect(inputs.map((row) => row.generationSceneId)).toEqual(
        chain.scenes.map((scene) => scene.sceneId),
      );
      expect(inputs.map((row) => row.sceneGenerationRequestId)).toEqual(
        chain.scenes.map((scene) => scene.requestId),
      );
      expect(inputs.map((row) => row.sceneGenerationAttemptId)).toEqual(
        chain.scenes.map((scene) => scene.attemptId),
      );
      expect(inputs.map((row) => row.mediaValidationId)).toEqual(
        chain.scenes.map((scene) => scene.validationId),
      );
      expect(inputs.every((row) => row.sourceSha256 === DIGEST)).toBe(true);
      expect(inputs.every((row) => row.sourceSizeBytes === BigInt(SIZE))).toBe(true);
    });

    it("admits the next ordinal for a recomposition, keeping the previous pointer", async () => {
      const chain = await seedPlanChain(prisma, { reservationState: "CONSUMED" });
      const previous = await makeCurrentDeliverable(prisma, chain.jobId, "sha256:deliverable-input:v1:prior");

      const result = await admit(chain.jobId);
      expect(result.kind).toBe("PLANNED");
      if (result.kind !== "PLANNED") return;
      expect(result.ordinal).toBe(2);

      const after = await job(chain.jobId);
      expect(after.state).toBe("COMPOSITION_PENDING");
      // The customer keeps the video they already have, through
      // COMPOSITION_PENDING, COMPOSING and DELIVERABLE_VALIDATING alike.
      expect(after.currentDeliverableVersionId).toBe(previous);
      expect(after.currentDeliverableVersionId).not.toBe(result.deliverableVersionId);
    });

    it("makes the new plan discoverable by job and highest ordinal", async () => {
      const chain = await seedPlanChain(prisma, { reservationState: "CONSUMED" });
      await makeCurrentDeliverable(prisma, chain.jobId, "sha256:deliverable-input:v1:prior");
      const result = await admit(chain.jobId);
      if (result.kind !== "PLANNED") throw new Error(result.kind);

      const newest = await prisma.generationDeliverableVersion.findFirstOrThrow({
        where: { generationJobId: chain.jobId },
        orderBy: { ordinal: "desc" },
      });
      expect(newest.id).toBe(result.deliverableVersionId);
      expect(newest.ordinal).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  describe("the reservation and the pointer must describe one cycle", () => {
    const refused: readonly [string, ChainOptions, boolean][] = [
      ["no pointer with a CONSUMED hold", { reservationState: "CONSUMED" }, false],
      ["a pointer with a RESERVED hold", { reservationState: "RESERVED" }, true],
      ["RECONCILIATION_HOLD", { reservationState: "RECONCILIATION_HOLD" }, false],
      ["RELEASED", { reservationState: "RELEASED" }, false],
      ["RESERVING", { reservationState: "RESERVING" }, false],
    ];
    for (const [name, options, withPointer] of refused) {
      it(`refuses ${name}`, async () => {
        const chain = await seedPlanChain(prisma, options);
        if (withPointer) {
          await makeCurrentDeliverable(prisma, chain.jobId, "sha256:deliverable-input:v1:prior");
        }
        expect((await admit(chain.jobId)).kind).toBe("NOT_ELIGIBLE");
        expect(await prisma.generationDeliverableInput.count()).toBe(0);
      });
    }

    it("refuses a job with no reservation at all", async () => {
      const chain = await seedPlanChain(prisma);
      await prisma.generationReservation.delete({ where: { id: chain.reservationId } });
      expect((await admit(chain.jobId)).kind).toBe("NOT_ELIGIBLE");
    });
  });

  // -----------------------------------------------------------------------
  describe("every scene must prove itself, or the whole plan fails closed", () => {
    const refusals: readonly [string, ChainOptions["scenes"]][] = [
      ["a scene that is not READY", { 1: { sceneState: "REVISING" } }],
      ["a scene with no delivered pointer", { 1: { noDeliveredPointer: true } }],
      ["a selected request that is not DELIVERED", { 1: { requestState: "GENERATING" } }],
      ["a latest attempt that is not OUTPUT_VERIFIED", { 1: { orchestrationState: "PROCESSING" } }],
      ["a superseded attempt", { 1: { supersede: true } }],
      ["a validation that is still PENDING", { 1: { validation: "PENDING" } }],
      ["a validation that is still RUNNING", { 1: { validation: "RUNNING" } }],
      ["an INVALID_MEDIA verdict", { 1: { validation: "INVALID_MEDIA" } }],
      ["an INTEGRITY_MISMATCH verdict", { 1: { validation: "INTEGRITY_MISMATCH" } }],
      ["no validation record at all", { 1: { validation: "NONE" } }],
    ];
    for (const [name, scenes] of refusals) {
      it(`refuses ${name}, and plans nothing at all`, async () => {
        const chain = await seedPlanChain(prisma, { scenes });
        const before = await worldSnapshot(prisma);

        expect((await admit(chain.jobId)).kind).toBe("NOT_ELIGIBLE");

        // Not "plans the other scene": a deliverable missing a scene the
        // customer paid for is worse than no deliverable.
        expect(await prisma.generationDeliverableVersion.count()).toBe(0);
        expect(await prisma.generationDeliverableInput.count()).toBe(0);
        expect((await job(chain.jobId)).state).toBe("SCENES_READY");
        expect(await worldSnapshot(prisma)).toEqual(before);
      });
    }

    it("raises a fixed defect when a verdict is bound to different bytes", async () => {
      const chain = await seedPlanChain(prisma, {
        scenes: { 1: { receiptSha256: "d".repeat(64) } },
      });
      const before = await worldSnapshot(prisma);

      await expect(admit(chain.jobId)).rejects.toBeInstanceOf(DeliverableCompositionDefect);
      await expect(admit(chain.jobId)).rejects.toMatchObject({
        code: "SOURCE_RECEIPT_BINDING_CONFLICT",
      });
      expect(await worldSnapshot(prisma)).toEqual(before);
    });

    it("raises the same defect when only the receipt size disagrees", async () => {
      const chain = await seedPlanChain(prisma, {
        scenes: { 0: { receiptSizeBytes: SIZE + 1 } },
      });
      await expect(admit(chain.jobId)).rejects.toMatchObject({
        code: "SOURCE_RECEIPT_BINDING_CONFLICT",
      });
    });
  });

  // -----------------------------------------------------------------------
  describe("the job state gate", () => {
    for (const state of [
      "CREATED",
      "RESERVED",
      "GENERATING",
      "COMPOSING",
      "DELIVERABLE_READY",
      "REVISING",
      "FAILED_TERMINAL",
      "CANCELLED",
    ]) {
      it(`refuses a job in ${state}`, async () => {
        const chain = await seedPlanChain(prisma, { jobState: state });
        expect((await admit(chain.jobId)).kind).toBe("NOT_ELIGIBLE");
        expect(await prisma.generationDeliverableVersion.count()).toBe(0);
      });
    }

    it("reports a job with no scenes as not found rather than planning an empty video", async () => {
      const chain = await seedPlanChain(prisma, { sceneCount: 0 });
      expect((await admit(chain.jobId)).kind).toBe("NOT_FOUND");
    });
  });

  // -----------------------------------------------------------------------
  describe("the scene input authority is the delivered pointer", () => {
    it("selects the pointed-at request even when a newer request exists", async () => {
      const chain = await seedPlanChain(prisma, { sceneCount: 1 });
      const scene = chain.scenes[0]!;
      // A later regeneration that was rolled back: newer by createdAt, newer by
      // regeneration ordinal, and emphatically not what the customer holds.
      await prisma.sceneGenerationRequest.create({
        data: {
          id: `${scene.requestId}_rolled_back`,
          generationSceneId: scene.sceneId,
          kind: "USER_REGENERATION",
          userRegenerationOrdinal: 1,
          state: "FAILED_TERMINAL",
          requestedByUserId: "usr_itest",
          failedAt: new Date("2026-09-10T00:00:00.000Z"),
        },
      });

      const result = await admit(chain.jobId);
      if (result.kind !== "PLANNED") throw new Error(result.kind);
      const inputs = await inputsOf(result.deliverableVersionId);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.sceneGenerationRequestId).toBe(scene.requestId);
    });

    it("selects the latest attempt by ordinal, not by timestamp", async () => {
      // The newer attempt by ordinal is the *older* one by `createdAt`, so the
      // two authorities disagree and the plan says which was used. Both are
      // fully composable, which is what makes this a positive assertion rather
      // than one more refusal.
      const chain = await seedPlanChain(prisma, {
        sceneCount: 1,
        scenes: { 0: { supersededByValid: true } },
      });
      const scene = chain.scenes[0]!;
      const result = await admit(chain.jobId);
      if (result.kind !== "PLANNED") throw new Error(result.kind);

      const inputs = await inputsOf(result.deliverableVersionId);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.sceneGenerationAttemptId).toBe(`${scene.attemptId}_v`);
      expect(inputs[0]!.mediaValidationId).toBe(`${scene.validationId}_v`);
      expect(inputs[0]!.sourceSha256).toBe(NEWER_DIGEST);
      expect(inputs[0]!.sourceSizeBytes).toBe(BigInt(SIZE + 7));
    });

    it("freezes positions in ascending order regardless of insertion order", async () => {
      const chain = await seedPlanChain(prisma, { sceneCount: 3 });
      const result = await admit(chain.jobId);
      if (result.kind !== "PLANNED") throw new Error(result.kind);
      const inputs = await inputsOf(result.deliverableVersionId);
      expect(inputs.map((row) => row.position)).toEqual([0, 1, 2]);
      // The scene's own position, frozen. Planning never renumbers.
      const scenes = await prisma.generationScene.findMany({
        where: { generationJobId: chain.jobId },
        orderBy: { position: "asc" },
      });
      expect(inputs.map((row) => row.generationSceneId)).toEqual(scenes.map((row) => row.id));
    });
  });

  // -----------------------------------------------------------------------
  describe("the fingerprint witnesses the exact selection", () => {
    it("is stable across two jobs with identical facts but different ids", async () => {
      // Identical *facts* is not identical *ids*: the selection is part of the
      // digest, so two jobs never share a fingerprint.
      const a = await seedPlanChain(prisma);
      const b = await seedPlanChain(prisma);
      const first = await admit(a.jobId);
      const second = await admit(b.jobId);
      if (first.kind !== "PLANNED" || second.kind !== "PLANNED") throw new Error("not planned");
      expect(first.inputFingerprint).not.toBe(second.inputFingerprint);
    });

    it("changes when a source receipt changes", async () => {
      const base = await seedPlanChain(prisma);
      const changed = await seedPlanChain(prisma, { scenes: { 0: { sha256: "e".repeat(64) } } });
      const one = await admit(base.jobId);
      const two = await admit(changed.jobId);
      if (one.kind !== "PLANNED" || two.kind !== "PLANNED") throw new Error("not planned");
      // Recomputed from each chain's own rows, so the assertion is about the
      // stored fingerprint rather than about the two happening to differ.
      expect(one.inputFingerprint).toBe(expectedFingerprint(base, TARGET));
      expect(two.inputFingerprint).not.toBe(expectedFingerprint(changed, TARGET));
    });

    for (const [name, override] of [
      ["target resolution", { targetOutputResolution: "720p" }],
      ["target aspect ratio", { targetAspectRatio: "9:16" }],
      ["requested duration", { requestedDurationSeconds: 45 }],
    ] as const) {
      it(`changes when the job's ${name} differs`, async () => {
        const chain = await seedPlanChain(prisma, override);
        const result = await admit(chain.jobId);
        if (result.kind !== "PLANNED") throw new Error(result.kind);
        expect(result.inputFingerprint).toBe(
          expectedFingerprint(chain, { ...TARGET, ...override }),
        );
        expect(result.inputFingerprint).not.toBe(expectedFingerprint(chain, TARGET));
      });
    }

    it("is stored on the version exactly as returned", async () => {
      const chain = await seedPlanChain(prisma);
      const result = await admit(chain.jobId);
      if (result.kind !== "PLANNED") throw new Error(result.kind);
      const row = await prisma.generationDeliverableVersion.findUniqueOrThrow({
        where: { id: result.deliverableVersionId },
      });
      expect(row.inputFingerprint).toBe(result.inputFingerprint);
      expect(row.inputFingerprint).toMatch(/^sha256:deliverable-input:v1:[0-9a-f]{64}$/);
    });
  });

  // -----------------------------------------------------------------------
  describe("idempotency", () => {
    it("returns the same version on replay, writing nothing further", async () => {
      const chain = await seedPlanChain(prisma);
      const first = await admit(chain.jobId);
      if (first.kind !== "PLANNED") throw new Error(first.kind);
      const after = await worldSnapshot(prisma);

      const replay = await admit(chain.jobId);
      expect(replay.kind).toBe("ALREADY_PLANNED");
      if (replay.kind !== "ALREADY_PLANNED") return;
      expect(replay.deliverableVersionId).toBe(first.deliverableVersionId);
      expect(replay.ordinal).toBe(1);
      expect(replay.inputFingerprint).toBe(first.inputFingerprint);

      // No second version, no extra inputs, no duplicate events, no ordinal
      // increment.
      expect(await worldSnapshot(prisma)).toEqual(after);
    });

    it("stays idempotent across many replays", async () => {
      const chain = await seedPlanChain(prisma);
      await admit(chain.jobId);
      const after = await worldSnapshot(prisma);
      for (let i = 0; i < 3; i += 1) {
        expect((await admit(chain.jobId)).kind).toBe("ALREADY_PLANNED");
      }
      expect(await worldSnapshot(prisma)).toEqual(after);
      expect(await prisma.generationDeliverableVersion.count()).toBe(1);
    });

    it("fails closed when a pending job has no plan behind it", async () => {
      const chain = await seedPlanChain(prisma, { jobState: "COMPOSITION_PENDING" });
      await expect(admit(chain.jobId)).rejects.toMatchObject({ code: "PARTIAL_PLAN_STATE" });
    });

    it("fails closed when the stored plan is missing a scene", async () => {
      const chain = await seedPlanChain(prisma);
      const first = await admit(chain.jobId);
      if (first.kind !== "PLANNED") throw new Error(first.kind);
      // Half a plan. Nothing in the application can produce this, which is
      // exactly why it is reported rather than rebuilt.
      await prisma.generationDeliverableInput.deleteMany({
        where: { deliverableVersionId: first.deliverableVersionId, position: 1 },
      });
      await expect(admit(chain.jobId)).rejects.toMatchObject({ code: "PARTIAL_PLAN_STATE" });
    });

    it("fails closed when the stored fingerprint no longer describes its own inputs", async () => {
      const chain = await seedPlanChain(prisma);
      const first = await admit(chain.jobId);
      if (first.kind !== "PLANNED") throw new Error(first.kind);
      await prisma.generationDeliverableVersion.update({
        where: { id: first.deliverableVersionId },
        data: { inputFingerprint: "sha256:deliverable-input:v1:" + "0".repeat(64) },
      });
      await expect(admit(chain.jobId)).rejects.toMatchObject({ code: "PARTIAL_PLAN_STATE" });
    });

    it("fails closed when the stored plan covers a scene the job does not have", async () => {
      const chain = await seedPlanChain(prisma);
      const first = await admit(chain.jobId);
      if (first.kind !== "PLANNED") throw new Error(first.kind);
      // A third scene appears after planning. The stored plan no longer covers
      // the job.
      const other = await seedPlanChain(prisma, { sceneCount: 1 });
      await prisma.generationScene.update({
        where: { id: other.scenes[0]!.sceneId },
        data: { generationJobId: chain.jobId, position: 9 },
      });
      await expect(admit(chain.jobId)).rejects.toMatchObject({ code: "PARTIAL_PLAN_STATE" });
    });
  });

  // -----------------------------------------------------------------------
  describe("history and events", () => {
    it("appends exactly one deliverable event and one job event", async () => {
      const chain = await seedPlanChain(prisma);
      const result = await admit(chain.jobId);
      if (result.kind !== "PLANNED") throw new Error(result.kind);

      const deliverable = await eventsFor(result.deliverableVersionId);
      expect(deliverable).toHaveLength(1);
      expect(deliverable[0]!.aggregateType).toBe("DELIVERABLE");
      expect(deliverable[0]!.fromState).toBeNull();
      expect(deliverable[0]!.toState).toBe(DELIVERABLE_PLANNED_STATE);
      expect(deliverable[0]!.eventType).toBe(DELIVERABLE_PLANNED_EVENT_TYPE);
      expect(deliverable[0]!.reasonCode).toBe(COMPOSITION_PLAN_REASON_CODE);
      expect(deliverable[0]!.organizationId).toBe(ORG_A);

      const jobEvents = await eventsFor(chain.jobId);
      expect(jobEvents).toHaveLength(1);
      expect(jobEvents[0]!.aggregateType).toBe("JOB");
      expect(jobEvents[0]!.fromState).toBe("SCENES_READY");
      expect(jobEvents[0]!.toState).toBe("COMPOSITION_PENDING");
      expect(jobEvents[0]!.eventType).toBe(JOB_COMPOSITION_PENDING_EVENT_TYPE);
      expect(jobEvents[0]!.reasonCode).toBe(COMPOSITION_PLAN_REASON_CODE);
    });

    it("carries no prompt, storage key, provider detail or digest in metadata", async () => {
      const chain = await seedPlanChain(prisma);
      const result = await admit(chain.jobId);
      if (result.kind !== "PLANNED") throw new Error(result.kind);
      const events = await prisma.generationTransitionEvent.findMany({});
      for (const event of events) {
        const json = JSON.stringify(event.safeMetadata);
        expect(json).not.toContain("sunlit");
        expect(json).not.toContain("org/");
        expect(json).not.toContain(DIGEST);
        expect(json).not.toContain("wavespeed");
      }
    });

    it("mutates no source history row", async () => {
      const chain = await seedPlanChain(prisma);
      const before = await worldSnapshot(prisma);
      const result = await admit(chain.jobId);
      if (result.kind !== "PLANNED") throw new Error(result.kind);
      const after = await worldSnapshot(prisma);

      expect(after.requests).toEqual(before.requests);
      expect(after.attempts).toEqual(before.attempts);
      expect(after.validations).toEqual(before.validations);
      // The hold is read-only evidence here.
      expect(after.reservations).toEqual(before.reservations);
      expect(after.scenes).toEqual(before.scenes);
    });
  });

  // -----------------------------------------------------------------------
  describe("tenancy", () => {
    it("reports another organization's job as not found", async () => {
      const chain = await seedPlanChain(prisma);
      expect((await admit(chain.jobId, ORG_B)).kind).toBe("NOT_FOUND");
      expect(await prisma.generationDeliverableVersion.count()).toBe(0);
      expect((await job(chain.jobId)).state).toBe("SCENES_READY");
    });

    it("reports an unknown job exactly as a cross-tenant one", async () => {
      expect((await admit("genjob_does_not_exist")).kind).toBe("NOT_FOUND");
    });

    it("admits the same job for its own organization", async () => {
      const chain = await seedPlanChain(prisma, { organizationId: ORG_B });
      expect((await admit(chain.jobId, ORG_A)).kind).toBe("NOT_FOUND");
      expect((await admit(chain.jobId, ORG_B)).kind).toBe("PLANNED");
    });
  });
});
