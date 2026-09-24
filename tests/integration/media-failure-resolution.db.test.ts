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

    it("refuses a write whose lease token is wrong even when its version matches", async () => {
      // The version guard and the token guard are not the same guard. A worker
      // holding a claim with the right version but somebody else's token must
      // still lose — otherwise ownership is only as good as an integer that two
      // workers can legitimately agree on.
      const chain = await seedFailure(prisma, { attemptKind: "PRIMARY" });
      const claimed = await claimOne(chain);
      if (claimed.kind !== "CLAIMED") throw new Error("expected CLAIMED");

      const impostor = { ...claimed.claim, leaseToken: "lease_not_mine" };
      const lost = await work.resolveObsolete({ claim: impostor, resolvedAt: NOW });
      expect(lost.kind).toBe("LOST");
      expect((await workRow(prisma, chain.validationId))?.status).toBe("RUNNING");

      // The real owner still succeeds.
      const applied = await work.resolveObsolete({ claim: claimed.claim, resolvedAt: NOW });
      expect(applied.kind).toBe("APPLIED");
    });

    it("lets exactly one of two concurrent reclaims of one expired lease win", async () => {
      const chain = await seedFailure(prisma, { attemptKind: "PRIMARY" });
      const first = await claimOne(chain, NOW, "lease_a");
      if (first.kind !== "CLAIMED") throw new Error("expected CLAIMED");

      const at = NOW + LEASE_MS + 1;
      const [b, c] = await Promise.all([
        claimOne(chain, at, "lease_b"),
        claimOne(chain, at, "lease_c"),
      ]);

      // Both read the same expired row and both try to take it. Only the
      // version-pinned CAS can settle that.
      expect([b.kind, c.kind].sort()).toEqual(["CLAIMED", "NOT_CLAIMED"]);
      const row = await workRow(prisma, chain.validationId);
      expect(row?.attemptCount).toBe(2);
      expect(row?.version).toBe(2);
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
    /**
     * The slow-scheduler case, which deferral alone does not solve.
     *
     * If the scheduler runs less often than the retry delay, every deferred row
     * is due again by the time the next pass happens. Ordering by `validatedAt`
     * would then hand the batch straight back to the same old prefix, forever.
     * What breaks the cycle is that a deferral moves the row's *place in the
     * queue*: ordering is by when a row became eligible, so a deferred row sorts
     * behind everything that has been waiting since before its new
     * `nextAttemptAt`.
     *
     * This test deliberately does the opposite of the one below it: the second
     * pass happens at `retryDelay + epsilon`, when the whole deferred prefix is
     * eligible again.
     */
    /**
     * A reclaimable row queues by when its lease expired, not by its verdict.
     *
     * The `RUNNING` arm of the ordering is otherwise invisible: a row whose owner
     * died has been *waiting* only since the lease expired, however old the
     * verdict underneath it is. Ordering it by `validatedAt` would let a
     * long-abandoned lease jump ahead of work that has genuinely been waiting
     * longer — the same starvation as the `PENDING` case, through a different
     * column.
     */
    it("orders a reclaimable row by its lease expiry, not by its verdict", async () => {
      // The oldest verdict in the database, but its lease only just expired.
      const reclaimable = await seedFailure(prisma, {
        attemptKind: "PRIMARY",
        validatedAt: new Date(Date.UTC(2026, 8, 1)),
      });
      // A newer verdict that has been waiting, untouched, ever since.
      const waiting = await seedFailure(prisma, {
        attemptKind: "PRIMARY",
        validatedAt: new Date(Date.UTC(2026, 8, 5)),
      });

      const claimed = await claimOne(reclaimable, NOW, "lease_stale");
      if (claimed.kind !== "CLAIMED") throw new Error("expected CLAIMED");
      // Its owner is now presumed dead, as of a moment ago.
      await prisma.$executeRaw`
        UPDATE "managed_output_media_failure_resolutions"
           SET "leaseExpiresAt" = ${new Date(NOW - 1_000)}
         WHERE "managedOutputMediaValidationId" = ${reclaimable.validationId}
      `;

      const found = await work.findResolutionCandidates({ now: NOW, limit: 10 });
      const ids = found.map((c) => c.sourceValidationId);
      expect(ids).toContain(reclaimable.validationId);
      expect(ids).toContain(waiting.validationId);
      // The untouched row has been waiting since 5 September; the reclaimable one
      // only since a second ago, despite its older verdict.
      expect(ids.indexOf(waiting.validationId)).toBeLessThan(
        ids.indexOf(reclaimable.validationId),
      );
      expect(ids[0]).toBe(waiting.validationId);
    });

    it("reaches an actionable candidate even when the next pass is later than the retry", async () => {
      const RETRY_MS = 5 * 60 * 1000;
      const LIMIT = 3;

      // The prefix: as old as it gets, and unplannable.
      const blocked: FailureChain[] = [];
      for (let i = 0; i < LIMIT; i += 1) {
        blocked.push(
          await seedFailure(prisma, {
            attemptKind: "PRIMARY",
            validatedAt: new Date(Date.UTC(2026, 8, 1, i)),
          }),
        );
      }
      // Actionable, and *newer* than the whole prefix — so `validatedAt` ordering
      // alone would never reach it.
      const actionable = await seedFailure(prisma, {
        attemptKind: "PRIMARY",
        validatedAt: new Date(Date.UTC(2026, 8, 2)),
      });

      // Pass 1: the prefix fills the batch and defers. The actionable row is not
      // even offered.
      const first = await runner({ fx: fakeFx(null), now: () => NOW }).runOnce(LIMIT);
      expect(first.claimed).toBe(LIMIT);
      expect(first.deferred).toBe(LIMIT);
      expect(first.outcomes.map((o) => o.sourceValidationId)).not.toContain(
        actionable.validationId,
      );

      // Pass 2 happens *after* the retry is due, so all three deferred rows are
      // eligible again. Under `validatedAt` ordering they would fill the batch a
      // second time; under eligibility ordering the actionable row — waiting
      // since its verdict, which predates their new retry instant — sorts first.
      const slowPass = NOW + RETRY_MS + 1_000;
      const due = await work.findResolutionCandidates({ now: slowPass, limit: LIMIT });
      expect(due.map((c) => c.sourceValidationId)).toContain(actionable.validationId);
      expect(due[0]?.sourceValidationId).toBe(actionable.validationId);

      // Deliberately one slot. Four rows are eligible and three of them are older
      // by verdict; the slot still goes to the actionable one, which is the whole
      // claim. Under `validatedAt` ordering it would go to the prefix.
      const second = await runner({ now: () => slowPass }).runOnce(1);
      expect(second.outcomes.map((o) => o.sourceValidationId)).toEqual([
        actionable.validationId,
      ]);
      // It was not merely offered — it was acted on, and its work is done.
      expect(await workRow(prisma, actionable.validationId)).toMatchObject({
        status: "RESOLVED",
        resolutionKind: "RECOVERY_ADMITTED",
      });

      // And repeated deferral keeps moving eligibility forward rather than
      // parking a row at one fixed instant. The prefix is still PENDING, so a
      // third slow pass defers it again — further into the future each time.
      const beforeAgain = await workRow(prisma, blocked[0]!.validationId);
      expect(beforeAgain?.status).toBe("PENDING");
      const thirdPass = slowPass + RETRY_MS + 1_000;
      await runner({ fx: fakeFx(null), now: () => thirdPass }).runOnce(LIMIT);
      const afterAgain = await workRow(prisma, blocked[0]!.validationId);
      expect(afterAgain?.status).toBe("PENDING");
      expect(afterAgain?.nextAttemptAt?.getTime()).toBeGreaterThan(
        beforeAgain?.nextAttemptAt?.getTime() ?? 0,
      );
      expect(afterAgain?.attemptCount).toBeGreaterThan(beforeAgain?.attemptCount ?? 0);
    });

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
