import { createDeliverableValidationRepository } from "@app/database";
import {
  DeliverableValidationRunner,
  ISO_BMFF_CONTAINER,
  plannedDeliverableMedia,
  type DeliverableValidationClaim,
  type DeliverableValidationPublicationTarget,
  type ManagedOutputMediaFacts,
} from "@app/domain";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eventCount, jobOf } from "./deliverable-composition-execution-fixture";
import {
  reservationOf,
  seedComposedDeliverable,
  seedRecomposedDeliverable,
  validationOf,
  type ComposedDeliverable,
} from "./deliverable-validation-fixture";
import { ctx, dropTenants, HAS_DB, seedTenants, wipeOrchestration } from "./orchestration-fixture";

/**
 * A deliverable must measure the frame size its composition froze and the length
 * its job was admitted for (ADR-0081), against live PostgreSQL.
 *
 * The fixture composes through the real Transactions I and J2: a 16:9 1080p job
 * of ten seconds, frozen under profile v2 at 30 fps. The plan is therefore
 * 1920x1080 and 10,000 ms, within 34 ms.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const repository = createDeliverableValidationRepository(prisma);

const NOW = Date.UTC(2026, 9, 24, 9, 0, 0);

const ON_PLAN: ManagedOutputMediaFacts = {
  container: ISO_BMFF_CONTAINER,
  durationMs: 10_000,
  videoWidth: 1920,
  videoHeight: 1080,
  videoStreamCount: 1,
  audioStreamCount: 0,
};

const OFF_PLAN: readonly { readonly label: string; readonly facts: ManagedOutputMediaFacts }[] = [
  { label: "another frame size", facts: { ...ON_PLAN, videoWidth: 1280, videoHeight: 720 } },
  { label: "a length one millisecond past a frame", facts: { ...ON_PLAN, durationMs: 10_035 } },
  { label: "a missing scene", facts: { ...ON_PLAN, durationMs: 5_000 } },
];

let leaseSeq = 0;

async function claim(composed: ComposedDeliverable): Promise<DeliverableValidationClaim> {
  leaseSeq += 1;
  const claimed = await repository.claimDeliverableValidation({
    organizationId: composed.organizationId,
    deliverableVersionId: composed.deliverableVersionId,
    now: NOW,
    leaseToken: `vlease_plan_${leaseSeq}`,
    leaseExpiresAt: NOW + 15 * 60_000,
  });
  if (claimed.kind !== "CLAIMED") throw new Error(`expected CLAIMED, got ${claimed.kind}`);
  return claimed.claim;
}

function finalizeValid(validationClaim: DeliverableValidationClaim, facts: ManagedOutputMediaFacts) {
  return repository.finalizeValid({
    claim: validationClaim,
    facts,
    validatedAt: NOW + 1_000,
    context: ctx(),
  });
}

async function validated(composed: ComposedDeliverable): Promise<DeliverableValidationPublicationTarget> {
  const finalized = await finalizeValid(await claim(composed), ON_PLAN);
  if (finalized.kind === "LEASE_LOST") throw new Error("expected a written verdict");
  return finalized.publication;
}

function publish(publication: DeliverableValidationPublicationTarget) {
  return repository.publishDeliverable({ publication, publishedAt: NOW + 2_000, context: ctx() });
}

/** Everything the verdict and Transaction G would write. */
async function state(composed: ComposedDeliverable) {
  const job = await jobOf(prisma, composed.jobId);
  const reservation = await reservationOf(prisma, composed.reservationId);
  const validation = await validationOf(prisma, composed.deliverableVersionId);
  return {
    job: [job.state, job.stateVersion, job.currentDeliverableVersionId],
    reservation: [reservation.state, reservation.stateVersion],
    validation: [validation?.status, validation?.version, validation?.invalidReason],
    events: await eventCount(prisma),
  };
}

/** A VALID row's stored facts altered by hand, and the plan they now miss. */
interface FactAlteration {
  readonly label: string;
  readonly data: { readonly videoWidth?: bigint; readonly durationMs?: bigint };
}

const FACT_ALTERATIONS: readonly FactAlteration[] = [
  { label: "a stored width the composition did not freeze", data: { videoWidth: 1280n } },
  { label: "a stored length beyond one frame", data: { durationMs: 10_035n } },
];

async function alterFacts(composed: ComposedDeliverable, data: FactAlteration["data"]) {
  await prisma.generationDeliverableValidation.update({
    where: { deliverableVersionId: composed.deliverableVersionId },
    data,
  });
}

RUN("ADR-0081 — a deliverable must measure its planned size and length", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  it("hands the worker the plan the composition and the job froze", async () => {
    expect((await claim(await seedComposedDeliverable(prisma))).plannedMedia).toEqual({
      widthPx: 1920,
      heightPx: 1080,
      durationMs: 10_000,
      durationToleranceMs: 34,
    });
    // Another target and length: the plan follows the rows, not a constant.
    const portrait = await seedComposedDeliverable(prisma, {
      targetAspectRatio: "9:16",
      targetOutputResolution: "720p",
      sceneCount: 6,
      requestedDurationSeconds: 30,
    });
    expect((await claim(portrait)).plannedMedia).toEqual({
      widthPx: 720,
      heightPx: 1280,
      durationMs: 30_000,
      durationToleranceMs: 34,
    });
  });

  for (const off of OFF_PLAN) {
    it(`refuses a VALID verdict for ${off.label}, writing nothing`, async () => {
      const composed = await seedComposedDeliverable(prisma);
      const held = await claim(composed);
      const before = await state(composed);

      await expect(finalizeValid(held, off.facts)).rejects.toThrow(
        expect.objectContaining({ code: "VALID_FACTS_OFF_PLAN" }),
      );
      expect(await state(composed)).toEqual(before);
      expect(before.validation[0]).toBe("RUNNING");

      // The lease is still held, and the planned video's verdict is written.
      expect((await finalizeValid(held, ON_PLAN)).kind).toBe("FINALIZED");
    });
  }

  it("writes a VALID verdict within one frame of the planned length", async () => {
    for (const durationMs of [10_034, 9_966]) {
      const composed = await seedComposedDeliverable(prisma);
      expect((await finalizeValid(await claim(composed), { ...ON_PLAN, durationMs })).kind).toBe(
        "FINALIZED",
      );
    }
  });

  it("judges a verdict against its own read of the rows, not the claim's copy", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const held = await claim(composed);
    const forged: DeliverableValidationClaim = {
      ...held,
      plannedMedia: { widthPx: 1280, heightPx: 720, durationMs: 10_000, durationToleranceMs: 34 },
    };
    await expect(
      finalizeValid(forged, { ...ON_PLAN, videoWidth: 1280, videoHeight: 720 }),
    ).rejects.toThrow(expect.objectContaining({ code: "VALID_FACTS_OFF_PLAN" }));
  });

  it("records an off-plan video as INVALID_MEDIA through the runner, holding the job and its Unit", async () => {
    const cases = [
      { facts: { ...ON_PLAN, videoWidth: 1080, videoHeight: 1920 }, reason: "VIDEO_DIMENSIONS_INVALID" },
      { facts: { ...ON_PLAN, durationMs: 15_000 }, reason: "DURATION_INVALID" },
    ] as const;
    for (const { facts, reason } of cases) {
      const composed = await seedComposedDeliverable(prisma);
      const runner = new DeliverableValidationRunner(
        {},
        {
          repository,
          validator: { validateDeliverable: async () => ({ kind: "VALID", facts }) },
          clock: () => NOW,
          leaseTokens: { next: () => `vlease_plan_runner_${reason}` },
        },
      );
      expect(
        await runner.runOne(composed.organizationId, composed.deliverableVersionId, ctx()),
      ).toEqual({ kind: "INVALID_MEDIA" });

      const after = await state(composed);
      expect(after.validation).toEqual(["INVALID_MEDIA", 2, reason]);
      // A verdict, not a settlement: nothing reaches the customer and the hold
      // stays where it was (ADR-0052 Decision 19 is the terminal path's, TODO).
      expect(after.job).toEqual(["DELIVERABLE_VALIDATING", expect.any(Number), null]);
      expect(after.reservation[0]).toBe("RESERVED");
      // And it is terminal: no later pass re-validates it.
      expect(
        (
          await repository.claimDeliverableValidation({
            organizationId: composed.organizationId,
            deliverableVersionId: composed.deliverableVersionId,
            now: NOW + 60 * 60_000,
            leaseToken: "vlease_plan_again",
            leaseExpiresAt: NOW + 2 * 60 * 60_000,
          })
        ).kind,
      ).toBe("ALREADY_TERMINAL");
    }
  });

  for (const alteration of FACT_ALTERATIONS) {
    it(`refuses to publish a verdict with ${alteration.label}, writing nothing`, async () => {
      const composed = await seedComposedDeliverable(prisma);
      const publication = await validated(composed);
      await alterFacts(composed, alteration.data);
      const before = await state(composed);

      await expect(publish(publication)).rejects.toThrow(
        expect.objectContaining({ code: "VALID_FACTS_OFF_PLAN" }),
      );
      expect(await state(composed)).toEqual(before);
      expect(before.reservation[0]).toBe("RESERVED");

      await alterFacts(composed, { videoWidth: 1920n, durationMs: 10_000n });
      expect((await publish(publication)).kind).toBe("PUBLISHED_AND_CONSUMED");
    });

    it(`refuses a replacement with ${alteration.label}, keeping the customer's video`, async () => {
      const first = await seedComposedDeliverable(prisma);
      expect((await publish(await validated(first))).kind).toBe("PUBLISHED_AND_CONSUMED");
      const second = await seedRecomposedDeliverable(prisma, first);
      const publication = await validated(second);
      await alterFacts(second, alteration.data);
      const before = await state(second);

      await expect(publish(publication)).rejects.toThrow(
        expect.objectContaining({ code: "VALID_FACTS_OFF_PLAN" }),
      );
      expect(await state(second)).toEqual(before);
      expect(before.job[2]).toBe(first.deliverableVersionId);

      await alterFacts(second, { videoWidth: 1920n, durationMs: 10_000n });
      expect((await publish(publication)).kind).toBe("PUBLISHED_AS_REPLACEMENT");
    });
  }

  it("refuses to publish once the composition's frozen raster no longer matches the verdict", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(composed);
    await prisma.generationDeliverableComposition.update({
      where: { deliverableVersionId: composed.deliverableVersionId },
      data: { targetWidthPx: 1280, targetHeightPx: 720 },
    });

    await expect(publish(publication)).rejects.toThrow(
      expect.objectContaining({ code: "VALID_FACTS_OFF_PLAN" }),
    );
  });

  it("offers a verdict awaiting publication only while its stored facts are on plan", async () => {
    const composed = await seedComposedDeliverable(prisma);
    await validated(composed);
    const offered = async () =>
      (await repository.findValidationCandidates({ now: NOW + 5_000, limit: 25 })).map(
        (candidate) => candidate.deliverableVersionId,
      );
    expect(await offered()).toEqual([composed.deliverableVersionId]);

    for (const data of [{ videoWidth: 1280n }, { videoHeight: 720n }]) {
      await alterFacts(composed, data);
      expect(await offered()).toEqual([]);
      await alterFacts(composed, { videoWidth: 1920n, videoHeight: 1080n });
    }

    // Discovery's tolerance is `plannedDeliverableMedia`'s, at every rate,
    // on both sides of the boundary.
    for (const [frameRateNumerator, frameRateDenominator] of [
      [30, 1],
      [30_000, 1_001],
      [25, 1],
      [24, 1],
    ] as const) {
      await prisma.generationDeliverableComposition.update({
        where: { deliverableVersionId: composed.deliverableVersionId },
        data: { frameRateNumerator, frameRateDenominator },
      });
      const { durationToleranceMs } = plannedDeliverableMedia({
        targetWidthPx: 1920,
        targetHeightPx: 1080,
        frameRateNumerator,
        frameRateDenominator,
        requestedDurationSeconds: 10,
      });
      for (const [delta, expected] of [
        [durationToleranceMs, [composed.deliverableVersionId]],
        [-durationToleranceMs, [composed.deliverableVersionId]],
        [durationToleranceMs + 1, []],
        [-durationToleranceMs - 1, []],
      ] as const) {
        await alterFacts(composed, { durationMs: BigInt(10_000 + delta) });
        expect(await offered(), `${frameRateNumerator}/${frameRateDenominator} ${delta}`).toEqual(
          expected,
        );
      }
    }
  });

  it("does not judge a replay: the publication it names already happened", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(composed);
    expect((await publish(publication)).kind).toBe("PUBLISHED_AND_CONSUMED");
    await alterFacts(composed, { videoWidth: 1280n });
    const before = await state(composed);

    expect((await publish(publication)).kind).toBe("ALREADY_PUBLISHED");
    expect(await state(composed)).toEqual(before);
  });
});
