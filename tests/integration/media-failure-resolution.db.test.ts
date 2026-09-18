import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MediaFailureResolutionRunner } from "@app/domain";
import {
  createAutomaticMediaRecoveryRepository,
  createMediaFailureResolutionRepository,
} from "@app/database";
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
  fakeFx,
  planner,
  seedFailure,
  workRow,
  type FailureChain,
} from "./media-failure-fixture";

/**
 * The durable resolution work lifecycle against live PostgreSQL.
 *
 * Three properties this suite exists for, each unprovable without a real
 * database:
 *
 * 1. **The first-record race.** Two workers discover the same absent work row.
 *    A unique violation would abort the transaction, so only a conflict-free
 *    insert leaves the loser able to read what the winner wrote.
 * 2. **The lease.** A crashed worker's claim becomes reclaimable, and its late
 *    write matches zero rows.
 * 3. **Fairness.** A prefix of unplannable candidates larger than the batch
 *    limit must not occupy every sweep forever.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const work = createMediaFailureResolutionRepository(prisma);
const recovery = createAutomaticMediaRecoveryRepository(prisma);

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const LEASE_MS = 5 * 60 * 1000;

function runner(options: { readonly now?: () => number; readonly fx?: ReturnType<typeof fakeFx> } = {}) {
  let n = 0;
  return new MediaFailureResolutionRunner({
    work,
    recovery,
    planner: planner(options.fx ?? fakeFx()),
    ids: {
      nextAttemptId: () => `sgen_run_${(n += 1)}`,
      nextPricingSnapshotId: () => `price_run_${n}`,
      nextLeaseToken: () => `lease_run_${n}`,
    },
    clock: options.now ?? (() => NOW),
    context: () => ctx({ correlationId: "corr_resolution" }),
  });
}

async function claimOne(chain: FailureChain, at: number = NOW, token = "lease_a") {
  return work.claim({
    sourceValidationId: chain.validationId,
    now: at,
    leaseToken: token,
    leaseExpiresAt: at + LEASE_MS,
  });
}

RUN("durable media-failure resolution work", () => {
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

  describe("lazy discovery", () => {
    it("offers a terminal failure that has no work row yet", async () => {
      const chain = await seedFailure(prisma, { attemptKind: "PRIMARY" });
      expect(await workRow(prisma, chain.validationId)).toBeNull();

      const found = await work.findResolutionCandidates({ now: NOW, limit: 10 });
      expect(found.map((c) => c.sourceValidationId)).toContain(chain.validationId);
    });

    it.each([["VALID"], ["PENDING"]] as const)("never offers a %s verdict", async (failure) => {
      const chain = await seedFailure(prisma, { attemptKind: "PRIMARY", failure });
      const found = await work.findResolutionCandidates({ now: NOW, limit: 10 });
      expect(found.map((c) => c.sourceValidationId)).not.toContain(chain.validationId);
    });

    it("offers INTEGRITY_MISMATCH as well as INVALID_MEDIA", async () => {
      const a = await seedFailure(prisma, { attemptKind: "PRIMARY", failure: "INVALID_MEDIA" });
      const b = await seedFailure(prisma, {
        attemptKind: "PRIMARY",
        failure: "INTEGRITY_MISMATCH",
      });
      const found = await work.findResolutionCandidates({ now: NOW, limit: 10 });
      const ids = found.map((c) => c.sourceValidationId);
      expect(ids).toContain(a.validationId);
      expect(ids).toContain(b.validationId);
    });

    it("orders oldest verdict first and bounds the batch", async () => {
      const old = await seedFailure(prisma, {
        attemptKind: "PRIMARY",
        validatedAt: new Date("2026-09-01T00:00:00.000Z"),
      });
      const newer = await seedFailure(prisma, {
        attemptKind: "PRIMARY",
        validatedAt: new Date("2026-09-05T00:00:00.000Z"),
      });
      const found = await work.findResolutionCandidates({ now: NOW, limit: 1 });
      expect(found).toHaveLength(1);
      expect(found[0]?.sourceValidationId).toBe(old.validationId);
      expect(found[0]?.sourceValidationId).not.toBe(newer.validationId);
    });

    it("refuses an unusable batch limit rather than clamping it", async () => {
      await expect(work.findResolutionCandidates({ now: NOW, limit: 0 })).rejects.toThrow();
      await expect(work.findResolutionCandidates({ now: NOW, limit: 1000 })).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------

  describe("the claim", () => {
    it("creates the work row on first claim and classifies the disposition", async () => {
      const chain = await seedFailure(prisma, { attemptKind: "PRIMARY" });

      const outcome = await claimOne(chain);
      if (outcome.kind !== "CLAIMED") throw new Error(`expected CLAIMED, got ${outcome.kind}`);
      expect(outcome.claim.disposition.kind).toBe("ADMIT_RECOVERY");
      expect(outcome.claim.organizationId).toBe(ORG_A);
      expect(outcome.claim.sourceAttemptId).toBe(chain.attemptId);

      const row = await workRow(prisma, chain.validationId);
      expect(row).toMatchObject({
        status: "RUNNING",
        attemptCount: 1,
        version: 1,
        leaseToken: "lease_a",
        resolutionKind: null,
        recoveryAttemptId: null,
        nextAttemptAt: null,
      });
      expect(row?.leaseExpiresAt).not.toBeNull();
    });

    it("classifies an exhausted recovery as a settlement", async () => {
      const chain = await seedFailure(prisma);
      const outcome = await claimOne(chain);
      if (outcome.kind !== "CLAIMED") throw new Error(`expected CLAIMED, got ${outcome.kind}`);
      expect(outcome.claim.disposition.kind).toBe("SETTLE_EXHAUSTED");
    });

    it("lets exactly one of two concurrent first claims win, and poisons neither", async () => {
      const chain = await seedFailure(prisma, { attemptKind: "PRIMARY" });

      const [a, b] = await Promise.all([
        claimOne(chain, NOW, "lease_a"),
        claimOne(chain, NOW, "lease_b"),
      ]);

      const kinds = [a.kind, b.kind].sort();
      expect(kinds).toEqual(["CLAIMED", "NOT_CLAIMED"]);
      const rows = await prisma.managedOutputMediaFailureResolution.findMany({
        where: { managedOutputMediaValidationId: chain.validationId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.attemptCount).toBe(1);
    });

    it("refuses a claim on a verdict that is not a terminal failure", async () => {
      const chain = await seedFailure(prisma, { attemptKind: "PRIMARY", failure: "VALID" });
      expect((await claimOne(chain)).kind).toBe("NOT_ELIGIBLE");
      expect(await workRow(prisma, chain.validationId)).toBeNull();
    });

    it("does not reclaim a live lease, and does reclaim an expired one", async () => {
      const chain = await seedFailure(prisma, { attemptKind: "PRIMARY" });
      const first = await claimOne(chain, NOW, "lease_a");
      if (first.kind !== "CLAIMED") throw new Error("expected CLAIMED");

      // Inside the lease: nobody else may take it.
      expect((await claimOne(chain, NOW + 1000, "lease_b")).kind).toBe("NOT_CLAIMED");

      // After it: the work is assumed abandoned and becomes claimable again.
      const second = await claimOne(chain, NOW + LEASE_MS + 1, "lease_b");
      if (second.kind !== "CLAIMED") throw new Error(`expected CLAIMED, got ${second.kind}`);
      expect(second.claim.version).toBe(2);

      // The first worker's late write is now harmless.
      const late = await work.resolveObsolete({ claim: first.claim, resolvedAt: NOW });
      expect(late.kind).toBe("LOST");
      expect((await workRow(prisma, chain.validationId))?.status).toBe("RUNNING");
    });

    it("never reopens resolved work", async () => {
      const chain = await seedFailure(prisma, { attemptKind: "PRIMARY" });
      const claimed = await claimOne(chain);
      if (claimed.kind !== "CLAIMED") throw new Error("expected CLAIMED");
      await work.resolveObsolete({ claim: claimed.claim, resolvedAt: NOW });

      const again = await claimOne(chain, NOW + LEASE_MS * 10, "lease_c");
      expect(again).toEqual({ kind: "ALREADY_RESOLVED", resolutionKind: "OBSOLETE" });
      // And it is gone from discovery for good.
      const found = await work.findResolutionCandidates({ now: NOW + LEASE_MS * 10, limit: 10 });
      expect(found.map((c) => c.sourceValidationId)).not.toContain(chain.validationId);
    });
  });

  // -------------------------------------------------------------------------

  describe("deferral", () => {
    it("records the refusal and hides the row until it is due", async () => {
      const chain = await seedFailure(prisma, { attemptKind: "PRIMARY" });
      const claimed = await claimOne(chain);
      if (claimed.kind !== "CLAIMED") throw new Error("expected CLAIMED");

      const applied = await work.defer({
        claim: claimed.claim,
        refusalCode: "NO_SAFE_CURRENT_PRICING",
        nextAttemptAt: NOW + 300_000,
      });
      expect(applied.kind).toBe("APPLIED");

      const row = await workRow(prisma, chain.validationId);
      expect(row).toMatchObject({
        status: "PENDING",
        lastPlanRefusalCode: "NO_SAFE_CURRENT_PRICING",
        leaseToken: null,
        leaseExpiresAt: null,
        version: 2,
      });

      // Not due: absent from discovery, and unclaimable.
      expect(
        (await work.findResolutionCandidates({ now: NOW + 1000, limit: 10 })).map(
          (c) => c.sourceValidationId,
        ),
      ).not.toContain(chain.validationId);
      expect((await claimOne(chain, NOW + 1000, "lease_b")).kind).toBe("NOT_CLAIMED");

      // Due: visible and claimable again.
      expect(
        (await work.findResolutionCandidates({ now: NOW + 300_001, limit: 10 })).map(
          (c) => c.sourceValidationId,
        ),
      ).toContain(chain.validationId);
      expect((await claimOne(chain, NOW + 300_001, "lease_b")).kind).toBe("CLAIMED");
    });

    it.each([
      ["PERSISTED_PRICING_IDENTITY_MALFORMED"],
      ["NO_SAFE_CURRENT_ROUTE"],
      ["NO_SAFE_CURRENT_PRICING"],
      ["AMBIGUOUS_CURRENT_PRICING"],
    ] as const)("persists the %s refusal code safely", async (code) => {
      const chain = await seedFailure(prisma, { attemptKind: "PRIMARY" });
      const claimed = await claimOne(chain);
      if (claimed.kind !== "CLAIMED") throw new Error("expected CLAIMED");
      await work.defer({ claim: claimed.claim, refusalCode: code, nextAttemptAt: NOW + 1000 });
      expect((await workRow(prisma, chain.validationId))?.lastPlanRefusalCode).toBe(code);
    });

    it("releases without claiming a reason it does not have", async () => {
      const chain = await seedFailure(prisma, { attemptKind: "PRIMARY" });
      const claimed = await claimOne(chain);
      if (claimed.kind !== "CLAIMED") throw new Error("expected CLAIMED");
      await work.release({ claim: claimed.claim, nextAttemptAt: NOW + 1000 });
      const row = await workRow(prisma, chain.validationId);
      expect(row).toMatchObject({ status: "PENDING", lastPlanRefusalCode: null });
    });
  });

  // -------------------------------------------------------------------------

  describe("fairness behind an unplannable prefix", () => {
    /**
     * The Phase 6B starvation problem, and the proof that deferral solves it.
     *
     * Three candidates that can never be planned right now sit in front of one
     * that can, and the batch limit is three. Without durable deferral the sweep
     * would offer the same three forever and the fourth would never be reached.
     */
    it("reaches an actionable candidate behind more refusals than the batch holds", async () => {
      const blocked: FailureChain[] = [];
      for (let i = 0; i < 3; i += 1) {
        blocked.push(
          await seedFailure(prisma, {
            attemptKind: "PRIMARY",
            validatedAt: new Date(Date.UTC(2026, 8, 1, i)),
          }),
        );
      }
      const actionable = await seedFailure(prisma, {
        attemptKind: "PRIMARY",
        validatedAt: new Date(Date.UTC(2026, 8, 2)),
      });

      // The first pass can plan nothing — no usable rate — so all three defer.
      const refusing = runner({ fx: fakeFx(null) });
      const first = await refusing.runOnce(3);
      expect(first.claimed).toBe(3);
      expect(first.deferred).toBe(3);
      expect(first.outcomes.map((o) => o.sourceValidationId).sort()).toEqual(
        blocked.map((b) => b.validationId).sort(),
      );
      // The actionable one was never even offered: the prefix filled the batch.
      expect(first.outcomes.map((o) => o.sourceValidationId)).not.toContain(
        actionable.validationId,
      );

      // Second pass, immediately: the deferred three are not due, so the batch
      // is free and the actionable candidate is reached.
      const second = await runner().runOnce(3);
      expect(second.outcomes.map((o) => o.sourceValidationId)).toEqual([
        actionable.validationId,
      ]);
      expect(second.recovered).toBe(1);

      // And the deferred work is not lost — it returns when it is due.
      const later = await work.findResolutionCandidates({ now: NOW + 600_000, limit: 10 });
      expect(later.map((c) => c.sourceValidationId).sort()).toEqual(
        blocked.map((b) => b.validationId).sort(),
      );
    });
  });

  // -------------------------------------------------------------------------

  describe("the coordinator end to end", () => {
    it("plans outside the transaction, admits, and binds the exact attempt", async () => {
      const chain = await seedFailure(prisma, { attemptKind: "PRIMARY" });
      const report = await runner().runOnce(10);

      expect(report).toMatchObject({ claimed: 1, recovered: 1, deferred: 0, settled: 0 });
      const attempts = await prisma.sceneGeneration.findMany({
        where: { generationSceneRequestId: chain.requestId },
        orderBy: { attemptOrdinal: "asc" },
      });
      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.attemptKind).toBe("SYSTEM_RECOVERY");

      const row = await workRow(prisma, chain.validationId);
      expect(row).toMatchObject({
        status: "RESOLVED",
        resolutionKind: "RECOVERY_ADMITTED",
        recoveryAttemptId: attempts[1]?.id,
        leaseToken: null,
        nextAttemptAt: null,
      });
      expect(row?.resolvedAt).not.toBeNull();
    });

    it("reconciles a recovery that committed before the work row was resolved", async () => {
      const chain = await seedFailure(prisma, { attemptKind: "PRIMARY" });

      // Admit the recovery exactly as a crashed worker would have, then leave
      // the work row unresolved — the crash window.
      const claimed = await claimOne(chain);
      if (claimed.kind !== "CLAIMED" || claimed.claim.disposition.kind !== "ADMIT_RECOVERY") {
        throw new Error("expected an admit disposition");
      }
      const plan = await planner().plan(claimed.claim.disposition.candidate);
      if (plan.kind !== "PLANNED") throw new Error(`expected a plan, got ${plan.code}`);
      const admitted = await recovery.admitAutomaticMediaRecovery({
        organizationId: ORG_A,
        sourceAttemptId: chain.attemptId,
        sourceValidationId: chain.validationId,
        attemptId: `sgen_crash_${chain.tag}`,
        pricingSnapshotId: `price_crash_${chain.tag}`,
        pricingSnapshot: plan.pricingSnapshot,
        fxSnapshot: plan.fxSnapshot,
        context: ctx(),
      });
      if (admitted.kind !== "ADMITTED") throw new Error(`not admitted: ${admitted.kind}`);
      await work.release({ claim: claimed.claim, nextAttemptAt: NOW });

      const before = await prisma.sceneGeneration.count({
        where: { generationSceneRequestId: chain.requestId },
      });
      const report = await runner().runOnce(10);

      expect(report.outcomes[0]?.result).toEqual({
        kind: "RECONCILED",
        recoveryAttemptId: `sgen_crash_${chain.tag}`,
      });
      // No second attempt, no second pricing snapshot.
      expect(
        await prisma.sceneGeneration.count({
          where: { generationSceneRequestId: chain.requestId },
        }),
      ).toBe(before);
      expect(await workRow(prisma, chain.validationId)).toMatchObject({
        status: "RESOLVED",
        resolutionKind: "RECOVERY_ADMITTED",
        recoveryAttemptId: `sgen_crash_${chain.tag}`,
      });
    });

    it("resolves work for a request that is no longer generating as obsolete", async () => {
      const chain = await seedFailure(prisma, { attemptKind: "PRIMARY" });
      await prisma.sceneGenerationRequest.update({
        where: { id: chain.requestId },
        data: { state: "DELIVERED", deliveredAt: new Date() },
      });

      const report = await runner().runOnce(10);

      expect(report.outcomes[0]?.result).toEqual({ kind: "RESOLVED", resolutionKind: "OBSOLETE" });
      expect(await workRow(prisma, chain.validationId)).toMatchObject({
        status: "RESOLVED",
        resolutionKind: "OBSOLETE",
        recoveryAttemptId: null,
      });
    });

    it("defers rather than settling when nothing can be planned", async () => {
      const chain = await seedFailure(prisma, { attemptKind: "PRIMARY" });
      const report = await runner({ fx: fakeFx(null) }).runOnce(10);

      expect(report.deferred).toBe(1);
      expect(report.settled).toBe(0);
      // The customer is untouched: a missing rate is the platform's problem.
      const request = await prisma.sceneGenerationRequest.findUnique({
        where: { id: chain.requestId },
      });
      expect(request?.state).toBe("GENERATING");
      expect(request?.failedAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------

  describe("tenancy", () => {
    it("resolves ownership through the chain, not from a supplied id", async () => {
      const chain = await seedFailure(prisma, {
        attemptKind: "PRIMARY",
        organizationId: ORG_B,
      });
      const claimed = await claimOne(chain);
      if (claimed.kind !== "CLAIMED") throw new Error("expected CLAIMED");
      // The organization comes from the validation's own chain, never from a
      // caller: there is no organization parameter to get wrong.
      expect(claimed.claim.organizationId).toBe(ORG_B);
      expect(claimed.claim.organizationId).not.toBe(ORG_A);
    });

    it("treats an unknown validation as not eligible and writes nothing", async () => {
      const outcome = await work.claim({
        sourceValidationId: "momv_does_not_exist",
        now: NOW,
        leaseToken: "lease_x",
        leaseExpiresAt: NOW + LEASE_MS,
      });
      expect(outcome.kind).toBe("NOT_ELIGIBLE");
      expect(await prisma.managedOutputMediaFailureResolution.count()).toBe(0);
    });
  });
});
