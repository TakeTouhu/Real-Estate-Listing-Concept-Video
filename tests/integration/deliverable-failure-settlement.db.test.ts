import {
  createDeliverableCompositionExecutionRepository,
  createDeliverableCompositionPlanRepository,
  createDeliverableValidationRepository,
  createGenerationJobRepository,
} from "@app/database";
import {
  ISO_BMFF_CONTAINER,
  type DeliverableCompositionClaim,
  type DeliverableValidationClaim,
  type GenerationJobState,
  type GenerationReservationState,
  type ManagedOutputMediaFacts,
} from "@app/domain";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  compositionOf,
  eventCount,
  eventsFor,
  jobOf,
  seedPlannedDeliverable,
} from "./deliverable-composition-execution-fixture";
import {
  reservationOf,
  seedComposedDeliverable,
  seedRecomposedDeliverable,
  validationOf,
  type ComposedDeliverable,
} from "./deliverable-validation-fixture";
import { ctx, dropTenants, HAS_DB, ORG_A, ORG_B, seedTenants, wipeOrchestration } from "./orchestration-fixture";

/**
 * ADR-0082 against live PostgreSQL: a deliverable cycle that ends without a
 * usable video settles its job in the same commit that records why.
 *
 * The happy shapes are pinned beside the code that writes them (the composition
 * and validation suites). This suite holds what only the settlement adds: the
 * replacement and reconciliation-hold arms, the refusals that must write
 * nothing, the replay that finds a settlement missing, the cycles a job no
 * longer runs, tenancy, the generic edges it now owns, and the lock order.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const composition = createDeliverableCompositionExecutionRepository(prisma);
const validation = createDeliverableValidationRepository(prisma);
const jobs = createGenerationJobRepository(prisma);

const NOW = Date.UTC(2026, 8, 26, 9, 0, 0);
const LEASE_MS = 15 * 60_000;

const FACTS: ManagedOutputMediaFacts = {
  container: ISO_BMFF_CONTAINER,
  durationMs: 10_000,
  videoWidth: 1920,
  videoHeight: 1080,
  videoStreamCount: 1,
  audioStreamCount: 0,
};

let seq = 0;

async function claimComposition(
  organizationId: string,
  deliverableVersionId: string,
): Promise<DeliverableCompositionClaim> {
  seq += 1;
  const outcome = await composition.claimCompositionWork({
    organizationId,
    deliverableVersionId,
    now: NOW,
    leaseToken: `clease_settle_${seq}`,
    leaseExpiresAt: NOW + LEASE_MS,
    context: ctx(),
  });
  if (outcome.kind !== "CLAIMED") throw new Error(`composition claim: ${outcome.kind}`);
  return outcome.claim;
}

async function claimValidation(
  organizationId: string,
  deliverableVersionId: string,
): Promise<DeliverableValidationClaim> {
  seq += 1;
  const outcome = await validation.claimDeliverableValidation({
    organizationId,
    deliverableVersionId,
    now: NOW,
    leaseToken: `vlease_settle_${seq}`,
    leaseExpiresAt: NOW + LEASE_MS,
  });
  if (outcome.kind !== "CLAIMED") throw new Error(`validation claim: ${outcome.kind}`);
  return outcome.claim;
}

function block(claim: DeliverableCompositionClaim) {
  return composition.blockComposition({
    claim,
    blockCode: "SOURCE_INTEGRITY_MISMATCH",
    blockedAt: NOW + 1_000,
    context: ctx(),
  });
}

function reject(claim: DeliverableValidationClaim) {
  return validation.finalizeIntegrityMismatch({ claim, validatedAt: NOW + 1_000, context: ctx() });
}

async function publish(composed: ComposedDeliverable): Promise<void> {
  const claim = await claimValidation(composed.organizationId, composed.deliverableVersionId);
  const finalized = await validation.finalizeValid({
    claim,
    facts: FACTS,
    validatedAt: NOW + 1_000,
    context: ctx(),
  });
  if (finalized.kind === "LEASE_LOST") throw new Error("expected a verdict");
  const published = await validation.publishDeliverable({
    publication: finalized.publication,
    publishedAt: NOW + 2_000,
    context: ctx(),
  });
  if (published.kind !== "PUBLISHED_AND_CONSUMED") throw new Error(`publish: ${published.kind}`);
}

/**
 * A job that delivered a video, walked back to plan a replacement and claimed
 * for its composition. The walk is raw, as `seedRecomposedDeliverable` explains;
 * every row after it is the real transactions'.
 */
async function claimedReplacementComposition() {
  const first = await seedComposedDeliverable(prisma);
  await publish(first);
  const job = await jobOf(prisma, first.jobId);
  await prisma.generationJob.update({
    where: { id: first.jobId },
    data: { state: "SCENES_READY", stateVersion: job.stateVersion + 1 },
  });
  seq += 1;
  const plan = await createDeliverableCompositionPlanRepository(prisma).admitCompositionPlan({
    organizationId: first.organizationId,
    generationJobId: first.jobId,
    deliverableVersionId: `gdv_settle_${seq}`,
    context: ctx(),
  });
  if (plan.kind !== "PLANNED") throw new Error(`replan: ${plan.kind}`);
  const claim = await claimComposition(first.organizationId, plan.deliverableVersionId);
  return { first, claim, deliverableVersionId: plan.deliverableVersionId };
}

/** The hold, moved by hand into a state the scenario needs. */
async function setReservation(reservationId: string, state: GenerationReservationState) {
  const before = await reservationOf(prisma, reservationId);
  await prisma.generationReservation.update({
    where: { id: reservationId },
    data: {
      state,
      stateVersion: before.stateVersion + 1,
      consumedAt: state === "CONSUMED" ? new Date(NOW) : null,
      releasedAt: state === "RELEASED" ? new Date(NOW) : null,
    },
  });
}

async function setJob(jobId: string, state: GenerationJobState) {
  const before = await jobOf(prisma, jobId);
  await prisma.generationJob.update({
    where: { id: jobId },
    data: { state, stateVersion: before.stateVersion + 1 },
  });
}

/** A newer version of the job, inserted by hand: the cycle the job now runs. */
async function insertNewerVersion(jobId: string) {
  seq += 1;
  await prisma.generationDeliverableVersion.create({
    data: {
      id: `gdv_settle_newer_${seq}`,
      generationJobId: jobId,
      ordinal: 2,
      disclosureMode: "THROUGHOUT",
      inputFingerprint: `sha256:deliverable-input:v2:${"a".repeat(64)}`,
    },
  });
}

/** Every row a settlement could touch, for "nothing was written". */
async function snapshot(jobId: string, reservationId: string, deliverableVersionId: string) {
  return {
    job: await jobOf(prisma, jobId),
    reservation: await reservationOf(prisma, reservationId),
    composition: await compositionOf(prisma, deliverableVersionId),
    validation: await validationOf(prisma, deliverableVersionId),
    events: await eventCount(prisma),
  };
}

function lastEvent(events: Awaited<ReturnType<typeof eventsFor>>) {
  const last = events.at(-1);
  return [last?.fromState, last?.toState, last?.eventType, last?.reasonCode];
}

/**
 * How many backends in this database are waiting on the lock a settlement takes
 * first: a reservation row's (a statement over `generation_reservations` waiting
 * on another transaction), or the cost-admission advisory lock.
 */
async function blockedBackends(on: "reservation" | "advisory"): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ wait_event: string | null; query: string }[]>(
    `SELECT wait_event, query FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'`,
  );
  return rows.filter((r) =>
    on === "advisory"
      ? r.wait_event === "advisory"
      : r.wait_event !== "advisory" && r.query.includes("FOR UPDATE OF res"),
  ).length;
}

async function waitForBlocked(count: number, on: "reservation" | "advisory"): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if ((await blockedBackends(on)) >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

RUN("ADR-0082 — a failed deliverable settles its job in the same commit", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  describe("the replacement arm", () => {
    it("rolls a blocked replacement back to the customer's video, its Unit untouched", async () => {
      const { first, claim, deliverableVersionId } = await claimedReplacementComposition();
      const jobBefore = await jobOf(prisma, first.jobId);
      const reservationBefore = await reservationOf(prisma, first.reservationId);
      const reservationEvents = (await eventsFor(prisma, first.reservationId)).length;

      expect(await block(claim)).toEqual({ kind: "BLOCKED" });

      const job = await jobOf(prisma, first.jobId);
      expect([job.state, job.stateVersion, job.currentDeliverableVersionId]).toEqual([
        "DELIVERABLE_READY",
        jobBefore.stateVersion + 1,
        first.deliverableVersionId,
      ]);
      expect(await reservationOf(prisma, first.reservationId)).toEqual(reservationBefore);
      expect((await eventsFor(prisma, first.reservationId)).length).toBe(reservationEvents);
      expect(lastEvent(await eventsFor(prisma, first.jobId))).toEqual([
        "COMPOSING",
        "DELIVERABLE_READY",
        "job.deliverable_rolled_back",
        "DELIVERABLE_FAILURE_SETTLEMENT",
      ]);
      expect((await compositionOf(prisma, deliverableVersionId))?.status).toBe("BLOCKED");
      // A settled replay settles nothing again.
      const events = await eventCount(prisma);
      expect(await block(claim)).toEqual({ kind: "ALREADY_BLOCKED" });
      expect(await eventCount(prisma)).toBe(events);
    });

    it("rolls a rejected replacement back the same way", async () => {
      const first = await seedComposedDeliverable(prisma);
      await publish(first);
      const second = await seedRecomposedDeliverable(prisma, first);
      const reservationBefore = await reservationOf(prisma, first.reservationId);
      const claim = await claimValidation(second.organizationId, second.deliverableVersionId);

      expect(await reject(claim)).toEqual({ kind: "FINALIZED" });

      const job = await jobOf(prisma, first.jobId);
      expect([job.state, job.currentDeliverableVersionId]).toEqual([
        "DELIVERABLE_READY",
        first.deliverableVersionId,
      ]);
      expect(await reservationOf(prisma, first.reservationId)).toEqual(reservationBefore);
      expect(lastEvent(await eventsFor(prisma, first.jobId))).toEqual([
        "DELIVERABLE_VALIDATING",
        "DELIVERABLE_READY",
        "job.deliverable_rolled_back",
        "DELIVERABLE_FAILURE_SETTLEMENT",
      ]);
      const events = await eventCount(prisma);
      expect(await reject(claim)).toEqual({ kind: "ALREADY_FINALIZED" });
      expect(await eventCount(prisma)).toBe(events);
    });
  });

  describe("a replay after the job moved on to a later cycle", () => {
    it("answers a replacement's block as recorded while a newer version composes", async () => {
      const { first, claim } = await claimedReplacementComposition();
      await block(claim);
      // The job starts another cycle: version three is planned and composing.
      await setJob(first.jobId, "SCENES_READY");
      seq += 1;
      const plan = await createDeliverableCompositionPlanRepository(prisma).admitCompositionPlan({
        organizationId: first.organizationId,
        generationJobId: first.jobId,
        deliverableVersionId: `gdv_settle_${seq}`,
        context: ctx(),
      });
      if (plan.kind !== "PLANNED") throw new Error(`replan: ${plan.kind}`);
      await claimComposition(first.organizationId, plan.deliverableVersionId);
      expect((await jobOf(prisma, first.jobId)).state).toBe("COMPOSING");

      expect(await block(claim)).toEqual({ kind: "ALREADY_BLOCKED" });
    });

    it("answers a replacement's verdict as recorded while a newer version validates", async () => {
      const first = await seedComposedDeliverable(prisma);
      await publish(first);
      const second = await seedRecomposedDeliverable(prisma, first);
      const claim = await claimValidation(second.organizationId, second.deliverableVersionId);
      await reject(claim);
      await seedRecomposedDeliverable(prisma, second);
      expect((await jobOf(prisma, first.jobId)).state).toBe("DELIVERABLE_VALIDATING");

      expect(await reject(claim)).toEqual({ kind: "ALREADY_FINALIZED" });
    });
  });

  describe("a Unit held for reconciliation", () => {
    it("is released by a block", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      await setReservation(planned.reservationId, "RECONCILIATION_HOLD");
      const claim = await claimComposition(ORG_A, planned.deliverableVersionId);

      expect(await block(claim)).toEqual({ kind: "BLOCKED" });

      const reservation = await reservationOf(prisma, planned.reservationId);
      expect([reservation.state, reservation.releasedAt, reservation.consumedAt]).toEqual([
        "RELEASED",
        new Date(NOW + 1_000),
        null,
      ]);
      expect(lastEvent(await eventsFor(prisma, planned.reservationId))).toEqual([
        "RECONCILIATION_HOLD",
        "RELEASED",
        "reservation.released",
        "DELIVERABLE_FAILURE_SETTLEMENT",
      ]);
      expect((await jobOf(prisma, planned.jobId)).state).toBe("FAILED_TERMINAL");
    });

    it("is released by a verdict", async () => {
      const composed = await seedComposedDeliverable(prisma);
      await setReservation(composed.reservationId, "RECONCILIATION_HOLD");
      const claim = await claimValidation(composed.organizationId, composed.deliverableVersionId);

      expect(await reject(claim)).toEqual({ kind: "FINALIZED" });

      expect((await reservationOf(prisma, composed.reservationId)).state).toBe("RELEASED");
      expect((await jobOf(prisma, composed.jobId)).state).toBe("FAILED_TERMINAL");
    });
  });

  describe("a reservation that contradicts its job writes nothing", () => {
    it.each([["RELEASED"], ["CONSUMED"], ["RESERVING"]] as const)(
      "refuses to block an initial generation whose Unit is %s",
      async (state) => {
        const planned = await seedPlannedDeliverable(prisma);
        const claim = await claimComposition(ORG_A, planned.deliverableVersionId);
        await setReservation(planned.reservationId, state);
        const before = await snapshot(planned.jobId, planned.reservationId, planned.deliverableVersionId);

        await expect(block(claim)).rejects.toThrow(
          expect.objectContaining({ code: "RESERVATION_NOT_SETTLEABLE" }),
        );
        // The block rolled back with it: the work is still running, not BLOCKED.
        expect(
          await snapshot(planned.jobId, planned.reservationId, planned.deliverableVersionId),
        ).toEqual(before);
        expect(before.composition?.status).toBe("RUNNING");
      },
    );

    it("refuses to block a replacement whose earlier delivery's Unit is not consumed", async () => {
      const { first, claim, deliverableVersionId } = await claimedReplacementComposition();
      await setReservation(first.reservationId, "RESERVED");
      const before = await snapshot(first.jobId, first.reservationId, deliverableVersionId);

      await expect(block(claim)).rejects.toThrow(
        expect.objectContaining({ code: "RESERVATION_NOT_SETTLEABLE" }),
      );
      expect(await snapshot(first.jobId, first.reservationId, deliverableVersionId)).toEqual(before);
    });

    it("refuses a verdict on an initial generation whose Unit is already consumed", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const claim = await claimValidation(composed.organizationId, composed.deliverableVersionId);
      await setReservation(composed.reservationId, "CONSUMED");
      const before = await snapshot(composed.jobId, composed.reservationId, composed.deliverableVersionId);

      await expect(reject(claim)).rejects.toThrow(
        expect.objectContaining({ code: "RESERVATION_NOT_SETTLEABLE" }),
      );
      expect(
        await snapshot(composed.jobId, composed.reservationId, composed.deliverableVersionId),
      ).toEqual(before);
      expect(before.validation?.status).toBe("RUNNING");
    });
  });

  describe("a replay that finds its settlement missing", () => {
    it("refuses a recorded block whose job still holds the Unit", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const claim = await claimComposition(ORG_A, planned.deliverableVersionId);
      await block(claim);
      // The shape a block recorded before ADR-0082 left behind.
      await setJob(planned.jobId, "COMPOSING");
      await setReservation(planned.reservationId, "RESERVED");
      const before = await snapshot(planned.jobId, planned.reservationId, planned.deliverableVersionId);

      await expect(block(claim)).rejects.toThrow(
        expect.objectContaining({ code: "SETTLEMENT_INCOMPLETE" }),
      );
      expect(
        await snapshot(planned.jobId, planned.reservationId, planned.deliverableVersionId),
      ).toEqual(before);
    });

    it("refuses a recorded block whose replacement never rolled back", async () => {
      const { first, claim, deliverableVersionId } = await claimedReplacementComposition();
      await block(claim);
      await setJob(first.jobId, "COMPOSING");

      await expect(block(claim)).rejects.toThrow(
        expect.objectContaining({ code: "SETTLEMENT_INCOMPLETE" }),
      );
      expect((await compositionOf(prisma, deliverableVersionId))?.status).toBe("BLOCKED");
    });

    it("refuses a recorded verdict whose job still holds the Unit", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const claim = await claimValidation(composed.organizationId, composed.deliverableVersionId);
      await reject(claim);
      await setJob(composed.jobId, "DELIVERABLE_VALIDATING");
      await setReservation(composed.reservationId, "RESERVED");
      const before = await snapshot(composed.jobId, composed.reservationId, composed.deliverableVersionId);

      await expect(reject(claim)).rejects.toThrow(
        expect.objectContaining({ code: "SETTLEMENT_INCOMPLETE" }),
      );
      expect(
        await snapshot(composed.jobId, composed.reservationId, composed.deliverableVersionId),
      ).toEqual(before);
    });
  });

  describe("a cycle the job no longer runs is left alone", () => {
    it("loses a block once a newer version exists", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const claim = await claimComposition(ORG_A, planned.deliverableVersionId);
      await insertNewerVersion(planned.jobId);
      const before = await snapshot(planned.jobId, planned.reservationId, planned.deliverableVersionId);

      expect(await block(claim)).toEqual({ kind: "LEASE_LOST" });
      expect(
        await snapshot(planned.jobId, planned.reservationId, planned.deliverableVersionId),
      ).toEqual(before);
    });

    it("loses a block once the job has left composing", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const claim = await claimComposition(ORG_A, planned.deliverableVersionId);
      await setJob(planned.jobId, "SCENES_READY");
      const before = await snapshot(planned.jobId, planned.reservationId, planned.deliverableVersionId);

      expect(await block(claim)).toEqual({ kind: "LEASE_LOST" });
      expect(
        await snapshot(planned.jobId, planned.reservationId, planned.deliverableVersionId),
      ).toEqual(before);
    });

    it("loses a block whose claim names another version's work", async () => {
      // The version and its chain are one job's; the work row, its version and
      // its lease are another job's, still RUNNING. Neither job is settled.
      const mine = await seedPlannedDeliverable(prisma);
      await claimComposition(ORG_A, mine.deliverableVersionId);
      const other = await seedPlannedDeliverable(prisma);
      const otherClaim = await claimComposition(ORG_A, other.deliverableVersionId);
      const beforeMine = await snapshot(mine.jobId, mine.reservationId, mine.deliverableVersionId);
      const beforeOther = await snapshot(other.jobId, other.reservationId, other.deliverableVersionId);

      expect(
        await block({ ...otherClaim, deliverableVersionId: mine.deliverableVersionId }),
      ).toEqual({ kind: "LEASE_LOST" });
      expect(await snapshot(mine.jobId, mine.reservationId, mine.deliverableVersionId)).toEqual(
        beforeMine,
      );
      expect(await snapshot(other.jobId, other.reservationId, other.deliverableVersionId)).toEqual(
        beforeOther,
      );
    });

    it("loses a verdict once a newer version exists", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const claim = await claimValidation(composed.organizationId, composed.deliverableVersionId);
      await insertNewerVersion(composed.jobId);
      const before = await snapshot(composed.jobId, composed.reservationId, composed.deliverableVersionId);

      expect(await reject(claim)).toEqual({ kind: "LEASE_LOST" });
      expect(
        await snapshot(composed.jobId, composed.reservationId, composed.deliverableVersionId),
      ).toEqual(before);
    });

    it("loses a verdict once the job has left validation", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const claim = await claimValidation(composed.organizationId, composed.deliverableVersionId);
      await setJob(composed.jobId, "SCENES_READY");
      const before = await snapshot(composed.jobId, composed.reservationId, composed.deliverableVersionId);

      expect(await reject(claim)).toEqual({ kind: "LEASE_LOST" });
      expect(
        await snapshot(composed.jobId, composed.reservationId, composed.deliverableVersionId),
      ).toEqual(before);
    });
  });

  describe("tenancy", () => {
    it("treats another tenant's block or verdict as lost, settling nothing", async () => {
      const planned = await seedPlannedDeliverable(prisma);
      const blockClaim = await claimComposition(ORG_A, planned.deliverableVersionId);
      const composed = await seedComposedDeliverable(prisma);
      const verdictClaim = await claimValidation(ORG_A, composed.deliverableVersionId);
      const events = await eventCount(prisma);

      expect(await block({ ...blockClaim, organizationId: ORG_B })).toEqual({ kind: "LEASE_LOST" });
      expect(await reject({ ...verdictClaim, organizationId: ORG_B })).toEqual({
        kind: "LEASE_LOST",
      });

      expect((await reservationOf(prisma, planned.reservationId)).state).toBe("RESERVED");
      expect((await reservationOf(prisma, composed.reservationId)).state).toBe("RESERVED");
      expect(await eventCount(prisma)).toBe(events);
    });
  });

  describe("the generic transition API", () => {
    it.each([
      ["RESERVED", "CANCELLED"],
      ["RESERVED", "FAILED_TERMINAL"],
      ["GENERATING", "FAILED_TERMINAL"],
      ["SCENES_READY", "FAILED_TERMINAL"],
      ["COMPOSITION_PENDING", "FAILED_TERMINAL"],
      ["COMPOSING", "FAILED_TERMINAL"],
      ["DELIVERABLE_VALIDATING", "FAILED_TERMINAL"],
      ["COMPOSING", "DELIVERABLE_READY"],
    ] as const)("refuses %s -> %s, which would strand or skip a settlement", async (from, to) => {
      const planned = await seedPlannedDeliverable(prisma);
      await setJob(planned.jobId, from);
      const before = await jobOf(prisma, planned.jobId);

      expect(
        await jobs.transition({
          organizationId: ORG_A,
          id: planned.jobId,
          expectedState: from,
          expectedVersion: before.stateVersion,
          nextState: to,
          context: ctx(),
        }),
      ).toEqual({ kind: "TRANSITION_RESERVED" });
      expect(await jobOf(prisma, planned.jobId)).toEqual(before);
      expect((await reservationOf(prisma, planned.reservationId)).state).toBe("RESERVED");
    });
  });

  describe("lock order", () => {
    // A writer holding the reservation that then needs the job is the shape
    // Transactions G, H and I take. Were a settlement to lock the job first, the
    // two would deadlock; taking the reservation first, it simply waits.
    it.each([["block"], ["verdict"]] as const)(
      "a %s waits behind a reservation-first writer instead of deadlocking with it",
      async (kind) => {
        const target =
          kind === "block"
            ? await (async () => {
                const planned = await seedPlannedDeliverable(prisma);
                const claim = await claimComposition(ORG_A, planned.deliverableVersionId);
                return { jobId: planned.jobId, reservationId: planned.reservationId, run: () => block(claim) };
              })()
            : await (async () => {
                const composed = await seedComposedDeliverable(prisma);
                const claim = await claimValidation(ORG_A, composed.deliverableVersionId);
                return { jobId: composed.jobId, reservationId: composed.reservationId, run: () => reject(claim) };
              })();

        const holder = new PrismaClient();
        let mayLockJob: () => void = () => undefined;
        const jobTurn = new Promise<void>((resolve) => {
          mayLockJob = resolve;
        });
        let ready: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const holding = holder.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "generation_reservations" WHERE "id" = ${target.reservationId} FOR UPDATE`;
            ready();
            await jobTurn;
            await tx.$queryRaw`SELECT "id" FROM "generation_jobs" WHERE "id" = ${target.jobId} FOR UPDATE`;
          },
          { timeout: 30_000 },
        );
        try {
          await held;
          // Settled into a value at once, so a deadlock surfaces as a failed
          // assertion below rather than as an unhandled rejection.
          const settling = target.run().then(
            (outcome) => outcome.kind,
            (error: unknown) => `threw: ${String(error)}`,
          );
          expect(await waitForBlocked(1, "reservation")).toBe(true);
          mayLockJob();
          await holding;
          expect(await settling).toBe(kind === "block" ? "BLOCKED" : "FINALIZED");
        } finally {
          mayLockJob();
          await holding.catch(() => undefined);
          await holder.$disconnect();
        }
        expect((await reservationOf(prisma, target.reservationId)).state).toBe("RELEASED");
      },
    );

    // Every entitlement release takes the organization and billing-cycle lock
    // before the reservation (`cost-admission-lock.ts`), so no cost decision for
    // the same cycle runs beside it.
    it.each([["block"], ["verdict"]] as const)(
      "a %s waits for the cost-admission lock of its organization and cycle",
      async (kind) => {
        const target =
          kind === "block"
            ? await (async () => {
                const planned = await seedPlannedDeliverable(prisma);
                const claim = await claimComposition(ORG_A, planned.deliverableVersionId);
                return { reservationId: planned.reservationId, run: () => block(claim) };
              })()
            : await (async () => {
                const composed = await seedComposedDeliverable(prisma);
                const claim = await claimValidation(ORG_A, composed.deliverableVersionId);
                return { reservationId: composed.reservationId, run: () => reject(claim) };
              })();
        const { billingCycleKey } = await prisma.generationReservation.findUniqueOrThrow({
          where: { id: target.reservationId },
          select: { billingCycleKey: true },
        });

        const holder = new PrismaClient();
        let release: () => void = () => undefined;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let ready: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const holding = holder.$transaction(
          async (tx) => {
            // The formula every cost workflow derives, written out on purpose as
            // the media failure settlement's race test does: if it ever changes,
            // this barrier stops blocking and the test fails loudly.
            await tx.$queryRaw`
              SELECT pg_advisory_xact_lock(
                hashtext(${`paid-submission:${ORG_A}`}),
                hashtext(${`cycle:${billingCycleKey}`})
              )::text AS locked
            `;
            ready();
            await released;
          },
          { timeout: 30_000 },
        );
        try {
          await held;
          const settling = target.run().then(
            (outcome) => outcome.kind,
            (error: unknown) => `threw: ${String(error)}`,
          );
          expect(await waitForBlocked(1, "advisory")).toBe(true);
          // Nothing settled while the lock is held.
          expect((await reservationOf(prisma, target.reservationId)).state).toBe("RESERVED");
          release();
          await holding;
          expect(await settling).toBe(kind === "block" ? "BLOCKED" : "FINALIZED");
        } finally {
          release();
          await holding.catch(() => undefined);
          await holder.$disconnect();
        }
        expect((await reservationOf(prisma, target.reservationId)).state).toBe("RELEASED");
      },
    );
  });
});
