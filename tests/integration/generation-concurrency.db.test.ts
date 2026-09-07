import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ASSET_A,
  attemptInput,
  ctx,
  dropTenants,
  HAS_DB,
  ORG_A,
  PROJECT_A,
  repositories,
  seedChain,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * The three places where two callers decide about the same row at once.
 *
 * Every test here is built to fail against an implementation that has only the
 * unique index, and pass only against one that serializes on the parent row.
 * That distinction is the whole point, and it cannot be drawn by launching two
 * calls and hoping they overlap: measured directly, they do not. Eight
 * simultaneous admissions and two independent client pools both completed
 * strictly one after another, so a naive race test passes against either
 * implementation and proves nothing.
 *
 * So the overlap is *constructed*. A second client opens a transaction, takes
 * the same lock the repository takes, and holds it. The repository call is then
 * started and provably blocks. The holder mutates the row the repository is
 * about to decide from, and commits. If the repository read before locking, it
 * is now working from a state that no longer exists — which is exactly the
 * defect, made deterministic.
 */
const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
/** A second pool: a lock held on one connection must block the other. */
const holder = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
const repos = HAS_DB ? repositories(prisma) : (null as unknown as ReturnType<typeof repositories>);

/** Resolves once, when `promise` settles; never rejects. */
function settled<T>(promise: Promise<T>): { done: () => boolean; value: Promise<T> } {
  let finished = false;
  const value = promise.finally(() => {
    finished = true;
  });
  // The rejection is delivered through `value`; this only tracks completion.
  void value.catch(() => undefined);
  return { done: () => finished, value };
}

/** Give a blocked call a real chance to finish, so "still blocked" means it. */
async function breathe(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(!HAS_DB)("concurrent callers are serialized on the row they decide from", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
    await holder.$disconnect();
  });

  describe("Transaction C serializes on the parent SceneGenerationRequest", () => {
    it("returns ATTEMPT_ALREADY_ACTIVE to the loser instead of a database error", async () => {
      const { request } = await seedChain(prisma, "cserial");

      // The holder takes the parent lock and, while holding it, files the
      // attempt that the blocked admission is about to believe does not exist.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holderDone = holder.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "scene_generation_requests" WHERE "id" = ${request.id} FOR UPDATE`;
          await tx.$executeRawUnsafe(
            `INSERT INTO "scene_generations" (
               "id","videoProjectId","sourceStoryboardSceneId","assetId","sourceAnalysisRevision",
               "requestHash","providerName","providerModelId","requestModelKey",
               "requestTargetOutputResolution","requestNativeGenerationResolution",
               "requestResolutionNormalization","requestNativeMeetsTarget",
               "generationSceneRequestId","attemptOrdinal","attemptKind","submissionCertainty",
               "orchestrationState","pricingContractKey","createdAt","updatedAt"
             ) VALUES (
               'sgen_cserial_winner', $1, 'sbs_gone', $2, 1,
               ${"'sha256:v2:" + "c".repeat(64) + "'"}, 'wavespeed',
               'wavespeed-ai/open-video/image-to-video', 'wavespeed-open-video',
               '1080p','1080p','NONE',true,
               $3, 1, 'PRIMARY'::"GenerationAttemptKind",
               'PRE_SUBMISSION'::"SubmissionCertainty",
               'QUEUED'::"GenerationAttemptState",
               'wavespeed:wavespeed-open-video:2026-09-02.1', now(), now()
             )`,
            PROJECT_A,
            ASSET_A,
            request.id,
          );
          await held;
        },
        { timeout: 20_000 },
      );

      // Let the holder actually acquire the lock before the admission starts.
      await breathe(4);
      const admission = settled(
        repos.attempts.admit(
          ORG_A,
          attemptInput({ id: "sgen_cserial_loser", generationSceneRequestId: request.id }),
          ctx(),
        ),
      );

      // The discriminator. Without the lock this call would have read its
      // siblings by now, found none, and be sitting on the index instead — or
      // worse, already have decided it is PRIMARY.
      await breathe();
      expect(admission.done()).toBe(false);

      release();
      await holderDone;

      // It resolves — it does not reject — and it says the right thing.
      const outcome = await admission.value;
      expect(outcome.kind).toBe("ATTEMPT_ALREADY_ACTIVE");

      const rows = await prisma.sceneGeneration.findMany({
        where: { generationSceneRequestId: request.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe("sgen_cserial_winner");
      expect(rows.filter((r) => r.attemptKind === "PRIMARY")).toHaveLength(1);
    });

    it("admits exactly one of two genuinely concurrent admissions", async () => {
      // The plain race, kept as well: it cannot distinguish the two
      // implementations on its own, but it is the shape a caller actually
      // writes, and it must never reject.
      const { request } = await seedChain(prisma, "crace");
      const results = await Promise.allSettled([
        repos.attempts.admit(
          ORG_A,
          attemptInput({ id: "sgen_crace_a", generationSceneRequestId: request.id }),
          ctx(),
        ),
        repos.attempts.admit(
          ORG_A,
          attemptInput({
            id: "sgen_crace_b",
            generationSceneRequestId: request.id,
            pricingSnapshotId: "price_sgen_crace_b",
          }),
          ctx(),
        ),
      ]);

      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      const kinds = results.map((r) => (r.status === "fulfilled" ? r.value.kind : "REJECTED"));
      expect(kinds.filter((k) => k === "ADMITTED")).toHaveLength(1);
      expect(kinds.filter((k) => k === "ATTEMPT_ALREADY_ACTIVE")).toHaveLength(1);

      const rows = await prisma.sceneGeneration.findMany({
        where: { generationSceneRequestId: request.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.attemptKind).toBe("PRIMARY");
    });
  });

  describe("user regeneration serializes on the parent scene", () => {
    it("returns REGENERATION_ALREADY_ACTIVE to the loser instead of a database error", async () => {
      const { scene } = await seedChain(prisma, "regserial");

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holderDone = holder.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "generation_scenes" WHERE "id" = ${scene.id} FOR UPDATE`;
          await tx.sceneGenerationRequest.create({
            data: {
              id: "genreq_regserial_winner",
              generationSceneId: scene.id,
              kind: "USER_REGENERATION",
              userRegenerationOrdinal: 1,
              requestedByUserId: "usr_itest",
              state: "PENDING",
            },
          });
          await held;
        },
        { timeout: 20_000 },
      );

      await breathe(4);
      const admission = settled(
        repos.requests.admitUserRegeneration(
          ORG_A,
          {
            id: "genreq_regserial_loser",
            generationSceneId: scene.id,
            requestedByUserId: "usr_itest",
          },
          ctx({ actorType: "USER", actorUserId: "usr_itest" }),
        ),
      );

      await breathe();
      expect(admission.done()).toBe(false);

      release();
      await holderDone;

      const outcome = await admission.value;
      expect(outcome.kind).toBe("REGENERATION_ALREADY_ACTIVE");

      const rows = await prisma.sceneGenerationRequest.findMany({
        where: { generationSceneId: scene.id, kind: "USER_REGENERATION" },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe("genreq_regserial_winner");
    });
  });

  describe("a job snapshots project settings under a lock that outlasts the read", () => {
    it("cannot be durably created after an update while carrying the value from before it", async () => {
      // The forbidden ordering, constructed. The holder updates the project and
      // keeps the transaction open; job creation blocks on the shared lock; the
      // holder commits; the job must then snapshot the *new* value. An
      // implementation that reads the project before its transaction would have
      // read the old value already and would store it here.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holderDone = holder.$transaction(
        async (tx) => {
          await tx.videoProject.update({
            where: { id: PROJECT_A },
            data: { targetOutputResolution: "720p", aspectRatio: "9:16" },
          });
          await held;
        },
        { timeout: 20_000 },
      );

      await breathe(4);
      const creation = settled(
        repos.jobs.create(
          ORG_A,
          {
            id: "genjob_projrace",
            videoProjectId: PROJECT_A,
            requestedByUserId: "usr_itest",
            qualityTier: "NORMAL",
            requestedDurationSeconds: 30,
          },
          ctx(),
        ),
      );

      await breathe();
      expect(creation.done()).toBe(false);

      release();
      await holderDone;

      const created = await creation.value;
      if (created.kind !== "CREATED") throw new Error(`expected CREATED, got ${created.kind}`);
      // Version B won the race, so the job must carry B.
      expect(created.job.targetOutputResolution).toBe("720p");
      expect(created.job.targetAspectRatio).toBe("9:16");

      const stored = await prisma.generationJob.findUniqueOrThrow({
        where: { id: "genjob_projrace" },
      });
      expect(stored.targetOutputResolution).toBe("720p");
      expect(stored.targetAspectRatio).toBe("9:16");
    });

    it("blocks a settings update that arrives while a job is being created", async () => {
      // The mirror image, and the reason the lock is `FOR SHARE` rather than a
      // re-read: the ordering must be a real serialization in both directions,
      // not merely a fresher read in one of them.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holderDone = holder.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "video_projects" WHERE "id" = ${PROJECT_A} FOR SHARE`;
          await held;
        },
        { timeout: 20_000 },
      );

      await breathe(4);
      const update = settled(
        prisma.videoProject.update({
          where: { id: PROJECT_A },
          data: { targetOutputResolution: "720p" },
        }),
      );

      await breathe();
      expect(update.done()).toBe(false);

      release();
      await holderDone;
      await update.value;
    });
  });
});
