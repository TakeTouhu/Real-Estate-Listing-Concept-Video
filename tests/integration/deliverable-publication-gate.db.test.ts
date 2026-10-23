import { createDeliverableValidationRepository } from "@app/database";
import {
  COMPOSITION_PROFILE_KEY,
  ISO_BMFF_CONTAINER,
  managedCleanMasterKey,
  type DeliverableValidationPublicationTarget,
  type ManagedOutputMediaFacts,
} from "@app/domain";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { compositionOf, eventCount, jobOf } from "./deliverable-composition-execution-fixture";
import {
  reservationOf,
  seedComposedDeliverable,
  seedRecomposedDeliverable,
  validationOf,
  type ComposedDeliverable,
} from "./deliverable-validation-fixture";
import { ctx, dropTenants, HAS_DB, ORG_B, seedTenants, wipeOrchestration } from "./orchestration-fixture";

/**
 * Transaction G publishes only a video that carries its version's disclosure
 * and has its Clean Master recorded (ADR-0080), against live PostgreSQL.
 *
 * The fixture composes through the real Transaction J2, so every deliverable
 * here starts out as this build makes it: frozen under profile v2, which drew
 * the version's mode, with its master recorded in the receipt's commit. Each
 * refusal is then produced by altering exactly one of those rows by hand, the
 * only way this build can come to hold one.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const repository = createDeliverableValidationRepository(prisma);

const NOW = Date.UTC(2026, 9, 23, 9, 0, 0);
const V1_PROFILE_KEY = "vtavision-compose:v1";

const FACTS: ManagedOutputMediaFacts = {
  container: ISO_BMFF_CONTAINER,
  durationMs: 10_000,
  videoWidth: 1920,
  videoHeight: 1080,
  videoStreamCount: 1,
  audioStreamCount: 0,
};

let leaseSeq = 0;

/** Claim and record a VALID verdict, leaving only the publication outstanding. */
async function validated(composed: ComposedDeliverable): Promise<DeliverableValidationPublicationTarget> {
  leaseSeq += 1;
  const claimed = await repository.claimDeliverableValidation({
    organizationId: composed.organizationId,
    deliverableVersionId: composed.deliverableVersionId,
    now: NOW,
    leaseToken: `vlease_gate_${leaseSeq}`,
    leaseExpiresAt: NOW + 15 * 60_000,
  });
  if (claimed.kind !== "CLAIMED") throw new Error(`expected CLAIMED, got ${claimed.kind}`);
  const finalized = await repository.finalizeValid({
    claim: claimed.claim,
    facts: FACTS,
    validatedAt: NOW + 1_000,
    context: ctx(),
  });
  if (finalized.kind === "LEASE_LOST") throw new Error("expected a written verdict");
  return finalized.publication;
}

function publish(publication: DeliverableValidationPublicationTarget) {
  return repository.publishDeliverable({ publication, publishedAt: NOW + 2_000, context: ctx() });
}

/** Everything Transaction G would write, read back for an unchanged comparison. */
async function publicationState(composed: ComposedDeliverable) {
  const job = await jobOf(prisma, composed.jobId);
  const reservation = await reservationOf(prisma, composed.reservationId);
  const validation = await validationOf(prisma, composed.deliverableVersionId);
  return {
    job: [job.state, job.stateVersion, job.currentDeliverableVersionId],
    reservation: [reservation.state, reservation.stateVersion, reservation.consumedAt],
    validation: [validation?.status, validation?.version],
    events: await eventCount(prisma),
  };
}

/** The master rows the deleting alteration removed, to put back. */
const stash = new Map<
  string,
  Awaited<ReturnType<typeof prisma.generationDeliverableCleanMaster.findUniqueOrThrow>>
>();

/** One way to hold a version this build would never publish, and its undoing. */
interface Alteration {
  readonly label: string;
  readonly code: "DISCLOSURE_NOT_DRAWN" | "CLEAN_MASTER_NOT_RECORDED";
  apply(composed: ComposedDeliverable): Promise<void>;
  undo(composed: ComposedDeliverable): Promise<void>;
}

const ALTERATIONS: readonly Alteration[] = [
  {
    label: "a composition frozen under v1, which drew no disclosure",
    code: "DISCLOSURE_NOT_DRAWN",
    async apply(composed) {
      await prisma.generationDeliverableComposition.update({
        where: { deliverableVersionId: composed.deliverableVersionId },
        data: { profileKey: V1_PROFILE_KEY },
      });
    },
    async undo(composed) {
      await prisma.generationDeliverableComposition.update({
        where: { deliverableVersionId: composed.deliverableVersionId },
        data: { profileKey: COMPOSITION_PROFILE_KEY },
      });
    },
  },
  {
    label: "no Clean Master recorded",
    code: "CLEAN_MASTER_NOT_RECORDED",
    async apply(composed) {
      const master = await prisma.generationDeliverableCleanMaster.findUniqueOrThrow({
        where: { deliverableVersionId: composed.deliverableVersionId },
      });
      stash.set(composed.deliverableVersionId, master);
      await prisma.generationDeliverableCleanMaster.delete({ where: { id: master.id } });
    },
    async undo(composed) {
      const master = stash.get(composed.deliverableVersionId);
      if (master === undefined) throw new Error("nothing to restore");
      await prisma.generationDeliverableCleanMaster.create({ data: master });
    },
  },
  {
    label: "a Clean Master recorded under another organization's key",
    code: "CLEAN_MASTER_NOT_RECORDED",
    async apply(composed) {
      // The table's CHECK admits any organization segment: only the writer
      // derives it from the version's job, so only publication can tell.
      await prisma.generationDeliverableCleanMaster.update({
        where: { deliverableVersionId: composed.deliverableVersionId },
        data: {
          storageKey: managedCleanMasterKey({
            organizationId: ORG_B,
            deliverableVersionId: composed.deliverableVersionId,
          }),
        },
      });
    },
    async undo(composed) {
      await prisma.generationDeliverableCleanMaster.update({
        where: { deliverableVersionId: composed.deliverableVersionId },
        data: {
          storageKey: managedCleanMasterKey({
            organizationId: composed.organizationId,
            deliverableVersionId: composed.deliverableVersionId,
          }),
        },
      });
    },
  },
];

RUN("ADR-0080 — Transaction G requires the disclosure and the Clean Master", () => {
  beforeEach(async () => {
    stash.clear();
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  it("publishes what this build composes: profile v2 and a recorded master", async () => {
    const composed = await seedComposedDeliverable(prisma);
    expect((await compositionOf(prisma, composed.deliverableVersionId))?.profileKey).toBe(
      COMPOSITION_PROFILE_KEY,
    );
    const master = await prisma.generationDeliverableCleanMaster.findUnique({
      where: { deliverableVersionId: composed.deliverableVersionId },
    });
    expect(master?.storageKey).toBe(
      managedCleanMasterKey({
        organizationId: composed.organizationId,
        deliverableVersionId: composed.deliverableVersionId,
      }),
    );

    expect((await publish(await validated(composed))).kind).toBe("PUBLISHED_AND_CONSUMED");
  });

  for (const alteration of ALTERATIONS) {
    it(`refuses a first publication with ${alteration.label}, writing nothing`, async () => {
      const composed = await seedComposedDeliverable(prisma);
      const publication = await validated(composed);
      await alteration.apply(composed);
      const before = await publicationState(composed);

      await expect(publish(publication)).rejects.toThrow(
        expect.objectContaining({ code: alteration.code }),
      );
      // No pointer, no spent Unit, no event: the customer receives nothing and
      // pays nothing, and the verdict stays the publication's evidence.
      expect(await publicationState(composed)).toEqual(before);
      expect(before.job).toEqual(["DELIVERABLE_VALIDATING", expect.any(Number), null]);
      expect(before.reservation[0]).toBe("RESERVED");

      // The refusal is that row and nothing else: put it back and the same
      // verdict publishes.
      await alteration.undo(composed);
      expect((await publish(publication)).kind).toBe("PUBLISHED_AND_CONSUMED");
    });

    it(`refuses a replacement with ${alteration.label}, keeping the customer's video`, async () => {
      const first = await seedComposedDeliverable(prisma);
      expect((await publish(await validated(first))).kind).toBe("PUBLISHED_AND_CONSUMED");
      const second = await seedRecomposedDeliverable(prisma, first);
      const publication = await validated(second);
      await alteration.apply(second);
      const before = await publicationState(second);

      await expect(publish(publication)).rejects.toThrow(
        expect.objectContaining({ code: alteration.code }),
      );
      expect(await publicationState(second)).toEqual(before);
      expect(before.job[2]).toBe(first.deliverableVersionId);

      await alteration.undo(second);
      expect((await publish(publication)).kind).toBe("PUBLISHED_AS_REPLACEMENT");
    });
  }

  it("answers a version the job no longer awaits as NOT_PUBLISHABLE, whatever it carries", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(composed);
    for (const alteration of ALTERATIONS.slice(0, 2)) await alteration.apply(composed);
    const job = await jobOf(prisma, composed.jobId);
    await prisma.generationJob.update({
      where: { id: composed.jobId },
      data: { state: "FAILED_TERMINAL", stateVersion: job.stateVersion + 1 },
    });

    // Eligibility first: a superseded cycle is an ordinary thing to lose, and
    // the gate judges only what would otherwise be published.
    expect((await publish(publication)).kind).toBe("NOT_PUBLISHABLE");
  });

  it("does not judge a replay: the publication it names already happened", async () => {
    const composed = await seedComposedDeliverable(prisma);
    const publication = await validated(composed);
    expect((await publish(publication)).kind).toBe("PUBLISHED_AND_CONSUMED");
    for (const alteration of ALTERATIONS.slice(0, 2)) await alteration.apply(composed);
    const before = await publicationState(composed);

    // A replay writes nothing, so there is nothing for the gate to stop.
    expect((await publish(publication)).kind).toBe("ALREADY_PUBLISHED");
    expect(await publicationState(composed)).toEqual(before);
  });
});
