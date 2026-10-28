import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaSceneGenerationExecutionRepository } from "@app/database";
import {
  ASSET_A,
  attemptInput,
  ctx,
  dropTenants,
  fixtureSource,
  HAS_DB,
  ORG_A,
  PROJECT_A,
  repositories,
  seedChain,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * The legacy executor against real orchestrated attempts (ADR-0096).
 *
 * An orchestrated attempt reads `QUEUED` in the legacy `state` column for life,
 * because no orchestration writer moves that column. Only the paid-submission
 * gate may send it, so the legacy executor's discovery, claim and park must
 * each pass it over: otherwise the executor would claim it and send it outside
 * the gate.
 */

const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
/** A second pool, to hold the asset row while the claim runs on the first. */
const holder = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
/** A third, to observe the claim waiting without queuing behind it. */
const observer = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);

const execution = HAS_DB
  ? createPrismaSceneGenerationExecutionRepository(prisma)
  : (null as unknown as ReturnType<typeof createPrismaSceneGenerationExecutionRepository>);

/** An admitted attempt, as the launch commit admits one. */
async function admitted(suffix: string): Promise<string> {
  const chain = await seedChain(prisma, suffix);
  const admission = await repositories(prisma).attempts.admit(
    ORG_A,
    attemptInput({ id: `sgen_${suffix}`, generationSceneRequestId: chain.request.id }),
    ctx(),
  );
  if (admission.kind !== "ADMITTED") throw new Error(`attempt not admitted: ${admission.kind}`);
  return admission.attempt.id;
}

/** A legacy row on the same project and asset: no orchestration columns. */
async function legacy(id: string, createdAt?: Date): Promise<string> {
  await prisma.sceneGeneration.create({
    data: {
      id,
      videoProjectId: PROJECT_A,
      sourceStoryboardSceneId: "sbs_itest_legacy",
      assetId: ASSET_A,
      sourceAnalysisRevision: 1,
      requestHash: `sha256:${id}`,
      providerName: "fake",
      providerModelId: "fake/image-to-video",
      requestCompiledPrompt: '{"preservation":[],"sceneFacts":{},"userCustomization":null}',
      requestDurationSeconds: 5,
      requestCameraMotion: "SLOW_PAN",
      requestAspectRatio: "16:9",
      requestResolution: "1080p",
      requestRenderedPrompt: `frozen:${id}`,
      state: "QUEUED",
      ...(createdAt === undefined ? {} : { createdAt }),
    },
  });
  return id;
}

/**
 * Give a legacy row every orchestration column, underneath the application,
 * which never does: the only way to make a row orchestrated while a claim is
 * already working on it.
 */
async function orchestrate(id: string, requestId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "scene_generations"
       SET "generationSceneRequestId" = ${requestId},
           "attemptOrdinal" = 99,
           "attemptKind" = 'PRIMARY'::"GenerationAttemptKind",
           "submissionCertainty" = 'PRE_SUBMISSION'::"SubmissionCertainty",
           "orchestrationState" = 'QUEUED'::"GenerationAttemptState",
           "pricingContractKey" = 'itest:legacy'
     WHERE "id" = ${id}
  `;
}

/** Hold the fixture asset row on another connection until `release`. */
async function holdAsset() {
  let acquired!: (pid: number) => void;
  let release!: () => void;
  const pid = new Promise<number>((resolve) => {
    acquired = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holding = holder.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "media_assets" WHERE "id" = ${ASSET_A} FOR NO KEY UPDATE`;
      const [self] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      acquired(self!.pid);
      await held;
    },
    { timeout: 20_000 },
  );
  return { pid: await pid, release, holding };
}

/** Resolve once the claim is provably waiting behind `holderPid` on the asset. */
async function waitUntilBlockedBy(holderPid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const blocked = await observer.$queryRaw<{ pid: number }[]>`
      SELECT a.pid
        FROM pg_stat_activity AS a
       WHERE a.datname = current_database()
         AND a.wait_event_type = 'Lock'
         AND ${holderPid}::int = ANY(pg_blocking_pids(a.pid))
         AND a.query LIKE '%media_assets%'`;
    if (blocked.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the claim never blocked on the held asset");
}

async function row(id: string) {
  return prisma.sceneGeneration.findUniqueOrThrow({ where: { id } });
}

describe.skipIf(!HAS_DB)("the legacy executor passes over orchestrated attempts (ADR-0096)", () => {
  beforeEach(async () => {
    await prisma.sceneGeneration.deleteMany({ where: { id: { startsWith: "gen_itest_legacy" } } });
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await prisma.sceneGeneration.deleteMany({ where: { id: { startsWith: "gen_itest_legacy" } } });
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await Promise.all([prisma.$disconnect(), holder.$disconnect(), observer.$disconnect()]);
  });

  it("does not offer an orchestrated attempt, and offers the legacy row behind it", async () => {
    const attemptId = await admitted("lex_find");
    expect((await row(attemptId)).state).toBe("QUEUED");
    const legacyId = await legacy("gen_itest_legacy_find", new Date("2000-01-01T00:00:00.000Z"));
    expect((await execution.findNextQueuedForPreparation())?.generation.id).toBe(legacyId);
    await prisma.sceneGeneration.delete({ where: { id: legacyId } });
    expect((await execution.findNextQueuedForPreparation())?.generation.id).not.toBe(attemptId);
  });

  it("does not claim an orchestrated attempt, and writes nothing", async () => {
    const attemptId = await admitted("lex_claim");
    const before = await row(attemptId);
    expect(await execution.claimPreparedForSubmission(attemptId, fixtureSource(ORG_A))).toEqual({
      kind: "NOT_CLAIMABLE",
    });
    expect(await row(attemptId)).toEqual(before);
  });

  it("does not park an orchestrated attempt, and writes nothing", async () => {
    const attemptId = await admitted("lex_park");
    const before = await row(attemptId);
    expect(await execution.failQueuedPreflight(attemptId, "ASSET_UNRECOVERABLE")).toBeNull();
    expect(await row(attemptId)).toEqual(before);
  });

  it("does not wait on the asset of an orchestrated attempt", async () => {
    const attemptId = await admitted("lex_nowait");
    const hold = await holdAsset();
    try {
      const first = await Promise.race([
        execution.claimPreparedForSubmission(attemptId, fixtureSource(ORG_A)),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 1_500)),
      ]);
      expect(first).toEqual({ kind: "NOT_CLAIMABLE" });
    } finally {
      hold.release();
      await hold.holding;
    }
  });

  it("answers NOT_CLAIMABLE for a row found orchestrated after the asset wait", async () => {
    // The source is broken too, so a verdict on it would read SOURCE_INVALID:
    // the re-read after the lock is what answers.
    const chain = await seedChain(prisma, "lex_late");
    const legacyId = await legacy("gen_itest_legacy_late");
    await prisma.mediaAsset.update({ where: { id: ASSET_A }, data: { sha256: "c3".repeat(32) } });
    const hold = await holdAsset();
    const claiming = execution.claimPreparedForSubmission(legacyId, fixtureSource(ORG_A));
    try {
      await waitUntilBlockedBy(hold.pid);
      await orchestrate(legacyId, chain.request.id);
    } finally {
      hold.release();
      await hold.holding;
    }
    expect(await claiming).toEqual({ kind: "NOT_CLAIMABLE" });
    expect((await row(legacyId)).state).toBe("QUEUED");
  });

  it("does not move a row found orchestrated at the compare-and-swap", async () => {
    const chain = await seedChain(prisma, "lex_cas");
    const legacyId = await legacy("gen_itest_legacy_cas");
    let release!: () => void;
    let arrive!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const atSwap = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    // The claim pauses at its compare-and-swap, after every read, holding the
    // asset row; the row becomes orchestrated meanwhile.
    const paused = holder.$extends({
      query: {
        sceneGeneration: {
          async updateMany({ args, query }) {
            arrive();
            await released;
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const claiming = createPrismaSceneGenerationExecutionRepository(paused).claimPreparedForSubmission(
      legacyId,
      fixtureSource(ORG_A),
    );
    try {
      await atSwap;
      await orchestrate(legacyId, chain.request.id);
    } finally {
      release();
    }
    expect(await claiming).toEqual({ kind: "NOT_CLAIMABLE" });
    expect((await row(legacyId)).state).toBe("QUEUED");
  });
});
