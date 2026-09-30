import {
  createDeliverableValidationRepository,
  createGenerationJobRepository,
  createGenerationReservationRepository,
} from "@app/database";
import {
  DeliverableValidationDefect,
  ISO_BMFF_CONTAINER,
  managedDeliverableOutputKey,
  safePositiveByteCount,
  sha256Digest,
  type DeliverableValidationClaim,
  type ManagedOutputMediaFacts,
} from "@app/domain";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  eventCount,
  eventsFor,
  jobOf,
} from "./deliverable-composition-execution-fixture";
import {
  COMPOSED_BYTES,
  COMPOSED_SHA,
  reservationOf,
  seedComposedDeliverable,
  seedRecomposedDeliverable,
  validationOf,
} from "./deliverable-validation-fixture";
import { ctx, dropTenants, HAS_DB, ORG_A, ORG_B, seedTenants, wipeOrchestration } from "./orchestration-fixture";

/**
 * Deliverable validation and Transaction G against live PostgreSQL.
 *
 * The unit suites prove the routing — which validator answer becomes which
 * durable verdict. What only a database can prove is the part that matters
 * commercially: that publication moves the job, the pointer and the entitlement
 * **together**, that a replay never spends a second unit, that a recomposition
 * spends none at all, and that every verdict short of `VALID` leaves the
 * customer's existing video exactly where it was.
 *
 * Nothing here reads an object store, runs `ffprobe`, or composes anything.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const repository = createDeliverableValidationRepository(prisma);

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

let leaseSeq = 0;

async function claim(
  organizationId: string,
  deliverableVersionId: string,
  now = NOW,
): ReturnType<typeof repository.claimDeliverableValidation> {
  leaseSeq += 1;
  return repository.claimDeliverableValidation({
    organizationId,
    deliverableVersionId,
    now,
    leaseToken: `vlease_itest_${leaseSeq}`,
    leaseExpiresAt: now + LEASE_MS,
  });
}

async function claimed(
  organizationId: string,
  deliverableVersionId: string,
  now = NOW,
): Promise<DeliverableValidationClaim> {
  const outcome = await claim(organizationId, deliverableVersionId, now);
  if (outcome.kind !== "CLAIMED") throw new Error(`expected CLAIMED, got ${outcome.kind}`);
  return outcome.claim;
}

/** Validate and publish one composed deliverable, the ordinary happy path. */
async function validateAndPublish(organizationId: string, deliverableVersionId: string) {
  const held = await claimed(organizationId, deliverableVersionId);
  const finalized = await repository.finalizeValid({
    claim: held,
    facts: FACTS,
    validatedAt: NOW + 1_000,
    context: ctx(),
  });
  if (finalized.kind === "LEASE_LOST") throw new Error("expected a written verdict");
  return repository.publishDeliverable({
    publication: finalized.publication,
    publishedAt: NOW + 2_000,
    context: ctx(),
  });
}

RUN("Phase 5C — deliverable validation and Transaction G", () => {
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
  // Discovery
  // -------------------------------------------------------------------------

  describe("candidate discovery", () => {
    it("offers a composed deliverable nobody has judged", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const candidates = await repository.findValidationCandidates({ now: NOW, limit: 25 });
      expect(candidates.map((c) => c.deliverableVersionId)).toEqual([
        composed.deliverableVersionId,
      ]);
      expect(candidates[0]).toEqual({
        deliverableVersionId: composed.deliverableVersionId,
        generationJobId: composed.jobId,
        organizationId: composed.organizationId,
      });
    });

    it("keeps offering a VALID verdict whose publication never happened", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);
      await repository.finalizeValid({
        claim: held,
        facts: FACTS,
        validatedAt: NOW + 1_000,
        context: ctx(),
      });
      // The verdict is durable and the job is still awaiting publication: this is
      // exactly the state a crash between the two commits leaves, and nothing
      // else in the system would ever find it.
      const candidates = await repository.findValidationCandidates({ now: NOW, limit: 25 });
      expect(candidates.map((c) => c.deliverableVersionId)).toEqual([
        composed.deliverableVersionId,
      ]);
    });

    it("stops offering it once it is published", async () => {
      const composed = await seedComposedDeliverable(prisma);
      await validateAndPublish(composed.organizationId, composed.deliverableVersionId);
      expect(await repository.findValidationCandidates({ now: NOW, limit: 25 })).toEqual([]);
    });

    it("never offers a terminal non-VALID verdict again", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);
      await repository.finalizeInvalidMedia({
        claim: held,
        reason: "PROBE_REJECTED",
        validatedAt: NOW + 1_000,
      });
      // A settled answer. Re-offering it would re-claim and re-refuse it forever,
      // and the bounded batch would fill with work that can never progress.
      expect(await repository.findValidationCandidates({ now: NOW, limit: 25 })).toEqual([]);
    });

    it("does not offer a deferred row before its instant, and does after", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);
      await repository.deferValidation({ claim: held, nextAttemptAt: NOW + 300_000 });
      expect(await repository.findValidationCandidates({ now: NOW, limit: 25 })).toEqual([]);
      const later = await repository.findValidationCandidates({ now: NOW + 300_000, limit: 25 });
      expect(later.map((c) => c.deliverableVersionId)).toEqual([composed.deliverableVersionId]);
    });

    it("does not offer a live lease, and does once it has expired", async () => {
      const composed = await seedComposedDeliverable(prisma);
      await claimed(composed.organizationId, composed.deliverableVersionId);
      expect(await repository.findValidationCandidates({ now: NOW, limit: 25 })).toEqual([]);
      const later = await repository.findValidationCandidates({ now: NOW + LEASE_MS, limit: 25 });
      expect(later.map((c) => c.deliverableVersionId)).toEqual([composed.deliverableVersionId]);
    });

    it("never offers a superseded version once a recomposition is under way", async () => {
      const first = await seedComposedDeliverable(prisma);
      await validateAndPublish(first.organizationId, first.deliverableVersionId);
      const second = await seedRecomposedDeliverable(prisma, first);

      // The job is DELIVERABLE_VALIDATING again and the *old* version still has
      // an OUTPUT_VERIFIED composition and a VALID verdict. Without the
      // highest-ordinal filter it would be listed, offered to Transaction G, and
      // refused forever — while the pointer regression it invites is the whole
      // danger.
      const candidates = await repository.findValidationCandidates({ now: NOW, limit: 25 });
      expect(candidates.map((c) => c.deliverableVersionId)).toEqual([
        second.deliverableVersionId,
      ]);
    });

    it("refuses a batch limit outside its bound rather than clamping it", async () => {
      await expect(
        repository.findValidationCandidates({ now: NOW, limit: 5_000 }),
      ).rejects.toThrow(/between 1 and 25/);
    });
  });

  // -------------------------------------------------------------------------
  // Claim
  // -------------------------------------------------------------------------

  describe("claim", () => {
    it("freezes the composition's own receipt and canonical key", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);

      expect(held.expectedReceipt).toEqual({
        sha256: composed.sha256,
        sizeBytes: composed.sizeBytes,
      });
      expect(held.outputStorageKey).toBe(
        managedDeliverableOutputKey({
          organizationId: composed.organizationId,
          deliverableVersionId: composed.deliverableVersionId,
        }),
      );
      const row = await validationOf(prisma, composed.deliverableVersionId);
      expect(row?.status).toBe("RUNNING");
      expect(row?.receiptSha256).toBe(composed.sha256);
      expect(row?.receiptSizeBytes).toBe(BigInt(composed.sizeBytes));
      expect(row?.attemptCount).toBe(1);
      expect(row?.version).toBe(1);
    });

    it("writes no transition event, on any aggregate", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const before = await eventCount(prisma);
      await claimed(composed.organizationId, composed.deliverableVersionId);
      // A worker picked up work. Nothing about the job, the deliverable or the
      // entitlement changed, so there is nothing to record.
      expect(await eventCount(prisma)).toBe(before);
    });

    it("refuses a second claim while the lease is live, and admits one after", async () => {
      const composed = await seedComposedDeliverable(prisma);
      await claimed(composed.organizationId, composed.deliverableVersionId);
      expect(
        (await claim(composed.organizationId, composed.deliverableVersionId)).kind,
      ).toBe("NOT_CLAIMABLE");

      const reclaimed = await claim(
        composed.organizationId,
        composed.deliverableVersionId,
        NOW + LEASE_MS,
      );
      expect(reclaimed.kind).toBe("CLAIMED");
      const row = await validationOf(prisma, composed.deliverableVersionId);
      expect(row?.attemptCount).toBe(2);
      expect(row?.version).toBe(2);
    });

    it("answers ALREADY_VALID when only the publication is outstanding", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);
      await repository.finalizeValid({
        claim: held,
        facts: FACTS,
        validatedAt: NOW + 1_000,
        context: ctx(),
      });

      const again = await claim(composed.organizationId, composed.deliverableVersionId);
      if (again.kind !== "ALREADY_VALID") throw new Error(`got ${again.kind}`);
      expect(again.publication.deliverableVersionId).toBe(composed.deliverableVersionId);
      expect(again.publication.receipt).toEqual({
        sha256: composed.sha256,
        sizeBytes: composed.sizeBytes,
      });
      // No lease was taken and nothing was re-validated.
      const row = await validationOf(prisma, composed.deliverableVersionId);
      expect(row?.status).toBe("VALID");
      expect(row?.attemptCount).toBe(1);
      expect(row?.leaseToken).toBeNull();
    });

    it("never reopens a terminal non-VALID verdict", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);
      await repository.finalizeIntegrityMismatch({ claim: held, validatedAt: NOW + 1_000 });
      expect(
        (await claim(composed.organizationId, composed.deliverableVersionId, NOW + LEASE_MS))
          .kind,
      ).toBe("ALREADY_TERMINAL");
    });

    it("refuses a job that is not awaiting deliverable validation", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const job = await jobOf(prisma, composed.jobId);
      await prisma.generationJob.update({
        where: { id: composed.jobId },
        data: { state: "COMPOSING", stateVersion: job.stateVersion + 1 },
      });
      expect(
        (await claim(composed.organizationId, composed.deliverableVersionId)).kind,
      ).toBe("NOT_ELIGIBLE");
      expect(await validationOf(prisma, composed.deliverableVersionId)).toBeNull();
    });

    it("treats another tenant's deliverable exactly as a missing one", async () => {
      const composed = await seedComposedDeliverable(prisma);
      expect((await claim(ORG_B, composed.deliverableVersionId)).kind).toBe("NOT_FOUND");
      expect((await claim(ORG_A, "gdv_does_not_exist")).kind).toBe("NOT_FOUND");
      expect(await validationOf(prisma, composed.deliverableVersionId)).toBeNull();
      expect(
        await repository.findValidationByVersionId(ORG_B, composed.deliverableVersionId),
      ).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Verdicts
  // -------------------------------------------------------------------------

  describe("verdicts", () => {
    it("records VALID with its facts, one deliverable event, and nothing else", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const jobBefore = await jobOf(prisma, composed.jobId);
      const reservationBefore = await reservationOf(prisma, composed.reservationId);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);

      const finalized = await repository.finalizeValid({
        claim: held,
        facts: FACTS,
        validatedAt: NOW + 1_000,
        context: ctx(),
      });
      expect(finalized.kind).toBe("FINALIZED");

      const record = await repository.findValidationByVersionId(
        composed.organizationId,
        composed.deliverableVersionId,
      );
      expect(record).toEqual({
        status: "VALID",
        receipt: { sha256: composed.sha256, sizeBytes: composed.sizeBytes },
        attemptCount: 1,
        version: 2,
        facts: FACTS,
        validatedAt: NOW + 1_000,
      });

      // A verdict is not a publication.
      const jobAfter = await jobOf(prisma, composed.jobId);
      expect(jobAfter.state).toBe("DELIVERABLE_VALIDATING");
      expect(jobAfter.currentDeliverableVersionId).toBeNull();
      expect(jobAfter.stateVersion).toBe(jobBefore.stateVersion);
      const reservationAfter = await reservationOf(prisma, composed.reservationId);
      expect(reservationAfter.state).toBe(reservationBefore.state);
      expect(reservationAfter.consumedAt).toBeNull();

      const events = await eventsFor(prisma, composed.deliverableVersionId);
      expect(events.map((e) => [e.fromState, e.toState, e.eventType]).at(-1)).toEqual([
        "OUTPUT_VERIFIED",
        "VALIDATED",
        "deliverable.validated",
      ]);
      expect(await eventsFor(prisma, composed.reservationId)).toEqual([]);
    });

    it("records a terminal non-VALID verdict with no event anywhere", async () => {
      for (const verdict of ["INVALID_MEDIA", "INTEGRITY_MISMATCH"] as const) {
        await wipeOrchestration(prisma);
        await seedTenants(prisma);
        const composed = await seedComposedDeliverable(prisma);
        const jobBefore = await jobOf(prisma, composed.jobId);
        const before = await eventCount(prisma);
        const held = await claimed(composed.organizationId, composed.deliverableVersionId);

        const written =
          verdict === "INVALID_MEDIA"
            ? await repository.finalizeInvalidMedia({
                claim: held,
                reason: "VIDEO_STREAM_MISSING",
                validatedAt: NOW + 1_000,
              })
            : await repository.finalizeIntegrityMismatch({ claim: held, validatedAt: NOW + 1_000 });
        expect(written.kind).toBe("FINALIZED");

        // The job is untouched, the customer's pointer has not moved, the hold is
        // neither consumed nor released, and the event stream says nothing. A
        // recomposition that cannot be validated must not destroy the video the
        // customer already has.
        const jobAfter = await jobOf(prisma, composed.jobId);
        expect([jobAfter.state, jobAfter.stateVersion]).toEqual([
          "DELIVERABLE_VALIDATING",
          jobBefore.stateVersion,
        ]);
        expect(jobAfter.currentDeliverableVersionId).toBeNull();
        const reservation = await reservationOf(prisma, composed.reservationId);
        expect([reservation.state, reservation.consumedAt, reservation.releasedAt]).toEqual([
          "RESERVED",
          null,
          null,
        ]);
        expect(await eventCount(prisma)).toBe(before);

        const row = await validationOf(prisma, composed.deliverableVersionId);
        expect(row?.status).toBe(verdict);
        expect(row?.invalidReason).toBe(
          verdict === "INVALID_MEDIA" ? "VIDEO_STREAM_MISSING" : null,
        );
      }
    });

    it("returns a deferred row to PENDING with a future instant and no verdict", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const before = await eventCount(prisma);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);

      expect((await repository.deferValidation({ claim: held, nextAttemptAt: NOW + 300_000 })).kind)
        .toBe("DEFERRED");
      const row = await validationOf(prisma, composed.deliverableVersionId);
      expect(row?.status).toBe("PENDING");
      expect(row?.leaseToken).toBeNull();
      expect(row?.nextAttemptAt?.getTime()).toBe(NOW + 300_000);
      expect(row?.validatedAt).toBeNull();
      expect(await eventCount(prisma)).toBe(before);
    });

    it("loses a stale finalize rather than overwriting the reclaimer's work", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const stale = await claimed(composed.organizationId, composed.deliverableVersionId);
      await claimed(composed.organizationId, composed.deliverableVersionId, NOW + LEASE_MS);

      const written = await repository.finalizeValid({
        claim: stale,
        facts: FACTS,
        validatedAt: NOW + 2_000,
        context: ctx(),
      });
      expect(written.kind).toBe("LEASE_LOST");
      expect((await validationOf(prisma, composed.deliverableVersionId))?.status).toBe("RUNNING");
    });

    it("replays one VALID verdict without writing a second event", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);
      await repository.finalizeValid({
        claim: held,
        facts: FACTS,
        validatedAt: NOW + 1_000,
        context: ctx(),
      });
      const before = await eventCount(prisma);

      const again = await repository.finalizeValid({
        claim: held,
        facts: FACTS,
        validatedAt: NOW + 5_000,
        context: ctx(),
      });
      expect(again.kind).toBe("ALREADY_FINALIZED");
      expect(await eventCount(prisma)).toBe(before);
      // Not rewritten: the instant the verdict was reached is not whenever the
      // last duplicate happened to arrive.
      expect((await validationOf(prisma, composed.deliverableVersionId))?.validatedAt?.getTime())
        .toBe(NOW + 1_000);
    });

    it("refuses a second, different verdict about the same bytes", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);
      await repository.finalizeInvalidMedia({
        claim: held,
        reason: "PROBE_REJECTED",
        validatedAt: NOW + 1_000,
      });

      // A different reason, and a different *kind* of verdict, are both
      // contradictions between two measurements of immutable bytes.
      await expect(
        repository.finalizeInvalidMedia({
          claim: held,
          reason: "DURATION_INVALID",
          validatedAt: NOW + 2_000,
        }),
      ).rejects.toBeInstanceOf(DeliverableValidationDefect);
      await expect(
        repository.finalizeIntegrityMismatch({ claim: held, validatedAt: NOW + 2_000 }),
      ).rejects.toBeInstanceOf(DeliverableValidationDefect);
    });

    it("refuses to judge a deliverable whose composition receipt moved underneath it", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);
      // Two different objects were believed canonical. "Repairing" the frozen
      // binding is exactly how that evidence is destroyed.
      await prisma.generationDeliverableComposition.update({
        where: { deliverableVersionId: composed.deliverableVersionId },
        data: { outputSha256: "f".repeat(64) },
      });

      await expect(
        repository.finalizeValid({
          claim: held,
          facts: FACTS,
          validatedAt: NOW + 1_000,
          context: ctx(),
        }),
      ).rejects.toBeInstanceOf(DeliverableValidationDefect);
      expect((await validationOf(prisma, composed.deliverableVersionId))?.status).toBe("RUNNING");
    });

    it("refuses to reclaim a row whose frozen binding no longer matches", async () => {
      const composed = await seedComposedDeliverable(prisma);
      await claimed(composed.organizationId, composed.deliverableVersionId);
      await prisma.generationDeliverableComposition.update({
        where: { deliverableVersionId: composed.deliverableVersionId },
        data: { outputSha256: "b".repeat(64) },
      });

      // The reclaim path re-asserts the binding for the same reason the finalize
      // path does: refreshing it to match the newer receipt would quietly turn a
      // record created about one object into a verdict about another.
      await expect(
        claim(composed.organizationId, composed.deliverableVersionId, NOW + LEASE_MS),
      ).rejects.toBeInstanceOf(DeliverableValidationDefect);
      const row = await validationOf(prisma, composed.deliverableVersionId);
      expect(row?.receiptSha256).toBe(composed.sha256);
      expect(row?.attemptCount).toBe(1);
    });

    it("refuses to condemn a deliverable whose composition receipt moved underneath it", async () => {
      // The sharper half of the same rule. A `VALID` verdict is re-proved by
      // Transaction G before anything reaches a customer; an unusable verdict is
      // terminal and never reopened — a later claim reads `ALREADY_TERMINAL` and
      // stops — so recording one against bytes that are no longer the
      // composition's would condemn a deliverable nobody measured, permanently.
      for (const verdict of ["INVALID_MEDIA", "INTEGRITY_MISMATCH"] as const) {
        await wipeOrchestration(prisma);
        await seedTenants(prisma);
        const composed = await seedComposedDeliverable(prisma);
        const jobBefore = await jobOf(prisma, composed.jobId);
        const reservationBefore = await reservationOf(prisma, composed.reservationId);
        const eventsBefore = await eventCount(prisma);

        const held = await claimed(composed.organizationId, composed.deliverableVersionId);
        // Receipt A was claimed; the composition now names B.
        await prisma.generationDeliverableComposition.update({
          where: { deliverableVersionId: composed.deliverableVersionId },
          data: { outputSha256: "a".repeat(64) },
        });

        await expect(
          verdict === "INVALID_MEDIA"
            ? repository.finalizeInvalidMedia({
                claim: held,
                reason: "PROBE_REJECTED",
                validatedAt: NOW + 1_000,
              })
            : repository.finalizeIntegrityMismatch({ claim: held, validatedAt: NOW + 1_000 }),
        ).rejects.toBeInstanceOf(DeliverableValidationDefect);

        // Fails closed: no terminal verdict was persisted, so the row is still
        // claimable and the deliverable can be judged again against whatever the
        // composition actually says.
        const row = await validationOf(prisma, composed.deliverableVersionId);
        expect(row?.status).toBe("RUNNING");
        expect(row?.invalidReason).toBeNull();
        expect(row?.validatedAt).toBeNull();
        expect(row?.receiptSha256).toBe(composed.sha256);

        // And nothing else moved: not the job, not the customer's pointer, not
        // the entitlement, not the event stream.
        const jobAfter = await jobOf(prisma, composed.jobId);
        expect([jobAfter.state, jobAfter.stateVersion, jobAfter.currentDeliverableVersionId]).toEqual(
          [jobBefore.state, jobBefore.stateVersion, null],
        );
        const reservationAfter = await reservationOf(prisma, composed.reservationId);
        expect([
          reservationAfter.state,
          reservationAfter.stateVersion,
          reservationAfter.consumedAt,
          reservationAfter.releasedAt,
        ]).toEqual([
          reservationBefore.state,
          reservationBefore.stateVersion,
          null,
          null,
        ]);
        expect(await eventCount(prisma)).toBe(eventsBefore);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Transaction G
  // -------------------------------------------------------------------------

  describe("Transaction G — publication", () => {
    it("moves the job, the pointer and the unit in one commit", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const published = await validateAndPublish(
        composed.organizationId,
        composed.deliverableVersionId,
      );
      expect(published.kind).toBe("PUBLISHED_AND_CONSUMED");

      const job = await jobOf(prisma, composed.jobId);
      expect(job.state).toBe("DELIVERABLE_READY");
      expect(job.currentDeliverableVersionId).toBe(composed.deliverableVersionId);

      const reservation = await reservationOf(prisma, composed.reservationId);
      expect(reservation.state).toBe("CONSUMED");
      expect(reservation.consumedAt?.getTime()).toBe(NOW + 2_000);
      expect(reservation.releasedAt).toBeNull();

      expect(
        (await eventsFor(prisma, composed.deliverableVersionId))
          .map((e) => [e.fromState, e.toState])
          .at(-1),
      ).toEqual(["VALIDATED", "PUBLISHED"]);
      expect(
        (await eventsFor(prisma, composed.jobId)).map((e) => [e.fromState, e.toState]).at(-1),
      ).toEqual(["DELIVERABLE_VALIDATING", "DELIVERABLE_READY"]);
      expect(
        (await eventsFor(prisma, composed.reservationId)).map((e) => [e.fromState, e.toState]),
      ).toEqual([["RESERVED", "CONSUMED"]]);
    });

    it("spends exactly one unit however many times it is replayed", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);
      const finalized = await repository.finalizeValid({
        claim: held,
        facts: FACTS,
        validatedAt: NOW + 1_000,
        context: ctx(),
      });
      if (finalized.kind === "LEASE_LOST") throw new Error("expected a written verdict");

      const first = await repository.publishDeliverable({
        publication: finalized.publication,
        publishedAt: NOW + 2_000,
        context: ctx(),
      });
      const after = await eventCount(prisma);

      for (const publishedAt of [NOW + 3_000, NOW + 4_000]) {
        const again = await repository.publishDeliverable({
          publication: finalized.publication,
          publishedAt,
          context: ctx(),
        });
        expect(again.kind).toBe("ALREADY_PUBLISHED");
      }
      expect(first.kind).toBe("PUBLISHED_AND_CONSUMED");
      expect(await eventCount(prisma)).toBe(after);

      const reservation = await reservationOf(prisma, composed.reservationId);
      expect(reservation.state).toBe("CONSUMED");
      // The instant the unit was actually spent, not whenever the last duplicate
      // arrived.
      expect(reservation.consumedAt?.getTime()).toBe(NOW + 2_000);
      expect(reservation.stateVersion).toBe(1);
    });

    it("replaces a published deliverable without spending a second unit", async () => {
      const first = await seedComposedDeliverable(prisma);
      await validateAndPublish(first.organizationId, first.deliverableVersionId);
      const consumedAt = (await reservationOf(prisma, first.reservationId)).consumedAt;

      const second = await seedRecomposedDeliverable(prisma, first);
      const published = await validateAndPublish(
        second.organizationId,
        second.deliverableVersionId,
      );
      expect(published.kind).toBe("PUBLISHED_AS_REPLACEMENT");

      const job = await jobOf(prisma, first.jobId);
      expect(job.state).toBe("DELIVERABLE_READY");
      expect(job.currentDeliverableVersionId).toBe(second.deliverableVersionId);

      // The customer paid once for this job. `CONSUMED` has no outgoing edge, so
      // a second consume is impossible by construction as well as by the branch —
      // and the instant of the original spend is untouched.
      const reservation = await reservationOf(prisma, first.reservationId);
      expect(reservation.state).toBe("CONSUMED");
      expect(reservation.consumedAt).toEqual(consumedAt);
      expect(
        (await eventsFor(prisma, first.reservationId)).filter((e) => e.toState === "CONSUMED"),
      ).toHaveLength(1);
    });

    it("keeps the previous deliverable published while a replacement is unvalidated", async () => {
      const first = await seedComposedDeliverable(prisma);
      await validateAndPublish(first.organizationId, first.deliverableVersionId);
      const second = await seedRecomposedDeliverable(prisma, first);

      const held = await claimed(second.organizationId, second.deliverableVersionId);
      await repository.finalizeInvalidMedia({
        claim: held,
        reason: "CONTAINER_UNSUPPORTED",
        validatedAt: NOW + 1_000,
      });

      // The replacement could not be validated. The customer keeps the video they
      // already have, and nothing about their entitlement moves.
      const job = await jobOf(prisma, first.jobId);
      expect(job.currentDeliverableVersionId).toBe(first.deliverableVersionId);
      expect(job.state).toBe("DELIVERABLE_VALIDATING");
      expect((await reservationOf(prisma, first.reservationId)).state).toBe("CONSUMED");
    });

    it("never moves the customer's pointer backwards", async () => {
      const first = await seedComposedDeliverable(prisma);
      const firstPublication = await (async () => {
        const held = await claimed(first.organizationId, first.deliverableVersionId);
        const finalized = await repository.finalizeValid({
          claim: held,
          facts: FACTS,
          validatedAt: NOW + 1_000,
          context: ctx(),
        });
        if (finalized.kind === "LEASE_LOST") throw new Error("expected a written verdict");
        await repository.publishDeliverable({
          publication: finalized.publication,
          publishedAt: NOW + 2_000,
          context: ctx(),
        });
        return finalized.publication;
      })();

      const second = await seedRecomposedDeliverable(prisma, first);
      await validateAndPublish(second.organizationId, second.deliverableVersionId);
      // A third cycle begins, so the job is awaiting validation again while the
      // customer holds version two.
      await seedRecomposedDeliverable(prisma, second);

      // The *first* version's publication is re-presented. Its verdict is still
      // VALID and the job is still DELIVERABLE_VALIDATING, so only the ordinal
      // guard stands between the customer and an older rendition replacing the
      // one they have.
      expect(
        (await repository.publishDeliverable({
          publication: firstPublication,
          publishedAt: NOW + 9_000,
          context: ctx(),
        })).kind,
      ).toBe("NOT_PUBLISHABLE");
      expect((await jobOf(prisma, first.jobId)).currentDeliverableVersionId).toBe(
        second.deliverableVersionId,
      );
    });

    it("refuses a publication naming a verdict that is no longer the row", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);
      const finalized = await repository.finalizeValid({
        claim: held,
        facts: FACTS,
        validatedAt: NOW + 1_000,
        context: ctx(),
      });
      if (finalized.kind === "LEASE_LOST") throw new Error("expected a written verdict");

      const stale = {
        ...finalized.publication,
        validationVersion: finalized.publication.validationVersion + 1,
      };
      expect(
        (await repository.publishDeliverable({
          publication: stale,
          publishedAt: NOW + 2_000,
          context: ctx(),
        })).kind,
      ).toBe("NOT_PUBLISHABLE");
      expect((await jobOf(prisma, composed.jobId)).state).toBe("DELIVERABLE_VALIDATING");
    });

    it("refuses to publish against a job that moved on", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);
      const finalized = await repository.finalizeValid({
        claim: held,
        facts: FACTS,
        validatedAt: NOW + 1_000,
        context: ctx(),
      });
      if (finalized.kind === "LEASE_LOST") throw new Error("expected a written verdict");

      const job = await jobOf(prisma, composed.jobId);
      await prisma.generationJob.update({
        where: { id: composed.jobId },
        data: { state: "FAILED_TERMINAL", stateVersion: job.stateVersion + 1 },
      });
      expect(
        (await repository.publishDeliverable({
          publication: finalized.publication,
          publishedAt: NOW + 2_000,
          context: ctx(),
        })).kind,
      ).toBe("NOT_PUBLISHABLE");
      expect((await reservationOf(prisma, composed.reservationId)).state).toBe("RESERVED");
    });

    it("refuses a publication that names another job", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const other = await seedComposedDeliverable(prisma);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);
      const finalized = await repository.finalizeValid({
        claim: held,
        facts: FACTS,
        validatedAt: NOW + 1_000,
        context: ctx(),
      });
      if (finalized.kind === "LEASE_LOST") throw new Error("expected a written verdict");

      await expect(
        repository.publishDeliverable({
          publication: { ...finalized.publication, generationJobId: other.jobId },
          publishedAt: NOW + 2_000,
          context: ctx(),
        }),
      ).rejects.toBeInstanceOf(DeliverableValidationDefect);
      expect((await jobOf(prisma, other.jobId)).currentDeliverableVersionId).toBeNull();
    });

    it("treats another tenant's publication exactly as a missing one", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);
      const finalized = await repository.finalizeValid({
        claim: held,
        facts: FACTS,
        validatedAt: NOW + 1_000,
        context: ctx(),
      });
      if (finalized.kind === "LEASE_LOST") throw new Error("expected a written verdict");

      expect(
        (await repository.publishDeliverable({
          publication: { ...finalized.publication, organizationId: ORG_B },
          publishedAt: NOW + 2_000,
          context: ctx(),
        })).kind,
      ).toBe("NOT_PUBLISHABLE");
      const job = await jobOf(prisma, composed.jobId);
      expect(job.currentDeliverableVersionId).toBeNull();
      expect((await reservationOf(prisma, composed.reservationId)).state).toBe("RESERVED");
    });

    it("refuses to spend a unit the hold no longer offers", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);
      const finalized = await repository.finalizeValid({
        claim: held,
        facts: FACTS,
        validatedAt: NOW + 1_000,
        context: ctx(),
      });
      if (finalized.kind === "LEASE_LOST") throw new Error("expected a written verdict");

      const reservation = await reservationOf(prisma, composed.reservationId);
      await prisma.generationReservation.update({
        where: { id: composed.reservationId },
        data: {
          state: "RELEASED",
          releasedAt: new Date(NOW),
          stateVersion: reservation.stateVersion + 1,
        },
      });

      // A refunded entitlement behind a validated deliverable is a state the
      // application believes it cannot produce. It fails closed rather than
      // publishing a video nobody is paying for.
      await expect(
        repository.publishDeliverable({
          publication: finalized.publication,
          publishedAt: NOW + 2_000,
          context: ctx(),
        }),
      ).rejects.toBeInstanceOf(DeliverableValidationDefect);
      expect((await jobOf(prisma, composed.jobId)).currentDeliverableVersionId).toBeNull();
    });

    it("spends the unit from a reconciliation hold as readily as from a reservation", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const reservation = await reservationOf(prisma, composed.reservationId);
      await prisma.generationReservation.update({
        where: { id: composed.reservationId },
        data: { state: "RECONCILIATION_HOLD", stateVersion: reservation.stateVersion + 1 },
      });

      // A validated deliverable the customer is about to receive is exactly the
      // evidence a hold was waiting for, and both edges into CONSUMED are
      // reserved for this transaction.
      const published = await validateAndPublish(
        composed.organizationId,
        composed.deliverableVersionId,
      );
      expect(published.kind).toBe("PUBLISHED_AND_CONSUMED");
      expect(
        (await eventsFor(prisma, composed.reservationId))
          .map((e) => [e.fromState, e.toState])
          .at(-1),
      ).toEqual(["RECONCILIATION_HOLD", "CONSUMED"]);
    });
  });

  // -------------------------------------------------------------------------
  // The generic API stays refused
  // -------------------------------------------------------------------------

  describe("the generic transition API cannot assemble this", () => {
    it("refuses the job and reservation edges Transaction G owns", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const job = await jobOf(prisma, composed.jobId);
      const reservation = await reservationOf(prisma, composed.reservationId);

      expect(
        await createGenerationJobRepository(prisma).transition({
          organizationId: composed.organizationId,
          id: composed.jobId,
          expectedState: "DELIVERABLE_VALIDATING",
          expectedVersion: job.stateVersion,
          nextState: "DELIVERABLE_READY",
          context: ctx(),
        }),
      ).toEqual({ kind: "TRANSITION_RESERVED" });

      for (const expectedState of ["RESERVED", "RECONCILIATION_HOLD"] as const) {
        expect(
          await createGenerationReservationRepository(prisma).transition({
            organizationId: composed.organizationId,
            id: composed.reservationId,
            expectedState,
            expectedVersion: reservation.stateVersion,
            nextState: "CONSUMED",
            context: ctx(),
          }),
        ).toEqual({ kind: "TRANSITION_RESERVED" });
      }

      const after = await jobOf(prisma, composed.jobId);
      expect([after.state, after.currentDeliverableVersionId]).toEqual([
        "DELIVERABLE_VALIDATING",
        null,
      ]);
      expect((await reservationOf(prisma, composed.reservationId)).state).toBe("RESERVED");
    });
  });

  // -------------------------------------------------------------------------
  // Durable shape
  // -------------------------------------------------------------------------

  describe("the database refuses impossible rows", () => {
    it("will not hold a lease on a terminal verdict", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);
      await repository.finalizeValid({
        claim: held,
        facts: FACTS,
        validatedAt: NOW + 1_000,
        context: ctx(),
      });
      await expect(
        prisma.generationDeliverableValidation.update({
          where: { deliverableVersionId: composed.deliverableVersionId },
          data: { leaseToken: "vlease_smuggled", leaseExpiresAt: new Date(NOW) },
        }),
      ).rejects.toThrow(/deliverable_validation_status_shape_check/);
    });

    it("will not record a VALID verdict with an incomplete fact set", async () => {
      const composed = await seedComposedDeliverable(prisma);
      const held = await claimed(composed.organizationId, composed.deliverableVersionId);
      await repository.finalizeValid({
        claim: held,
        facts: FACTS,
        validatedAt: NOW + 1_000,
        context: ctx(),
      });
      await expect(
        prisma.generationDeliverableValidation.update({
          where: { deliverableVersionId: composed.deliverableVersionId },
          data: { audioStreamCount: null },
        }),
      ).rejects.toThrow(/deliverable_validation_status_shape_check/);
    });

    it("will not accept a receipt outside the domain's own range", async () => {
      const composed = await seedComposedDeliverable(prisma);
      await claimed(composed.organizationId, composed.deliverableVersionId);
      for (const data of [
        { receiptSha256: "F".repeat(64) },
        { receiptSha256: "abc" },
        { receiptSizeBytes: BigInt(0) },
      ]) {
        await expect(
          prisma.generationDeliverableValidation.update({
            where: { deliverableVersionId: composed.deliverableVersionId },
            data,
          }),
        ).rejects.toThrow(/deliverable_validation_receipt_check/);
      }
    });

    it("keeps one validation per deliverable version", async () => {
      const composed = await seedComposedDeliverable(prisma);
      await claimed(composed.organizationId, composed.deliverableVersionId);
      await expect(
        prisma.generationDeliverableValidation.create({
          data: {
            id: "gdval_duplicate",
            deliverableVersionId: composed.deliverableVersionId,
            status: "PENDING",
            receiptSha256: COMPOSED_SHA,
            receiptSizeBytes: BigInt(COMPOSED_BYTES),
            nextAttemptAt: new Date(NOW),
          },
        }),
      ).rejects.toThrow();
    });

    it("will not let a validated deliverable version be deleted out from under it", async () => {
      const composed = await seedComposedDeliverable(prisma);
      await claimed(composed.organizationId, composed.deliverableVersionId);
      // RESTRICT, never Cascade: this row authorized publishing a customer's
      // video and spending their unit.
      await expect(
        prisma.generationDeliverableVersion.delete({
          where: { id: composed.deliverableVersionId },
        }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Read model
  // -------------------------------------------------------------------------

  describe("the durable read model", () => {
    it("reports each status in the domain's own vocabulary", async () => {
      const composed = await seedComposedDeliverable(prisma);
      expect(
        await repository.findValidationByVersionId(
          composed.organizationId,
          composed.deliverableVersionId,
        ),
      ).toBeNull();

      const held = await claimed(composed.organizationId, composed.deliverableVersionId);
      expect(
        await repository.findValidationByVersionId(
          composed.organizationId,
          composed.deliverableVersionId,
        ),
      ).toEqual({
        status: "RUNNING",
        receipt: { sha256: composed.sha256, sizeBytes: composed.sizeBytes },
        attemptCount: 1,
        version: 1,
        leaseExpiresAt: NOW + LEASE_MS,
      });

      await repository.deferValidation({ claim: held, nextAttemptAt: NOW + 300_000 });
      expect(
        await repository.findValidationByVersionId(
          composed.organizationId,
          composed.deliverableVersionId,
        ),
      ).toEqual({
        status: "PENDING",
        receipt: { sha256: composed.sha256, sizeBytes: composed.sizeBytes },
        attemptCount: 1,
        version: 2,
        nextAttemptAt: NOW + 300_000,
      });

      const again = await claimed(
        composed.organizationId,
        composed.deliverableVersionId,
        NOW + 300_000,
      );
      await repository.finalizeInvalidMedia({
        claim: again,
        reason: "DURATION_INVALID",
        validatedAt: NOW + 400_000,
      });
      expect(
        await repository.findValidationByVersionId(
          composed.organizationId,
          composed.deliverableVersionId,
        ),
      ).toEqual({
        status: "INVALID_MEDIA",
        receipt: {
          sha256: sha256Digest(composed.sha256),
          sizeBytes: safePositiveByteCount(composed.sizeBytes),
        },
        attemptCount: 2,
        version: 4,
        reason: "DURATION_INVALID",
        validatedAt: NOW + 400_000,
      });
    });
  });
});
