import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ISO_BMFF_CONTAINER,
  MediaValidationLifecycleRunner,
  managedGenerationOutputKey,
  safePositiveByteCount,
  sha256Digest,
  type ManagedOutputMediaFacts,
  type ManagedOutputMediaValidationPort,
  type MediaValidationClaim,
} from "@app/domain";
import { createMediaValidationLifecycleRepository } from "@app/database";
import {
  ASSET_A,
  dropTenants,
  HAS_DB,
  ORG_A,
  PROJECT_A,
  seedChain,
  seedTenants,
  STORYBOARD_SCENE,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * The durable media-validation lifecycle against live PostgreSQL.
 *
 * The unit suite proves the runner's ordering and the fake repository's rules.
 * What only a database can prove is that the SQL agrees: that the unique index
 * resolves a real concurrent insert to one winner, that the lease/version/
 * receipt guards are actually in the `WHERE` clause, that the CHECK constraints
 * reject impossible row shapes, and that BigInt facts round-trip exactly.
 *
 * No S3, no ffprobe, no network: the validator is a fake returning a scripted
 * value, exactly as the phase's dormancy requires.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const DIGEST = "b".repeat(64);
const SIZE = 12_345_678;

const FACTS: ManagedOutputMediaFacts = {
  container: ISO_BMFF_CONTAINER,
  durationMs: 8500,
  videoWidth: 1920,
  videoHeight: 1080,
  videoStreamCount: 1,
  audioStreamCount: 0,
};

/** A validator returning a scripted value. Never touches S3 or a subprocess. */
function fakeValidator(
  result: unknown,
  onCall?: () => Promise<void> | void,
): ManagedOutputMediaValidationPort {
  return {
    async validate() {
      await onCall?.();
      return result;
    },
  };
}

/**
 * One OUTPUT_VERIFIED attempt whose key is the one the application derives.
 *
 * A full job → scene → request chain is seeded first, because an orchestrated
 * attempt row is all-or-none by CHECK constraint: a row carrying an
 * `orchestrationState` must also carry its request, ordinal, kind and
 * certainty. Creating a bare attempt would be testing against a row shape the
 * database does not permit.
 */
let chainCounter = 0;
async function seedVerifiedAttempt(
  id: string,
  overrides: {
    readonly verifiedAt?: Date;
    readonly orchestrationState?: string;
    readonly sha256?: string;
    readonly sizeBytes?: number | null;
    readonly storageKey?: string | null;
  } = {},
): Promise<void> {
  chainCounter += 1;
  const { request } = await seedChain(prisma, `mvl${chainCounter}`);
  const state = overrides.orchestrationState ?? "OUTPUT_VERIFIED";
  const key =
    overrides.storageKey === undefined
      ? managedGenerationOutputKey({ organizationId: ORG_A, attemptId: id })
      : overrides.storageKey;
  await prisma.sceneGeneration.create({
    data: {
      id,
      videoProjectId: PROJECT_A,
      sourceStoryboardSceneId: STORYBOARD_SCENE,
      assetId: ASSET_A,
      sourceAnalysisRevision: 1,
      requestHash: `hash_${id}`,
      providerName: "open-video",
      providerModelId: "open-video/image-to-video",
      generationSceneRequestId: request.id,
      attemptOrdinal: 1,
      attemptKind: "PRIMARY",
      pricingContractKey: "open-video/image-to-video@v1",
      submissionCertainty: "ACCEPTED",
      // ACCEPTED requires a prediction reference by CHECK constraint.
      providerPredictionId: `pred_${id}`,
      providerAcceptedAt: new Date("2025-12-31T00:00:00.000Z"),
      submissionBoundaryEnteredAt: new Date("2025-12-31T00:00:00.000Z"),
      orchestrationState: state as never,
      outputStorageKey: key,
      outputSha256: overrides.sha256 ?? DIGEST,
      outputSizeBytes:
        overrides.sizeBytes === null ? null : BigInt(overrides.sizeBytes ?? SIZE),
      outputVerifiedAt: overrides.verifiedAt ?? new Date("2026-01-01T00:00:00.000Z"),
    },
  });
}

function runner(
  validator: ManagedOutputMediaValidationPort,
  now: () => number,
  config: { leaseMs?: number; retryDelayMs?: number } = {},
): MediaValidationLifecycleRunner {
  let n = 0;
  return new MediaValidationLifecycleRunner(config, {
    repository: createMediaValidationLifecycleRepository(prisma),
    validator,
    clock: now,
    leaseTokens: {
      next() {
        n += 1;
        return `tok-${n}-${randomUUID()}`;
      },
    },
  });
}

const repo = () => createMediaValidationLifecycleRepository(prisma);

RUN("durable media-validation lifecycle (live database)", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------

  describe("candidate discovery", () => {
    it("finds an OUTPUT_VERIFIED attempt that has no validation record", async () => {
      await seedVerifiedAttempt("sgen_mvl_a");
      const candidates = await repo().findCandidates({ now: Date.now(), limit: 10 });
      expect(candidates.map((c) => c.sceneGenerationId)).toEqual(["sgen_mvl_a"]);
    });

    it("excludes attempts that are not OUTPUT_VERIFIED", async () => {
      await seedVerifiedAttempt("sgen_mvl_b", { orchestrationState: "PROVIDER_SUCCEEDED" });
      expect(await repo().findCandidates({ now: Date.now(), limit: 10 })).toHaveLength(0);
    });

    it("refuses to claim a non-OUTPUT_VERIFIED attempt even when asked directly", async () => {
      // The candidate listing is only a hint. A caller reaching `claim` with an
      // identifier from anywhere — a stale batch, an operator, a future
      // scheduler — must still be refused, and no record may be created.
      await seedVerifiedAttempt("sgen_mvl_direct", { orchestrationState: "PROVIDER_SUCCEEDED" });
      const now = Date.now();
      expect(
        await repo().claim({
          sceneGenerationId: "sgen_mvl_direct",
          now,
          leaseToken: "t",
          leaseExpiresAt: now + 60_000,
        }),
      ).toEqual({ kind: "NOT_ELIGIBLE" });
      expect(await prisma.managedOutputMediaValidation.count()).toBe(0);
    });

    it("refuses to claim an attempt that left OUTPUT_VERIFIED after being listed", async () => {
      // The state can change between the listing and the claim, which is
      // exactly why the claim re-reads it under its own transaction.
      await seedVerifiedAttempt("sgen_mvl_moved");
      expect(await repo().findCandidates({ now: Date.now(), limit: 10 })).toHaveLength(1);
      await prisma.sceneGeneration.update({
        where: { id: "sgen_mvl_moved" },
        data: { orchestrationState: "PROVIDER_SUCCEEDED" },
      });
      const now = Date.now();
      expect(
        await repo().claim({
          sceneGenerationId: "sgen_mvl_moved",
          now,
          leaseToken: "t",
          leaseExpiresAt: now + 60_000,
        }),
      ).toEqual({ kind: "NOT_ELIGIBLE" });
      expect(await prisma.managedOutputMediaValidation.count()).toBe(0);
    });

    it.each([
      ["a missing managed key", { outputStorageKey: null }],
      ["a missing size", { outputSizeBytes: null }],
      ["a missing digest", { outputSha256: null }],
      ["a missing verification time", { outputVerifiedAt: null }],
    ])("excludes and refuses an OUTPUT_VERIFIED attempt with %s", async (_label, patch) => {
      // Phase 2H-1's `scene_generations_verified_output_metadata_check` already
      // makes this row impossible to create, which is the primary protection.
      // The constraint is dropped here only to prove the second line of defence
      // independently: a repository meeting such a row — from a database this
      // migration has not reached, or a direct write — must still exclude it
      // rather than point the validator at an object it cannot name.
      await seedVerifiedAttempt("sgen_mvl_c");
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "scene_generations" DROP CONSTRAINT "scene_generations_verified_output_metadata_check"`,
      );
      try {
        await prisma.sceneGeneration.update({ where: { id: "sgen_mvl_c" }, data: patch });
        expect(await repo().findCandidates({ now: Date.now(), limit: 10 })).toHaveLength(0);
        expect(
          await repo().claim({
            sceneGenerationId: "sgen_mvl_c",
            now: Date.now(),
            leaseToken: "t",
            leaseExpiresAt: Date.now() + 60_000,
          }),
        ).toEqual({ kind: "NOT_ELIGIBLE" });
      } finally {
        await prisma.managedOutputMediaValidation.deleteMany({});
        await prisma.sceneGeneration.deleteMany({ where: { id: "sgen_mvl_c" } });
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "scene_generations" ADD CONSTRAINT "scene_generations_verified_output_metadata_check" CHECK ("orchestrationState" IS DISTINCT FROM 'OUTPUT_VERIFIED' OR ("outputStorageKey" IS NOT NULL AND "outputSha256" IS NOT NULL AND "outputSizeBytes" IS NOT NULL AND "outputVerifiedAt" IS NOT NULL))`,
        );
      }
    });

    it("orders by verification time then id, and honours the limit", async () => {
      await seedVerifiedAttempt("sgen_mvl_z", { verifiedAt: new Date("2026-01-03T00:00:00Z") });
      await seedVerifiedAttempt("sgen_mvl_y", { verifiedAt: new Date("2026-01-01T00:00:00Z") });
      await seedVerifiedAttempt("sgen_mvl_x", { verifiedAt: new Date("2026-01-01T00:00:00Z") });

      const all = await repo().findCandidates({ now: Date.now(), limit: 10 });
      expect(all.map((c) => c.sceneGenerationId)).toEqual([
        "sgen_mvl_x",
        "sgen_mvl_y",
        "sgen_mvl_z",
      ]);
      expect(await repo().findCandidates({ now: Date.now(), limit: 2 })).toHaveLength(2);
    });

    it("refuses an unbounded limit rather than putting it into a SQL LIMIT", async () => {
      await expect(
        repo().findCandidates({ now: Date.now(), limit: Number.POSITIVE_INFINITY }),
      ).rejects.toThrow();
    });

    it("excludes terminal rows and rows whose lease is still active", async () => {
      await seedVerifiedAttempt("sgen_mvl_t");
      const now = Date.now();
      const claimed = await repo().claim({
        sceneGenerationId: "sgen_mvl_t",
        now,
        leaseToken: "active",
        leaseExpiresAt: now + 300_000,
      });
      expect(claimed.kind).toBe("CLAIMED");
      expect(await repo().findCandidates({ now, limit: 10 })).toHaveLength(0);

      if (claimed.kind !== "CLAIMED") return;
      await repo().finalizeIntegrityMismatch({ claim: claimed.claim, validatedAt: now });
      expect(await repo().findCandidates({ now: now + 10_000_000, limit: 10 })).toHaveLength(0);
    });

    it("finds a row again once its lease has expired", async () => {
      await seedVerifiedAttempt("sgen_mvl_exp");
      const now = Date.now();
      await repo().claim({
        sceneGenerationId: "sgen_mvl_exp",
        now,
        leaseToken: "short",
        leaseExpiresAt: now + 1_000,
      });
      expect(await repo().findCandidates({ now: now + 500, limit: 10 })).toHaveLength(0);
      expect(await repo().findCandidates({ now: now + 1_001, limit: 10 })).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------

  describe("claiming", () => {
    it("binds the record to the attempt's exact receipt and derived key", async () => {
      await seedVerifiedAttempt("sgen_mvl_bind");
      const now = Date.now();
      const claimed = await repo().claim({
        sceneGenerationId: "sgen_mvl_bind",
        now,
        leaseToken: "t",
        leaseExpiresAt: now + 60_000,
      });
      expect(claimed.kind).toBe("CLAIMED");
      if (claimed.kind !== "CLAIMED") return;
      expect(claimed.claim.expectedReceipt).toEqual({
        sha256: sha256Digest(DIGEST),
        sizeBytes: safePositiveByteCount(SIZE),
      });
      expect(claimed.claim.destinationKey).toBe(
        managedGenerationOutputKey({ organizationId: ORG_A, attemptId: "sgen_mvl_bind" }),
      );

      const row = await prisma.managedOutputMediaValidation.findUniqueOrThrow({
        where: { sceneGenerationId: "sgen_mvl_bind" },
      });
      expect(row.receiptSha256).toBe(DIGEST);
      expect(row.receiptSizeBytes).toBe(BigInt(SIZE));
      expect(row.status).toBe("RUNNING");
      expect(row.attemptCount).toBe(1);
      expect(row.version).toBe(1);
      expect(row.nextAttemptAt).toBeNull();
    });

    it.each(["VALID", "INVALID_MEDIA", "INTEGRITY_MISMATCH"] as const)(
      "refuses to reopen a %s record, even when asked directly",
      async (terminal) => {
        // A settled verdict is never revisited. The candidate listing already
        // excludes it, but the claim is the authority and must refuse too.
        const id = `sgen_mvl_reopen_${terminal}`;
        await seedVerifiedAttempt(id);
        const now = Date.now();
        const claimed = await repo().claim({
          sceneGenerationId: id,
          now,
          leaseToken: "t",
          leaseExpiresAt: now + 1_000,
        });
        if (claimed.kind !== "CLAIMED") throw new Error("expected a claim");
        if (terminal === "VALID") {
          await repo().finalizeValid({ claim: claimed.claim, facts: FACTS, validatedAt: now });
        } else if (terminal === "INVALID_MEDIA") {
          await repo().finalizeInvalidMedia({
            claim: claimed.claim,
            reason: "CONTAINER_UNSUPPORTED",
            validatedAt: now,
          });
        } else {
          await repo().finalizeIntegrityMismatch({ claim: claimed.claim, validatedAt: now });
        }

        // Well past the original lease, so expiry cannot be what refuses it.
        expect(
          await repo().claim({
            sceneGenerationId: id,
            now: now + 10_000_000,
            leaseToken: "t2",
            leaseExpiresAt: now + 10_060_000,
          }),
        ).toEqual({ kind: "ALREADY_TERMINAL" });

        const row = await prisma.managedOutputMediaValidation.findUniqueOrThrow({
          where: { sceneGenerationId: id },
        });
        expect(row.status).toBe(terminal);
        expect(row.leaseToken).toBeNull();
        expect(row.attemptCount).toBe(1);
      },
    );

    it("refuses an attempt whose stored key is not the derived one", async () => {
      // A stored key that does not match what the organization and attempt
      // derive to would point the validator at some other object.
      await seedVerifiedAttempt("sgen_mvl_key", { storageKey: "org/other/generations/x.mp4" });
      const now = Date.now();
      expect(
        await repo().claim({
          sceneGenerationId: "sgen_mvl_key",
          now,
          leaseToken: "t",
          leaseExpiresAt: now + 60_000,
        }),
      ).toEqual({ kind: "NOT_ELIGIBLE" });
    });

    it("lets exactly one of two concurrent workers create the first record, with no Prisma error", async () => {
      await seedVerifiedAttempt("sgen_mvl_race");
      const now = Date.now();
      const both = await Promise.all([
        repo().claim({
          sceneGenerationId: "sgen_mvl_race",
          now,
          leaseToken: "A",
          leaseExpiresAt: now + 60_000,
        }),
        repo().claim({
          sceneGenerationId: "sgen_mvl_race",
          now,
          leaseToken: "B",
          leaseExpiresAt: now + 60_000,
        }),
      ]);
      const kinds = both.map((o) => o.kind).sort();
      expect(kinds).toEqual(["CLAIMED", "NOT_CLAIMED"]);
      // One row, not two, and no P2002 escaped as an exception.
      expect(await prisma.managedOutputMediaValidation.count()).toBe(1);
    });

    it("reclaims an expired lease with a new token and bumped counters", async () => {
      await seedVerifiedAttempt("sgen_mvl_reclaim");
      const now = Date.now();
      await repo().claim({
        sceneGenerationId: "sgen_mvl_reclaim",
        now,
        leaseToken: "dead-owner",
        leaseExpiresAt: now + 1_000,
      });
      const second = await repo().claim({
        sceneGenerationId: "sgen_mvl_reclaim",
        now: now + 2_000,
        leaseToken: "new-owner",
        leaseExpiresAt: now + 62_000,
      });
      expect(second.kind).toBe("CLAIMED");

      const row = await prisma.managedOutputMediaValidation.findUniqueOrThrow({
        where: { sceneGenerationId: "sgen_mvl_reclaim" },
      });
      expect(row.leaseToken).toBe("new-owner");
      expect(row.attemptCount).toBe(2);
      expect(row.version).toBe(2);
    });

    it("refuses to claim a row bound to different bytes than the attempt's receipt", async () => {
      await seedVerifiedAttempt("sgen_mvl_conflict");
      const now = Date.now();
      await repo().claim({
        sceneGenerationId: "sgen_mvl_conflict",
        now,
        leaseToken: "t",
        leaseExpiresAt: now + 1_000,
      });
      // The attempt's durable receipt changes under an existing record. Neither
      // side is overwritten: validating new bytes under an old record would
      // silently answer a different question.
      await prisma.sceneGeneration.update({
        where: { id: "sgen_mvl_conflict" },
        data: { outputSha256: "c".repeat(64) },
      });
      await expect(
        repo().claim({
          sceneGenerationId: "sgen_mvl_conflict",
          now: now + 5_000,
          leaseToken: "t2",
          leaseExpiresAt: now + 65_000,
        }),
      ).rejects.toThrow();

      const row = await prisma.managedOutputMediaValidation.findUniqueOrThrow({
        where: { sceneGenerationId: "sgen_mvl_conflict" },
      });
      expect(row.receiptSha256).toBe(DIGEST);
    });
  });

  // -------------------------------------------------------------------------

  describe("finalization guards", () => {
    async function claimOne(id: string): Promise<MediaValidationClaim> {
      await seedVerifiedAttempt(id);
      const now = Date.now();
      const claimed = await repo().claim({
        sceneGenerationId: id,
        now,
        leaseToken: `tok-${id}`,
        leaseExpiresAt: now + 300_000,
      });
      if (claimed.kind !== "CLAIMED") throw new Error("expected a claim");
      return claimed.claim;
    }

    it("persists VALID facts exactly, including BigInt round-trip", async () => {
      const claim = await claimOne("sgen_mvl_valid");
      const big: ManagedOutputMediaFacts = {
        container: ISO_BMFF_CONTAINER,
        durationMs: 9_007_199_254_740_991,
        videoWidth: 7680,
        videoHeight: 4320,
        videoStreamCount: 3,
        audioStreamCount: 0,
      };
      expect(
        await repo().finalizeValid({ claim, facts: big, validatedAt: Date.now() }),
      ).toEqual({ kind: "WRITTEN" });

      const record = await repo().findBySceneGeneration("sgen_mvl_valid");
      expect(record).toMatchObject({ status: "VALID", facts: big });
      const row = await prisma.managedOutputMediaValidation.findUniqueOrThrow({
        where: { sceneGenerationId: "sgen_mvl_valid" },
      });
      expect(row.durationMs).toBe(BigInt(9_007_199_254_740_991));
      expect(row.leaseToken).toBeNull();
      expect(row.leaseExpiresAt).toBeNull();
      expect(row.nextAttemptAt).toBeNull();
    });

    it.each(["forged-token", null])("loses a finalize with lease token %s", async (token) => {
      const claim = await claimOne(`sgen_mvl_tok_${String(token)}`);
      const stale = { ...claim, leaseToken: token ?? "" };
      expect(
        await repo().finalizeValid({ claim: stale, facts: FACTS, validatedAt: Date.now() }),
      ).toEqual({ kind: "LOST" });
      const row = await prisma.managedOutputMediaValidation.findUniqueOrThrow({
        where: { sceneGenerationId: claim.sceneGenerationId },
      });
      expect(row.status).toBe("RUNNING");
    });

    it("loses a finalize carrying a stale version", async () => {
      const claim = await claimOne("sgen_mvl_ver");
      expect(
        await repo().finalizeValid({
          claim: { ...claim, version: claim.version + 3 },
          facts: FACTS,
          validatedAt: Date.now(),
        }),
      ).toEqual({ kind: "LOST" });
    });

    it("loses a finalize whose receipt no longer matches the binding", async () => {
      const claim = await claimOne("sgen_mvl_rcpt");
      expect(
        await repo().finalizeValid({
          claim: {
            ...claim,
            expectedReceipt: {
              sha256: sha256Digest("d".repeat(64)),
              sizeBytes: claim.expectedReceipt.sizeBytes,
            },
          },
          facts: FACTS,
          validatedAt: Date.now(),
        }),
      ).toEqual({ kind: "LOST" });
    });

    it("never overwrites a terminal row, even with a replayed valid claim", async () => {
      const claim = await claimOne("sgen_mvl_term");
      await repo().finalizeIntegrityMismatch({ claim, validatedAt: Date.now() });
      // The same claim replayed: the version has advanced and the status is no
      // longer RUNNING, so the second write matches zero rows.
      expect(
        await repo().finalizeValid({ claim, facts: FACTS, validatedAt: Date.now() }),
      ).toEqual({ kind: "LOST" });
      const row = await prisma.managedOutputMediaValidation.findUniqueOrThrow({
        where: { sceneGenerationId: "sgen_mvl_term" },
      });
      expect(row.status).toBe("INTEGRITY_MISMATCH");
      expect(row.durationMs).toBeNull();
    });

    it("stale worker cannot overwrite the worker that reclaimed its row", async () => {
      await seedVerifiedAttempt("sgen_mvl_stale");
      const now = Date.now();
      const a = await repo().claim({
        sceneGenerationId: "sgen_mvl_stale",
        now,
        leaseToken: "A",
        leaseExpiresAt: now + 1_000,
      });
      const b = await repo().claim({
        sceneGenerationId: "sgen_mvl_stale",
        now: now + 2_000,
        leaseToken: "B",
        leaseExpiresAt: now + 62_000,
      });
      if (a.kind !== "CLAIMED" || b.kind !== "CLAIMED") throw new Error("expected claims");

      expect(
        await repo().finalizeInvalidMedia({
          claim: b.claim,
          reason: "PROBE_REJECTED",
          validatedAt: now,
        }),
      ).toEqual({ kind: "WRITTEN" });
      expect(
        await repo().finalizeValid({ claim: a.claim, facts: FACTS, validatedAt: now }),
      ).toEqual({ kind: "LOST" });

      const row = await prisma.managedOutputMediaValidation.findUniqueOrThrow({
        where: { sceneGenerationId: "sgen_mvl_stale" },
      });
      expect(row.status).toBe("INVALID_MEDIA");
      expect(row.invalidReason).toBe("PROBE_REJECTED");
    });
  });

  // -------------------------------------------------------------------------

  describe("database CHECK constraints reject impossible row shapes", () => {
    async function seedRunning(id: string): Promise<string> {
      await seedVerifiedAttempt(id);
      const now = Date.now();
      const claimed = await repo().claim({
        sceneGenerationId: id,
        now,
        leaseToken: "t",
        leaseExpiresAt: now + 60_000,
      });
      if (claimed.kind !== "CLAIMED") throw new Error("expected a claim");
      return claimed.claim.validationId;
    }

    it("refuses a VALID row with no media facts", async () => {
      const id = await seedRunning("sgen_chk_valid");
      await expect(
        prisma.managedOutputMediaValidation.update({
          where: { id },
          data: { status: "VALID", leaseToken: null, leaseExpiresAt: null, validatedAt: new Date() },
        }),
      ).rejects.toThrow();
    });

    it("refuses a RUNNING row with no lease token", async () => {
      const id = await seedRunning("sgen_chk_running");
      await expect(
        prisma.managedOutputMediaValidation.update({ where: { id }, data: { leaseToken: null } }),
      ).rejects.toThrow();
    });

    it("refuses a terminal row that still holds a lease", async () => {
      const id = await seedRunning("sgen_chk_lease");
      await expect(
        prisma.managedOutputMediaValidation.update({
          where: { id },
          data: { status: "INTEGRITY_MISMATCH", validatedAt: new Date() },
        }),
      ).rejects.toThrow();
    });

    it("refuses an INVALID_MEDIA row carrying media facts", async () => {
      const id = await seedRunning("sgen_chk_invalid");
      await expect(
        prisma.managedOutputMediaValidation.update({
          where: { id },
          data: {
            status: "INVALID_MEDIA",
            invalidReason: "DURATION_INVALID",
            leaseToken: null,
            leaseExpiresAt: null,
            validatedAt: new Date(),
            durationMs: BigInt(10),
          },
        }),
      ).rejects.toThrow();
    });

    it("refuses a PENDING row carrying a verdict", async () => {
      const id = await seedRunning("sgen_chk_pending");
      await expect(
        prisma.managedOutputMediaValidation.update({
          where: { id },
          data: {
            status: "PENDING",
            leaseToken: null,
            leaseExpiresAt: null,
            invalidReason: "PROBE_REJECTED",
          },
        }),
      ).rejects.toThrow();
    });

    it.each([
      ["a zero receipt size", { receiptSizeBytes: BigInt(0) }],
      ["an out-of-range receipt size", { receiptSizeBytes: BigInt("9007199254740992") }],
      ["an uppercase digest", { receiptSha256: "A".repeat(64) }],
      ["a negative version", { version: -1 }],
    ])("refuses %s", async (_label, data) => {
      const id = await seedRunning(`sgen_chk_${randomUUID().slice(0, 8)}`);
      await expect(
        prisma.managedOutputMediaValidation.update({ where: { id }, data }),
      ).rejects.toThrow();
    });

    it("refuses an out-of-range media fact", async () => {
      const id = await seedRunning("sgen_chk_range");
      await expect(
        prisma.managedOutputMediaValidation.update({
          where: { id },
          data: {
            status: "VALID",
            container: "ISO_BMFF",
            durationMs: BigInt("9007199254740992"),
            videoWidth: BigInt(1),
            videoHeight: BigInt(1),
            videoStreamCount: BigInt(1),
            audioStreamCount: BigInt(0),
            leaseToken: null,
            leaseExpiresAt: null,
            validatedAt: new Date(),
          },
        }),
      ).rejects.toThrow();
    });

    it.each([
      ["a negative duration", { durationMs: BigInt(-5) }],
      ["a zero width", { videoWidth: BigInt(0) }],
      ["an unsafe duration", { durationMs: BigInt("9007199254740993") }],
      ["a negative audio count", { audioStreamCount: BigInt(-1) }],
    ])("refuses to narrow %s into a durable fact", async (_label, patch) => {
      // The media-fact columns have no second domain predicate behind the
      // narrowing, unlike the receipt size — so if the range check were dropped,
      // a corrupt row would be read back as a fact about a customer's video.
      const id = await seedRunning(`sgen_narrow_${randomUUID().slice(0, 8)}`);
      const sceneGenerationId = (
        await prisma.managedOutputMediaValidation.findUniqueOrThrow({ where: { id } })
      ).sceneGenerationId;
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "managed_output_media_validations" DROP CONSTRAINT "momv_media_fact_ranges_check"`,
      );
      try {
        await prisma.managedOutputMediaValidation.update({
          where: { id },
          data: {
            status: "VALID",
            container: "ISO_BMFF",
            durationMs: BigInt(1000),
            videoWidth: BigInt(640),
            videoHeight: BigInt(480),
            videoStreamCount: BigInt(1),
            audioStreamCount: BigInt(0),
            leaseToken: null,
            leaseExpiresAt: null,
            validatedAt: new Date(),
            ...patch,
          },
        });
        await expect(repo().findBySceneGeneration(sceneGenerationId)).rejects.toThrow();
      } finally {
        // The corrupt row goes first, so the constraint is restored exactly as
        // the migration defines it — validated against the data, not deferred.
        await prisma.managedOutputMediaValidation.delete({ where: { id } });
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "managed_output_media_validations" ADD CONSTRAINT "momv_media_fact_ranges_check" CHECK (
            ("durationMs" IS NULL OR ("durationMs" > 0 AND "durationMs" <= 9007199254740991))
            AND ("videoWidth" IS NULL OR ("videoWidth" > 0 AND "videoWidth" <= 9007199254740991))
            AND ("videoHeight" IS NULL OR ("videoHeight" > 0 AND "videoHeight" <= 9007199254740991))
            AND ("videoStreamCount" IS NULL OR ("videoStreamCount" > 0 AND "videoStreamCount" <= 9007199254740991))
            AND ("audioStreamCount" IS NULL OR ("audioStreamCount" >= 0 AND "audioStreamCount" <= 9007199254740991))
          )`,
        );
      }
    });

    it("refuses to narrow a corrupt persisted value on read", async () => {
      // The CHECK makes this row impossible; the repository refuses to read one
      // anyway, in case it meets a database the migration has not reached.
      const id = await seedRunning("sgen_chk_narrow");
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "managed_output_media_validations" DROP CONSTRAINT "momv_receipt_size_range_check"`,
      );
      try {
        await prisma.managedOutputMediaValidation.update({
          where: { id },
          data: { receiptSizeBytes: BigInt("9007199254740993") },
        });
        await expect(repo().findBySceneGeneration("sgen_chk_narrow")).rejects.toThrow();
      } finally {
        await prisma.managedOutputMediaValidation.update({
          where: { id },
          data: { receiptSizeBytes: BigInt(SIZE) },
        });
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "managed_output_media_validations" ADD CONSTRAINT "momv_receipt_size_range_check" CHECK ("receiptSizeBytes" > 0 AND "receiptSizeBytes" <= 9007199254740991)`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------

  describe("the runner end to end, against real rows", () => {
    it("takes an absent record to a durable VALID verdict, leaving the attempt alone", async () => {
      await seedVerifiedAttempt("sgen_mvl_e2e");
      const now = Date.now();
      const report = await runner(
        fakeValidator({ kind: "VALID", facts: FACTS }),
        () => now,
      ).runOnce(10);
      expect(report.outcomes).toEqual([
        { sceneGenerationId: "sgen_mvl_e2e", outcome: { kind: "VALID" } },
      ]);

      expect(await repo().findBySceneGeneration("sgen_mvl_e2e")).toMatchObject({
        status: "VALID",
        facts: FACTS,
      });
      // The attempt itself is untouched: still OUTPUT_VERIFIED, same receipt.
      const attempt = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: "sgen_mvl_e2e" },
      });
      expect(attempt.orchestrationState).toBe("OUTPUT_VERIFIED");
      expect(attempt.outputSha256).toBe(DIGEST);
      expect(attempt.outputSizeBytes).toBe(BigInt(SIZE));
      expect(attempt.stateVersion).toBe(0);
    });

    it("releases to PENDING on RETRYABLE_FAILURE and retries on a later pass", async () => {
      await seedVerifiedAttempt("sgen_mvl_retry");
      let now = Date.now();
      let result: unknown = { kind: "RETRYABLE_FAILURE" };
      const r = runner(
        { async validate() { return result; } },
        () => now,
        { retryDelayMs: 30_000 },
      );

      expect((await r.runOnce(10)).outcomes[0]?.outcome).toEqual({ kind: "RELEASED" });
      const released = await prisma.managedOutputMediaValidation.findUniqueOrThrow({
        where: { sceneGenerationId: "sgen_mvl_retry" },
      });
      expect(released.status).toBe("PENDING");
      expect(released.leaseToken).toBeNull();
      expect(released.nextAttemptAt?.getTime()).toBe(now + 30_000);
      expect(released.validatedAt).toBeNull();

      // Not due yet.
      now += 29_000;
      expect((await r.runOnce(10)).outcomes).toHaveLength(0);

      // Due, and now succeeding.
      now += 2_000;
      result = { kind: "VALID", facts: FACTS };
      expect((await r.runOnce(10)).outcomes[0]?.outcome).toEqual({ kind: "VALID" });
      const done = await prisma.managedOutputMediaValidation.findUniqueOrThrow({
        where: { sceneGenerationId: "sgen_mvl_retry" },
      });
      expect(done.status).toBe("VALID");
      expect(done.attemptCount).toBe(2);
    });

    it("holds no database transaction open while the validator runs", async () => {
      // The validator writes to an unrelated row through a *separate* client
      // connection. If the claim transaction were still open and holding a lock
      // on the validation row, this test would still pass — so the stronger
      // check is that a concurrent reader can see the RUNNING row the claim
      // committed, which is only true if that transaction has ended.
      await seedVerifiedAttempt("sgen_mvl_tx");
      let seenDuringValidation: string | null = null;
      const now = Date.now();
      await runner(
        fakeValidator({ kind: "VALID", facts: FACTS }, async () => {
          const row = await prisma.managedOutputMediaValidation.findUnique({
            where: { sceneGenerationId: "sgen_mvl_tx" },
          });
          seenDuringValidation = row?.status ?? null;
        }),
        () => now,
      ).runOnce(10);

      expect(seenDuringValidation).toBe("RUNNING");
    });

    it("leaves every other aggregate untouched on an INVALID_MEDIA verdict", async () => {
      await seedVerifiedAttempt("sgen_mvl_freeze");
      const before = {
        scenes: await prisma.generationScene.count(),
        jobs: await prisma.generationJob.count(),
        reservations: await prisma.generationReservation.count(),
        requests: await prisma.sceneGenerationRequest.count(),
        attempts: await prisma.sceneGeneration.count(),
      };

      const now = Date.now();
      await runner(
        fakeValidator({ kind: "INVALID_MEDIA", reason: "VIDEO_STREAM_MISSING" }),
        () => now,
      ).runOnce(10);

      expect({
        scenes: await prisma.generationScene.count(),
        jobs: await prisma.generationJob.count(),
        reservations: await prisma.generationReservation.count(),
        requests: await prisma.sceneGenerationRequest.count(),
        attempts: await prisma.sceneGeneration.count(),
      }).toEqual(before);

      // No SYSTEM_RECOVERY attempt was created, and the attempt is unchanged.
      expect(
        await prisma.sceneGeneration.count({ where: { attemptKind: "SYSTEM_RECOVERY" } }),
      ).toBe(0);
      const attempt = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: "sgen_mvl_freeze" },
      });
      expect(attempt.orchestrationState).toBe("OUTPUT_VERIFIED");
      expect(attempt.normalizedErrorCode).toBeNull();
    });

    it("writes no durable verdict when the validator returns a malformed value", async () => {
      await seedVerifiedAttempt("sgen_mvl_bad");
      const now = Date.now();
      const r = runner(fakeValidator({ kind: "WHATEVER" }), () => now);
      await expect(r.runOnce(10)).rejects.toThrow();

      const row = await prisma.managedOutputMediaValidation.findUniqueOrThrow({
        where: { sceneGenerationId: "sgen_mvl_bad" },
      });
      expect(row.status).toBe("PENDING");
      expect(row.validatedAt).toBeNull();
      expect(row.invalidReason).toBeNull();
    });

    it("keeps durable validation history when a delete is attempted through the attempt", async () => {
      await seedVerifiedAttempt("sgen_mvl_restrict");
      const now = Date.now();
      await runner(fakeValidator({ kind: "VALID", facts: FACTS }), () => now).runOnce(10);
      // RESTRICT, not CASCADE: paid-attempt validation history is not erasable
      // as a side effect of deleting the attempt row.
      await expect(
        prisma.sceneGeneration.delete({ where: { id: "sgen_mvl_restrict" } }),
      ).rejects.toThrow();
    });
  });
});
