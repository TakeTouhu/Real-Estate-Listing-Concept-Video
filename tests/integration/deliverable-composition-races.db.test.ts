import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { computeDeliverableInputFingerprint } from "@app/domain";
import {
  createDeliverableCompositionPlanRepository,
  createGenerationJobRepository,
  createSceneGenerationRequestRepository,
} from "@app/database";
import {
  ctx,
  dropTenants,
  HAS_DB,
  ORG_A,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";
import {
  makeCurrentDeliverable,
  seedPlanChain,
  type PlanChain,
} from "./deliverable-composition-fixture";

/**
 * The races composition admission must not lose, against live PostgreSQL.
 *
 * Two contenders matter, and they are proved differently:
 *
 * **Two admitters.** Exactly one deliverable version is created and exactly one
 * Job moves. The loser answers `ALREADY_PLANNED`, never a raw uniqueness error.
 *
 * **A concurrent revision start.** The dangerous outcome would be a plan
 * committed from a Scene selection that a revision replaced underneath it. It
 * cannot happen, and the reason is stronger than "the lock is held": the two
 * authorities require *disjoint* Job states — planning needs `SCENES_READY`,
 * revision start needs `DELIVERABLE_READY` — and both take the same Job row lock
 * first. So whichever state the Job is committed in, exactly one of the two can
 * proceed and the other is refused by state. Both directions are proved here.
 *
 * No `sleep` is used as a synchronization authority. Ordering is established
 * with a real row lock held by a third connection, and with `pg_stat_activity`
 * showing the contenders genuinely blocked before the barrier is released.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();

/** How many backends are currently waiting on a lock in this database. */
async function blockedBackends(client: PrismaClient): Promise<number> {
  const rows = await client.$queryRawUnsafe<{ wait_event_type: string | null }[]>(
    `SELECT wait_event_type FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`,
  );
  return rows.filter((r) => r.wait_event_type === "Lock").length;
}

async function waitForBlocked(client: PrismaClient, count: number): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if ((await blockedBackends(client)) >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/**
 * Hold the Job row exclusively on a connection of its own.
 *
 * The barrier every contender in this file queues behind: each takes
 * `FOR UPDATE` on the same Job row as its first act, so none can start until
 * this releases. Without it, one contender can simply finish before the other
 * begins and nothing was raced.
 */
async function jobBarrier(jobId: string) {
  const holder = new PrismaClient();
  let release: () => void = () => undefined;
  const mayFinish = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const done = holder
    .$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "generation_jobs" WHERE "id" = ${jobId} FOR UPDATE`;
        ready();
        await mayFinish;
      },
      { timeout: 30_000 },
    )
    .catch(() => undefined);
  await held;
  return {
    release: async () => {
      release();
      await done;
      await holder.$disconnect();
    },
  };
}

function settled<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function fingerprintOf(chain: PlanChain, sha256: string, sizeBytes: number) {
  return computeDeliverableInputFingerprint(
    {
      targetOutputResolution: "1080p",
      targetAspectRatio: "16:9",
      requestedDurationSeconds: 60,
    },
    chain.scenes.map((scene) => ({
      position: scene.position,
      generationSceneId: scene.sceneId,
      sceneGenerationRequestId: scene.requestId,
      sceneGenerationAttemptId: scene.attemptId,
      mediaValidationId: scene.validationId,
      sourceSha256: sha256,
      sourceSizeBytes: BigInt(sizeBytes),
    })),
  );
}

RUN("composition admission under contention", () => {
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

  it("creates exactly one deliverable version when two workers admit at once", async () => {
    const chain = await seedPlanChain(prisma);
    const workerA = new PrismaClient();
    const workerB = new PrismaClient();
    const barrier = await jobBarrier(chain.jobId);

    const a = settled(
      createDeliverableCompositionPlanRepository(workerA).admitCompositionPlan({
        organizationId: ORG_A,
        generationJobId: chain.jobId,
        deliverableVersionId: "gdv_race_a",
        context: ctx({ correlationId: "corr_race_a" }),
      }),
    );
    const b = settled(
      createDeliverableCompositionPlanRepository(workerB).admitCompositionPlan({
        organizationId: ORG_A,
        generationJobId: chain.jobId,
        deliverableVersionId: "gdv_race_b",
        context: ctx({ correlationId: "corr_race_b" }),
      }),
    );

    // Both must actually be queued on the Job row before it is released.
    expect(await waitForBlocked(prisma, 2)).toBe(true);
    await barrier.release();

    const [first, second] = await Promise.all([a, b]);
    await workerA.$disconnect();
    await workerB.$disconnect();

    // Neither raises. A uniqueness error escaping to the caller would be the
    // failure: the outcome union is the contract, not a Prisma code.
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const kinds = [first.value.kind, second.value.kind].sort();
    expect(kinds).toEqual(["ALREADY_PLANNED", "PLANNED"]);

    const versions = await prisma.generationDeliverableVersion.findMany({
      where: { generationJobId: chain.jobId },
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.ordinal).toBe(1);

    // And the loser reported the winner's version, not its own proposed id.
    const [winner, loser] =
      first.value.kind === "PLANNED"
        ? ([first.value, second.value] as const)
        : ([second.value, first.value] as const);
    if (winner.kind !== "PLANNED" || loser.kind !== "ALREADY_PLANNED") {
      throw new Error(`${winner.kind}/${loser.kind}`);
    }
    expect(loser.deliverableVersionId).toBe(winner.deliverableVersionId);
    expect(loser.deliverableVersionId).toBe(versions[0]!.id);

    // One move, one deliverable event, one job event. No duplicates.
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: chain.jobId } })).state).toBe(
      "COMPOSITION_PENDING",
    );
    expect(
      await prisma.generationTransitionEvent.count({ where: { aggregateId: chain.jobId } }),
    ).toBe(1);
    expect(
      await prisma.generationTransitionEvent.count({ where: { aggregateId: versions[0]!.id } }),
    ).toBe(1);
    expect(
      await prisma.generationDeliverableInput.count({
        where: { deliverableVersionId: versions[0]!.id },
      }),
    ).toBe(chain.scenes.length);
  });

  // -------------------------------------------------------------------------

  describe("against a concurrent revision start", () => {
    it("admits the plan and refuses the revision when the job is SCENES_READY", async () => {
      const chain = await seedPlanChain(prisma);
      const scene = chain.scenes[0]!;
      const before = await prisma.generationScene.findUniqueOrThrow({ where: { id: scene.sceneId } });

      const planner = new PrismaClient();
      const reviser = new PrismaClient();
      const barrier = await jobBarrier(chain.jobId);

      const plan = settled(
        createDeliverableCompositionPlanRepository(planner).admitCompositionPlan({
          organizationId: ORG_A,
          generationJobId: chain.jobId,
          deliverableVersionId: "gdv_race_plan",
          context: ctx({ correlationId: "corr_plan" }),
        }),
      );
      const revision = settled(
        createSceneGenerationRequestRepository(reviser).admitUserRegeneration(
          ORG_A,
          {
            id: "genreq_race_regen",
            generationSceneId: scene.sceneId,
            requestedByUserId: "usr_itest",
          },
          ctx({ correlationId: "corr_regen" }),
        ),
      );

      expect(await waitForBlocked(prisma, 2)).toBe(true);
      await barrier.release();

      const [planned, revised] = await Promise.all([plan, revision]);
      await planner.$disconnect();
      await reviser.$disconnect();

      expect(planned.ok && revised.ok).toBe(true);
      if (!planned.ok || !revised.ok) return;
      expect(planned.value.kind).toBe("PLANNED");
      // Refused by *state*, not by luck: a job that never delivered has nothing
      // to revise.
      expect(revised.value.kind).toBe("JOB_NOT_REVISABLE");

      // The selection the plan froze is exactly the one still committed.
      const after = await prisma.generationScene.findUniqueOrThrow({
        where: { id: scene.sceneId },
      });
      expect(after.state).toBe("READY");
      expect(after.currentDeliveredRequestId).toBe(before.currentDeliveredRequestId);
      const inputs = await prisma.generationDeliverableInput.findMany({
        where: { generationSceneId: scene.sceneId },
      });
      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.sceneGenerationRequestId).toBe(after.currentDeliveredRequestId);
    });

    it("admits the revision and refuses the plan when the job is DELIVERABLE_READY", async () => {
      const chain = await seedPlanChain(prisma, {
        jobState: "DELIVERABLE_READY",
        reservationState: "CONSUMED",
        sceneCount: 1,
      });
      await makeCurrentDeliverable(prisma, chain.jobId, fingerprintOf(chain, "c".repeat(64), 9_876_543));
      const scene = chain.scenes[0]!;

      const planner = new PrismaClient();
      const reviser = new PrismaClient();
      const barrier = await jobBarrier(chain.jobId);

      const plan = settled(
        createDeliverableCompositionPlanRepository(planner).admitCompositionPlan({
          organizationId: ORG_A,
          generationJobId: chain.jobId,
          deliverableVersionId: "gdv_race_plan2",
          context: ctx({ correlationId: "corr_plan2" }),
        }),
      );
      const revision = settled(
        createSceneGenerationRequestRepository(reviser).admitUserRegeneration(
          ORG_A,
          {
            id: "genreq_race_regen2",
            generationSceneId: scene.sceneId,
            requestedByUserId: "usr_itest",
          },
          ctx({ correlationId: "corr_regen2" }),
        ),
      );

      expect(await waitForBlocked(prisma, 2)).toBe(true);
      await barrier.release();

      const [planned, revised] = await Promise.all([plan, revision]);
      await planner.$disconnect();
      await reviser.$disconnect();

      expect(planned.ok && revised.ok).toBe(true);
      if (!planned.ok || !revised.ok) return;
      expect(revised.value.kind).toBe("ADMITTED");
      expect(planned.value.kind).toBe("NOT_ELIGIBLE");

      // No plan exists at all, so none can have been frozen from the pointer the
      // revision was in the middle of replacing.
      const scenes = await prisma.generationScene.findUniqueOrThrow({
        where: { id: scene.sceneId },
      });
      expect(scenes.state).toBe("REVISING");
      expect(
        await prisma.generationDeliverableVersion.count({
          where: { generationJobId: chain.jobId, ordinal: { gt: 1 } },
        }),
      ).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------

RUN("the current deliverable pointer, at PostgreSQL level", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  it("accepts a version belonging to the same job", async () => {
    const chain = await seedPlanChain(prisma);
    const id = await makeCurrentDeliverable(prisma, chain.jobId, "sha256:deliverable-input:v1:x");
    const after = await prisma.generationJob.findUniqueOrThrow({ where: { id: chain.jobId } });
    expect(after.currentDeliverableVersionId).toBe(id);
  });

  it("rejects another job's deliverable version", async () => {
    const mine = await seedPlanChain(prisma);
    const theirs = await seedPlanChain(prisma);
    await prisma.generationDeliverableVersion.create({
      data: {
        id: "gdv_foreign",
        generationJobId: theirs.jobId,
        ordinal: 1,
        inputFingerprint: "sha256:deliverable-input:v1:y",
      },
    });
    // The whole point of the composite key: a single-column foreign key would
    // accept this, and one customer's video would be composed of another's.
    await expect(
      prisma.generationJob.update({
        where: { id: mine.jobId },
        data: { currentDeliverableVersionId: "gdv_foreign" },
      }),
    ).rejects.toThrow();
  });

  it("rejects a version id that does not exist", async () => {
    const chain = await seedPlanChain(prisma);
    await expect(
      prisma.generationJob.update({
        where: { id: chain.jobId },
        data: { currentDeliverableVersionId: "gdv_nowhere" },
      }),
    ).rejects.toThrow();
  });

  it("refuses to delete the version a job currently points at", async () => {
    const chain = await seedPlanChain(prisma);
    const id = await makeCurrentDeliverable(prisma, chain.jobId, "sha256:deliverable-input:v1:z");
    await expect(
      prisma.generationDeliverableVersion.delete({ where: { id } }),
    ).rejects.toThrow();
  });

  it("keeps a non-current historical version durable", async () => {
    const chain = await seedPlanChain(prisma, { reservationState: "CONSUMED" });
    const previous = await makeCurrentDeliverable(prisma, chain.jobId, "sha256:deliverable-input:v1:p");
    const result = await createDeliverableCompositionPlanRepository(prisma).admitCompositionPlan({
      organizationId: ORG_A,
      generationJobId: chain.jobId,
      deliverableVersionId: "gdv_hist_next",
      context: ctx(),
    });
    expect(result.kind).toBe("PLANNED");
    // Ordinal 1 is nobody's plan any more and still exists, with its own rows.
    const all = await prisma.generationDeliverableVersion.findMany({
      where: { generationJobId: chain.jobId },
      orderBy: { ordinal: "asc" },
    });
    expect(all.map((row) => row.id)).toEqual([previous, "gdv_hist_next"]);
  });

  it("leaves a null pointer valid for an initial composition", async () => {
    const chain = await seedPlanChain(prisma);
    const result = await createDeliverableCompositionPlanRepository(prisma).admitCompositionPlan({
      organizationId: ORG_A,
      generationJobId: chain.jobId,
      deliverableVersionId: "gdv_null_ptr",
      context: ctx(),
    });
    expect(result.kind).toBe("PLANNED");
    const after = await prisma.generationJob.findUniqueOrThrow({ where: { id: chain.jobId } });
    expect(after.currentDeliverableVersionId).toBeNull();
  });

  it("refuses an ordinal below one", async () => {
    const chain = await seedPlanChain(prisma);
    await expect(
      prisma.generationDeliverableVersion.create({
        data: {
          id: "gdv_zero",
          generationJobId: chain.jobId,
          ordinal: 0,
          inputFingerprint: "sha256:deliverable-input:v1:q",
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses a second version at the same ordinal", async () => {
    const chain = await seedPlanChain(prisma);
    await makeCurrentDeliverable(prisma, chain.jobId, "sha256:deliverable-input:v1:r");
    await expect(
      prisma.generationDeliverableVersion.create({
        data: {
          id: "gdv_dup_ordinal",
          generationJobId: chain.jobId,
          ordinal: 1,
          inputFingerprint: "sha256:deliverable-input:v1:s",
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses the same scene twice in one plan", async () => {
    const chain = await seedPlanChain(prisma, { sceneCount: 1 });
    const result = await createDeliverableCompositionPlanRepository(prisma).admitCompositionPlan({
      organizationId: ORG_A,
      generationJobId: chain.jobId,
      deliverableVersionId: "gdv_dup_scene",
      context: ctx(),
    });
    expect(result.kind).toBe("PLANNED");
    const scene = chain.scenes[0]!;
    await expect(
      prisma.generationDeliverableInput.create({
        data: {
          id: "gdvin_dup",
          deliverableVersionId: "gdv_dup_scene",
          position: 5,
          generationSceneId: scene.sceneId,
          sceneGenerationRequestId: scene.requestId,
          sceneGenerationAttemptId: scene.attemptId,
          mediaValidationId: scene.validationId,
          sourceSha256: "c".repeat(64),
          sourceSizeBytes: BigInt(9_876_543),
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses two inputs at the same position in one plan", async () => {
    const chain = await seedPlanChain(prisma, { sceneCount: 2 });
    const result = await createDeliverableCompositionPlanRepository(prisma).admitCompositionPlan({
      organizationId: ORG_A,
      generationJobId: chain.jobId,
      deliverableVersionId: "gdv_dup_pos",
      context: ctx(),
    });
    expect(result.kind).toBe("PLANNED");
    await expect(
      prisma.generationDeliverableInput.updateMany({
        where: { deliverableVersionId: "gdv_dup_pos", position: 1 },
        data: { position: 0 },
      }),
    ).rejects.toThrow();
  });

  it("refuses deleting a scene, request, attempt or verdict a plan froze", async () => {
    const chain = await seedPlanChain(prisma, { sceneCount: 1 });
    const result = await createDeliverableCompositionPlanRepository(prisma).admitCompositionPlan({
      organizationId: ORG_A,
      generationJobId: chain.jobId,
      deliverableVersionId: "gdv_restrict",
      context: ctx(),
    });
    expect(result.kind).toBe("PLANNED");
    const scene = chain.scenes[0]!;
    // RESTRICT, not CASCADE, on all four: this is paid generated history.
    await expect(
      prisma.managedOutputMediaValidation.delete({ where: { id: scene.validationId } }),
    ).rejects.toThrow();
    await expect(
      prisma.sceneGeneration.delete({ where: { id: scene.attemptId } }),
    ).rejects.toThrow();
    await expect(
      prisma.sceneGenerationRequest.delete({ where: { id: scene.requestId } }),
    ).rejects.toThrow();
    await expect(
      prisma.generationScene.delete({ where: { id: scene.sceneId } }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

RUN("the generic job transition API refuses the delivery pipeline", () => {
  const jobs = createGenerationJobRepository(prisma);

  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  const reserved: readonly [string, string][] = [
    ["SCENES_READY", "COMPOSITION_PENDING"],
    ["COMPOSITION_PENDING", "COMPOSING"],
    ["COMPOSING", "DELIVERABLE_VALIDATING"],
    ["DELIVERABLE_VALIDATING", "DELIVERABLE_READY"],
  ];

  for (const [from, to] of reserved) {
    it(`reserves ${from} -> ${to}`, async () => {
      const chain = await seedPlanChain(prisma, { jobState: from });
      const before = await prisma.generationJob.findUniqueOrThrow({ where: { id: chain.jobId } });
      const outcome = await jobs.transition({
        organizationId: ORG_A,
        id: chain.jobId,
        expectedState: from as never,
        expectedVersion: before.stateVersion,
        nextState: to as never,
        context: ctx(),
      });
      expect(outcome.kind).toBe("TRANSITION_RESERVED");
      // Reserved means refused, not deferred: nothing moved and nothing was
      // written to history.
      const after = await prisma.generationJob.findUniqueOrThrow({ where: { id: chain.jobId } });
      expect(after.state).toBe(from);
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(
        await prisma.generationTransitionEvent.count({ where: { aggregateId: chain.jobId } }),
      ).toBe(0);
    });
  }
});
