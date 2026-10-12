/**
 * Deliverable validation, and Transaction G — the publication boundary.
 *
 * Short database transactions, and nothing else. No object-store read, no
 * subprocess, no HTTP is reachable from inside any of them: a transaction held
 * open across a multi-hundred-megabyte download pins a pooled connection for the
 * whole download, and Transaction G would pin the *entitlement* row with it.
 *
 * ```text
 * claim     work created or reclaimed RUNNING, job untouched
 * --- external: read the canonical object, hash it, inspect it ---
 * finalize  work -> VALID | INVALID_MEDIA | INTEGRITY_MISMATCH, job untouched
 * defer     work -> PENDING with a future instant, job untouched
 * G         DELIVERABLE_VALIDATING -> DELIVERABLE_READY, the deliverable pointer,
 *           and the entitlement consume where one is owed -- one commit
 * ```
 *
 * ## Lock order
 *
 * ```text
 * validation lifecycle : GenerationJob -> version -> composition -> validation
 * Transaction G        : GenerationReservation -> GenerationJob -> version
 *                        -> composition -> validation
 * ```
 *
 * **Reservation before Job**, the system-wide order Transaction H and Transaction
 * I both take, measured against the real settlement path. Taking the Job first
 * here would close a deadlock cycle with settlement, which holds the reservation
 * and then waits for the Job.
 *
 * The lifecycle transactions do not lock the reservation *at all*, and that is
 * not an inconsistency with the rule: the rule constrains transactions that lock
 * **both** rows. Validation moves no entitlement, so locking the hold purely for
 * symmetry would serialize it against every cost workflow for a row this code
 * never reads. Because they never take it, they cannot form the inverse pair with
 * Transaction G either.
 */

import {
  DELIVERABLE_OUTPUT_VERIFIED_STATE,
  DELIVERABLE_PUBLICATION_REASON_CODE,
  DELIVERABLE_PUBLISHED_EVENT_TYPE,
  DELIVERABLE_PUBLISHED_STATE,
  DELIVERABLE_VALIDATED_EVENT_TYPE,
  DELIVERABLE_VALIDATED_STATE,
  DELIVERABLE_VALIDATION_REASON_CODE,
  DeliverableValidationDefect,
  ISO_BMFF_CONTAINER,
  JOB_DELIVERABLE_READY_EVENT_TYPE,
  RESERVATION_CONSUMED_EVENT_TYPE,
  deliverableValidationReceipt,
  frozenFundingCoversReservation,
  isDeliverableInvalidReason,
  managedDeliverableOutputKey,
  safePositiveByteCount,
  sha256Digest,
  validateDeliverableValidationBatchLimit,
  type ClaimDeliverableValidationOutcome,
  type DeferDeliverableValidationInput,
  type DeferDeliverableValidationOutcome,
  type DeliverableValidationCandidate,
  type DeliverableValidationPublicationTarget,
  type DeliverableValidationRepository,
  type FinalizeDeliverableValidOutcome,
  type FinalizeDeliverableValidationInvalidInput,
  type FinalizeDeliverableValidationMismatchInput,
  type FinalizeDeliverableValidationValidInput,
  type FinalizeDeliverableVerdictOutcome,
  type ManagedOutputMediaFacts,
  type ManagedOutputMediaInvalidReason,
  type PublishValidatedDeliverableInput,
  type PublishValidatedDeliverableOutcome,
} from "@app/domain";
import { randomId } from "@app/shared";
import type { PrismaClient } from "@prisma/client";
import { appendGenerationEvent } from "./orchestration-repositories";

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

const VALIDATION_ID_PREFIX = "gdval";

/** The job, version, composition receipt and validation row, under their locks. */
interface ValidationChainRow {
  readonly organizationId: string;
  readonly jobId: string;
  readonly jobState: string;
  readonly jobVersion: number;
  readonly currentDeliverableVersionId: string | null;
  /** The ordinal of the version the customer currently holds, if any. */
  readonly currentOrdinal: number | null;
  readonly versionId: string;
  readonly versionOrdinal: number;
  readonly highestOrdinal: number;
  readonly compositionStatus: string | null;
  readonly outputStorageKey: string | null;
  readonly outputSha256: string | null;
  readonly outputSizeBytes: bigint | null;
  readonly validationId: string | null;
  readonly validationStatus: string | null;
  readonly validationVersion: number | null;
  readonly validationAttemptCount: number | null;
  readonly validationLeaseExpiresAt: Date | null;
  readonly validationNextAttemptAt: Date | null;
  readonly receiptSha256: string | null;
  readonly receiptSizeBytes: bigint | null;
  readonly invalidReason: string | null;
  readonly container: string | null;
  readonly durationMs: bigint | null;
  readonly videoWidth: bigint | null;
  readonly videoHeight: bigint | null;
  readonly videoStreamCount: bigint | null;
  readonly audioStreamCount: bigint | null;
  readonly validatedAt: Date | null;
}

/** The entitlement hold, read under its own lock. */
interface ReservationRow {
  readonly reservationId: string;
  readonly reservationState: string;
  readonly reservationVersion: number;
  readonly reservationFunding: string;
  readonly reservedTotalVideoUnits: number;
}

export function createDeliverableValidationRepository(
  prisma: PrismaClient,
): DeliverableValidationRepository {
  return {
    async findValidationCandidates({ limit: requested, now }) {
      const limit = validateDeliverableValidationBatchLimit(requested);
      const at = new Date(now);
      // Identifiers only, no lock, no transaction. Every condition the claim
      // refuses on is mirrored here, and that is not redundancy -- it is what
      // keeps the bound useful. A row the claim will always refuse is still
      // listable forever, so enough permanently-ineligible rows at the head of
      // the queue would starve work that could actually be validated.
      //
      // Four arms, and the fourth is the recovery path: a VALID verdict whose
      // publication did not happen. A process that dies between finalize and
      // Transaction G leaves exactly that, and nothing else would ever find it.
      //
      // Terminal INVALID_MEDIA and INTEGRITY_MISMATCH rows match no arm. They are
      // settled answers, and re-offering them would re-claim and re-refuse them
      // forever.
      //
      // The highest-ordinal condition applies to every arm, and it is what stops
      // a *pointer regression*. Once a recomposition begins, the job returns to
      // DELIVERABLE_VALIDATING while the customer's existing version still has an
      // OUTPUT_VERIFIED composition and possibly a VALID verdict -- so without it
      // the old version would be listed, offered to Transaction G, and refused
      // forever while occupying a slot in every bounded batch.
      //
      // Effective-eligibility ordering, the same discipline ADR-0048 settled for
      // media-failure resolution: a row is ordered by the instant it actually
      // becomes due, not by when its deliverable was planned.
      const rows = await prisma.$queryRaw<DeliverableValidationCandidate[]>`
        SELECT v."id"             AS "deliverableVersionId",
               j."id"             AS "generationJobId",
               p."organizationId" AS "organizationId"
          FROM "generation_deliverable_versions" v
          JOIN "generation_jobs" j ON j."id" = v."generationJobId"
          JOIN "video_projects" p ON p."id" = j."videoProjectId"
          JOIN "generation_deliverable_compositions" c
                 ON c."deliverableVersionId" = v."id"
          LEFT JOIN "generation_deliverable_validations" w
                 ON w."deliverableVersionId" = v."id"
         WHERE j."state" = 'DELIVERABLE_VALIDATING'::"GenerationJobState"
           AND c."status" = 'OUTPUT_VERIFIED'::"DeliverableCompositionStatus"
           AND v."ordinal" = (
                 SELECT MAX(sib."ordinal")
                   FROM "generation_deliverable_versions" sib
                  WHERE sib."generationJobId" = j."id"
               )
           AND (
                 w."id" IS NULL
              OR (w."status" = 'PENDING'::"DeliverableValidationStatus"
                  AND w."nextAttemptAt" <= ${at})
              OR (w."status" = 'RUNNING'::"DeliverableValidationStatus"
                  AND w."leaseExpiresAt" <= ${at})
              OR w."status" = 'VALID'::"DeliverableValidationStatus"
               )
         ORDER BY
           CASE
             WHEN w."id" IS NULL THEN c."outputVerifiedAt"
             WHEN w."status" = 'PENDING'::"DeliverableValidationStatus"
               THEN w."nextAttemptAt"
             WHEN w."status" = 'RUNNING'::"DeliverableValidationStatus"
               THEN w."leaseExpiresAt"
             ELSE w."validatedAt"
           END ASC,
           v."createdAt" ASC,
           v."id" ASC
         LIMIT ${limit}
      `;
      return rows.map((row) => ({
        deliverableVersionId: row.deliverableVersionId,
        generationJobId: row.generationJobId,
        organizationId: row.organizationId,
      }));
    },

    async claimDeliverableValidation(input) {
      return prisma.$transaction(async (tx): Promise<ClaimDeliverableValidationOutcome> => {
        const ctx = await lockValidationChain(tx, input.organizationId, input.deliverableVersionId);
        if (ctx === null) return { kind: "NOT_FOUND" };

        // Verdicts first. They are answers, not eligibility, and a terminal row
        // is never reopened whatever the job is doing.
        if (ctx.validationStatus === "VALID") {
          // A VALID verdict behind a job still awaiting publication means
          // Transaction G did not happen -- a crash between the two commits. No
          // lease is taken and nothing is re-validated: the bytes were proved
          // once and the receipt is frozen.
          if (ctx.jobState !== "DELIVERABLE_VALIDATING") return { kind: "NOT_ELIGIBLE" };
          return { kind: "ALREADY_VALID", publication: publicationTarget(ctx) };
        }
        if (
          ctx.validationStatus === "INVALID_MEDIA" ||
          ctx.validationStatus === "INTEGRITY_MISMATCH"
        ) {
          return { kind: "ALREADY_TERMINAL" };
        }

        if (ctx.jobState !== "DELIVERABLE_VALIDATING") return { kind: "NOT_ELIGIBLE" };
        // A superseded cycle's version is not this cycle's work. Refused as an
        // ordinary outcome rather than claimed: composing it again is Phase 5B's
        // business, and validating it would produce a verdict nobody will publish.
        if (ctx.versionOrdinal !== ctx.highestOrdinal) return { kind: "NOT_ELIGIBLE" };

        const receipt = provenCompositionReceipt(ctx, input.organizationId);

        const now = new Date(input.now);
        const leaseExpiresAt = new Date(input.leaseExpiresAt);
        let validationId: string;
        let version: number;
        let attemptCount: number;

        if (ctx.validationId === null) {
          validationId = randomId(VALIDATION_ID_PREFIX);
          version = 1;
          attemptCount = 1;
          await tx.generationDeliverableValidation.create({
            data: {
              id: validationId,
              deliverableVersionId: ctx.versionId,
              status: "RUNNING",
              // Copied from the composition's durable receipt under this lock,
              // never from the object at the key. A record created against bytes
              // the composition does not claim would be a verdict about
              // something nobody published.
              receiptSha256: receipt.sha256,
              receiptSizeBytes: BigInt(receipt.sizeBytes),
              leaseToken: input.leaseToken,
              leaseExpiresAt,
              attemptCount,
              version,
            },
          });
        } else {
          const due =
            ctx.validationStatus === "PENDING"
              ? ctx.validationNextAttemptAt !== null && ctx.validationNextAttemptAt <= now
              : ctx.validationLeaseExpiresAt !== null && ctx.validationLeaseExpiresAt <= now;
          if (!due) return { kind: "NOT_CLAIMABLE" };
          // The frozen binding is re-asserted rather than refreshed. A
          // composition receipt that disagrees with what this record was created
          // against means two different objects were believed canonical, and
          // "repairing" the record is exactly how that evidence is destroyed.
          assertReceiptBinding(ctx, receipt);

          validationId = ctx.validationId;
          version = (ctx.validationVersion ?? 0) + 1;
          attemptCount = (ctx.validationAttemptCount ?? 0) + 1;
          const reclaimed = await tx.generationDeliverableValidation.updateMany({
            where: {
              id: validationId,
              version: ctx.validationVersion ?? -1,
              status: ctx.validationStatus === "PENDING" ? "PENDING" : "RUNNING",
            },
            data: {
              status: "RUNNING",
              leaseToken: input.leaseToken,
              leaseExpiresAt,
              nextAttemptAt: null,
              attemptCount,
              version,
            },
          });
          // The row is locked, so a miss cannot happen; it is still named so a
          // logic error here is zero rows rather than a silent overwrite.
          if (reclaimed.count !== 1) return { kind: "NOT_CLAIMABLE" };
        }

        // No transition event, on any aggregate. Nothing about the job, the
        // deliverable or the entitlement changed: a worker picked up work.
        await assertPointerUnmoved(tx, ctx);
        return {
          kind: "CLAIMED",
          claim: {
            organizationId: ctx.organizationId,
            generationJobId: ctx.jobId,
            deliverableVersionId: ctx.versionId,
            validationId,
            leaseToken: input.leaseToken,
            version,
            attemptCount,
            outputStorageKey: managedDeliverableOutputKey({
              organizationId: ctx.organizationId,
              deliverableVersionId: ctx.versionId,
            }),
            expectedReceipt: receipt,
          },
        };
      });
    },

    async finalizeValid(input: FinalizeDeliverableValidationValidInput) {
      return prisma.$transaction(async (tx): Promise<FinalizeDeliverableValidOutcome> => {
        const ctx = await lockValidationChain(
          tx,
          input.claim.organizationId,
          input.claim.deliverableVersionId,
        );
        if (ctx === null) return { kind: "LEASE_LOST" };

        if (ctx.validationStatus === "VALID") {
          // Replay. A terminal verdict is never rewritten: a second, different
          // set of facts for one deliverable means two different objects were
          // measured, and overwriting would erase which one authorized the
          // publication that may already have happened.
          assertSameFacts(ctx, input.facts);
          assertReceiptBinding(ctx, input.claim.expectedReceipt);
          return { kind: "ALREADY_FINALIZED", publication: publicationTarget(ctx) };
        }
        if (!holdsClaim(ctx, input.claim)) return { kind: "LEASE_LOST" };
        if (ctx.jobState !== "DELIVERABLE_VALIDATING") return { kind: "LEASE_LOST" };
        assertBindingsAgree(ctx, input.claim.organizationId, input.claim.expectedReceipt);

        const version = input.claim.version + 1;
        const written = await tx.generationDeliverableValidation.updateMany({
          where: {
            id: input.claim.validationId,
            status: "RUNNING",
            version: input.claim.version,
            leaseToken: input.claim.leaseToken,
          },
          data: {
            status: "VALID",
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            container: ISO_BMFF_CONTAINER,
            durationMs: BigInt(input.facts.durationMs),
            videoWidth: BigInt(input.facts.videoWidth),
            videoHeight: BigInt(input.facts.videoHeight),
            videoStreamCount: BigInt(input.facts.videoStreamCount),
            audioStreamCount: BigInt(input.facts.audioStreamCount),
            validatedAt: new Date(input.validatedAt),
            version,
          },
        });
        if (written.count !== 1) return { kind: "LEASE_LOST" };

        await appendGenerationEvent(tx, {
          organizationId: ctx.organizationId,
          aggregateType: "DELIVERABLE",
          aggregateId: ctx.versionId,
          fromState: DELIVERABLE_OUTPUT_VERIFIED_STATE,
          toState: DELIVERABLE_VALIDATED_STATE,
          context: {
            ...input.context,
            eventType: DELIVERABLE_VALIDATED_EVENT_TYPE,
            reasonCode: DELIVERABLE_VALIDATION_REASON_CODE,
          },
        });

        // A verdict is not a publication. The job stays DELIVERABLE_VALIDATING,
        // no unit is consumed and the customer keeps whatever they already have
        // until Transaction G commits. Proved rather than asserted: "we do not
        // write that column here" is not a control.
        await assertPointerUnmoved(tx, ctx);
        return {
          kind: "FINALIZED",
          publication: publicationTarget({ ...ctx, validationVersion: version }),
        };
      });
    },

    async finalizeInvalidMedia(input: FinalizeDeliverableValidationInvalidInput) {
      return finalizeTerminalVerdict(prisma, input.claim, "INVALID_MEDIA", input.validatedAt, {
        invalidReason: input.reason,
      });
    },

    async finalizeIntegrityMismatch(input: FinalizeDeliverableValidationMismatchInput) {
      return finalizeTerminalVerdict(
        prisma,
        input.claim,
        "INTEGRITY_MISMATCH",
        input.validatedAt,
        {},
      );
    },

    async deferValidation(input: DeferDeliverableValidationInput) {
      return prisma.$transaction(async (tx): Promise<DeferDeliverableValidationOutcome> => {
        const ctx = await lockValidationChain(
          tx,
          input.claim.organizationId,
          input.claim.deliverableVersionId,
        );
        if (ctx === null) return { kind: "LEASE_LOST" };

        const deferred = await tx.generationDeliverableValidation.updateMany({
          where: {
            id: input.claim.validationId,
            status: "RUNNING",
            version: input.claim.version,
            leaseToken: input.claim.leaseToken,
          },
          data: {
            status: "PENDING",
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: new Date(input.nextAttemptAt),
            version: input.claim.version + 1,
          },
        });
        if (deferred.count !== 1) return { kind: "LEASE_LOST" };
        // No event and no job change: a deferral is not a customer-visible fact,
        // and it is emphatically not a verdict about the video.
        await assertPointerUnmoved(tx, ctx);
        return { kind: "DEFERRED" };
      });
    },

    async publishDeliverable(input: PublishValidatedDeliverableInput) {
      return prisma.$transaction(async (tx): Promise<PublishValidatedDeliverableOutcome> => {
        const target = input.publication;
        // ---- 1. The entitlement lock, first and for the whole transaction. --
        // **Reservation before Job**, the order Transaction H and Transaction I
        // take. Taking the Job first would close a real cycle with settlement,
        // which holds the reservation and then waits for the Job.
        const reservation = await lockReservationForPublication(
          tx,
          target.organizationId,
          target.generationJobId,
        );
        const ctx = await lockValidationChain(
          tx,
          target.organizationId,
          target.deliverableVersionId,
        );
        if (ctx === null) return { kind: "NOT_PUBLISHABLE" };
        // The version must belong to the job this publication names. The
        // composite foreign key behind the pointer refuses a foreign version
        // outright, so this is the caller's pair being checked, not the schema's.
        if (ctx.jobId !== target.generationJobId) {
          throw new DeliverableValidationDefect("FOREIGN_DELIVERABLE_VERSION");
        }

        // ---- 2. Replay, before anything is judged ineligible. ---------------
        // The pointer is the fact. If it already names this version then this
        // publication happened, whatever the job has gone on to do since -- a
        // later revision may already have moved it to REVISING or GENERATING.
        if (ctx.currentDeliverableVersionId === target.deliverableVersionId) {
          const complete =
            ctx.validationStatus === "VALID" && reservation?.reservationState === "CONSUMED";
          if (!complete) throw new DeliverableValidationDefect("PARTIAL_PUBLICATION_STATE");
          return { kind: "ALREADY_PUBLISHED" };
        }
        if (ctx.jobState !== "DELIVERABLE_VALIDATING") return { kind: "NOT_PUBLISHABLE" };

        // ---- 3. The verdict must be the exact VALID row this names. ---------
        if (
          ctx.validationId !== target.validationId ||
          ctx.validationStatus !== "VALID" ||
          ctx.validationVersion !== target.validationVersion
        ) {
          return { kind: "NOT_PUBLISHABLE" };
        }
        // And it must still be a verdict about the composition's own bytes.
        assertBindingsAgree(ctx, target.organizationId, target.receipt);

        // ---- 4. No pointer regression, ever. --------------------------------
        // Ordinals are job-scoped and strictly increasing, so "newer than what
        // the customer holds" is exactly "a higher ordinal". An equal or lower
        // one would replace a customer's video with an older rendition.
        if (ctx.currentOrdinal !== null && ctx.versionOrdinal <= ctx.currentOrdinal) {
          return { kind: "NOT_PUBLISHABLE" };
        }

        // ---- 5. Which publication is this? ----------------------------------
        // The same two legitimate shapes Transaction I admits a cycle for, read
        // back at the end of it. An initial publication spends the customer's
        // entitlement; a recomposition replaces a video they already paid for,
        // and CONSUMED has no outgoing edge, so a second consume is impossible
        // by construction as well as by this branch.
        const initial = ctx.currentDeliverableVersionId === null;
        if (initial) {
          if (
            reservation === null ||
            (reservation.reservationState !== "RESERVED" &&
              reservation.reservationState !== "RECONCILIATION_HOLD")
          ) {
            throw new DeliverableValidationDefect("RESERVATION_NOT_CONSUMABLE");
          }
          // Phase 6A: the Units this commit spends are the frozen allocations,
          // read here and never reselected. A ledger-funded hold whose set does
          // not fund exactly what it reserved, in the job's own quality, is not
          // spent — it fails closed, because consuming it would deliver Units
          // nobody funded or spend more than the customer asked for. A legacy
          // hold recorded no funding source and is consumed as before.
          await assertFrozenFundingIntact(tx, reservation, ctx.jobId);
        } else if (reservation === null || reservation.reservationState !== "CONSUMED") {
          // A job holding a deliverable whose entitlement is not spent has
          // delivered something nobody was charged for. Fails closed.
          throw new DeliverableValidationDefect("PARTIAL_PUBLICATION_STATE");
        }

        // ---- 6. The writes. All of them, or none. ---------------------------
        const moved = await tx.generationJob.updateMany({
          where: {
            id: ctx.jobId,
            state: "DELIVERABLE_VALIDATING",
            stateVersion: ctx.jobVersion,
          },
          data: {
            state: "DELIVERABLE_READY",
            currentDeliverableVersionId: target.deliverableVersionId,
            stateVersion: ctx.jobVersion + 1,
          },
        });
        // Not an outcome: under the job lock taken above this cannot happen, and
        // returning would commit a consumed unit with no published deliverable.
        if (moved.count !== 1) {
          throw new DeliverableValidationDefect("PARTIAL_PUBLICATION_STATE");
        }

        const event = (eventType: string) => ({
          ...input.context,
          eventType,
          reasonCode: DELIVERABLE_PUBLICATION_REASON_CODE,
        });
        await appendGenerationEvent(tx, {
          organizationId: ctx.organizationId,
          aggregateType: "DELIVERABLE",
          aggregateId: ctx.versionId,
          fromState: DELIVERABLE_VALIDATED_STATE,
          toState: DELIVERABLE_PUBLISHED_STATE,
          context: event(DELIVERABLE_PUBLISHED_EVENT_TYPE),
        });
        await appendGenerationEvent(tx, {
          organizationId: ctx.organizationId,
          aggregateType: "JOB",
          aggregateId: ctx.jobId,
          fromState: "DELIVERABLE_VALIDATING",
          toState: "DELIVERABLE_READY",
          context: event(JOB_DELIVERABLE_READY_EVENT_TYPE),
        });

        if (!initial) return { kind: "PUBLISHED_AS_REPLACEMENT" };

        // The unit, spent exactly once, in the commit that makes the video the
        // customer's. `consumedAt` is stamped here and nowhere else: the generic
        // reservation transition refuses both edges into CONSUMED precisely so
        // that this is the only writer.
        const observed = reservation!.reservationState;
        const consumed = await tx.generationReservation.updateMany({
          where: {
            id: reservation!.reservationId,
            state: observed === "RESERVED" ? "RESERVED" : "RECONCILIATION_HOLD",
            stateVersion: reservation!.reservationVersion,
          },
          data: {
            state: "CONSUMED",
            consumedAt: new Date(input.publishedAt),
            stateVersion: reservation!.reservationVersion + 1,
          },
        });
        if (consumed.count !== 1) {
          throw new DeliverableValidationDefect("PARTIAL_PUBLICATION_STATE");
        }
        await appendGenerationEvent(tx, {
          organizationId: ctx.organizationId,
          aggregateType: "RESERVATION",
          aggregateId: reservation!.reservationId,
          fromState: observed,
          toState: "CONSUMED",
          context: event(RESERVATION_CONSUMED_EVENT_TYPE),
        });
        return { kind: "PUBLISHED_AND_CONSUMED" };
      });
    },

    async findValidationByVersionId(organizationId, deliverableVersionId) {
      const rows = await prisma.$queryRaw<
        {
          status: string;
          receiptSha256: string;
          receiptSizeBytes: bigint;
          attemptCount: number;
          version: number;
          leaseExpiresAt: Date | null;
          nextAttemptAt: Date | null;
          invalidReason: string | null;
          container: string | null;
          durationMs: bigint | null;
          videoWidth: bigint | null;
          videoHeight: bigint | null;
          videoStreamCount: bigint | null;
          audioStreamCount: bigint | null;
          validatedAt: Date | null;
        }[]
      >`
        SELECT w."status"::text        AS "status",
               w."receiptSha256"       AS "receiptSha256",
               w."receiptSizeBytes"    AS "receiptSizeBytes",
               w."attemptCount"        AS "attemptCount",
               w."version"             AS "version",
               w."leaseExpiresAt"      AS "leaseExpiresAt",
               w."nextAttemptAt"       AS "nextAttemptAt",
               w."invalidReason"::text AS "invalidReason",
               w."container"::text     AS "container",
               w."durationMs"          AS "durationMs",
               w."videoWidth"          AS "videoWidth",
               w."videoHeight"         AS "videoHeight",
               w."videoStreamCount"    AS "videoStreamCount",
               w."audioStreamCount"    AS "audioStreamCount",
               w."validatedAt"         AS "validatedAt"
          FROM "generation_deliverable_validations" w
          JOIN "generation_deliverable_versions" v ON v."id" = w."deliverableVersionId"
          JOIN "generation_jobs" j ON j."id" = v."generationJobId"
          JOIN "video_projects" p ON p."id" = j."videoProjectId"
         WHERE w."deliverableVersionId" = ${deliverableVersionId}
           AND p."organizationId" = ${organizationId}
      `;
      const row = rows[0];
      if (row === undefined) return null;

      // Every persisted value is proved back into the domain's own range rather
      // than cast. A row outside it is a defect, not a record to hand onward
      // with a reassuring type on it.
      const receipt = deliverableValidationReceipt({
        sha256: sha256Digest(row.receiptSha256),
        sizeBytes: safePositiveByteCount(Number(row.receiptSizeBytes)),
      });
      const common = { receipt, attemptCount: row.attemptCount, version: row.version } as const;
      switch (row.status) {
        case "PENDING":
          if (row.nextAttemptAt === null) {
            throw new DeliverableValidationDefect("PERSISTED_RECORD_MALFORMED");
          }
          return { status: "PENDING", ...common, nextAttemptAt: row.nextAttemptAt.getTime() };
        case "RUNNING":
          if (row.leaseExpiresAt === null) {
            throw new DeliverableValidationDefect("PERSISTED_RECORD_MALFORMED");
          }
          return { status: "RUNNING", ...common, leaseExpiresAt: row.leaseExpiresAt.getTime() };
        case "VALID":
          return {
            status: "VALID",
            ...common,
            facts: persistedFacts(row),
            validatedAt: validatedInstant(row.validatedAt),
          };
        case "INVALID_MEDIA":
          if (!isDeliverableInvalidReason(row.invalidReason)) {
            throw new DeliverableValidationDefect("PERSISTED_RECORD_MALFORMED");
          }
          return {
            status: "INVALID_MEDIA",
            ...common,
            reason: row.invalidReason,
            validatedAt: validatedInstant(row.validatedAt),
          };
        case "INTEGRITY_MISMATCH":
          return {
            status: "INTEGRITY_MISMATCH",
            ...common,
            validatedAt: validatedInstant(row.validatedAt),
          };
        default:
          throw new DeliverableValidationDefect("PERSISTED_RECORD_MALFORMED");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Terminal non-VALID verdicts
// ---------------------------------------------------------------------------

/**
 * `RUNNING` → `INVALID_MEDIA` or `INTEGRITY_MISMATCH`, in one short transaction.
 *
 * One function for both because the restraint is identical and must stay so: no
 * job transition, no unit consumed, no reservation released, no pointer move and
 * no transition event on any aggregate. Two copies of that restraint would be two
 * places for it to be relaxed in.
 *
 * It proves the same three-way receipt agreement `finalizeValid` does, and for a
 * sharper reason. A verdict that a deliverable is *unusable* is terminal and is
 * never reopened — a later claim reads `ALREADY_TERMINAL` and stops — so
 * recording one against bytes that are no longer the composition's condemns a
 * deliverable nobody measured, permanently. `VALID` at least gets re-proved by
 * Transaction G before anything reaches a customer; this path has no second
 * gate, which is why the check cannot be weaker here than there.
 */
async function finalizeTerminalVerdict(
  prisma: PrismaClient,
  claim: {
    readonly organizationId: string;
    readonly deliverableVersionId: string;
    readonly validationId: string;
    readonly leaseToken: string;
    readonly version: number;
    readonly expectedReceipt: { readonly sha256: string; readonly sizeBytes: number };
  },
  status: "INVALID_MEDIA" | "INTEGRITY_MISMATCH",
  validatedAt: number,
  verdict: { readonly invalidReason?: ManagedOutputMediaInvalidReason },
): Promise<FinalizeDeliverableVerdictOutcome> {
  return prisma.$transaction(async (tx): Promise<FinalizeDeliverableVerdictOutcome> => {
    const ctx = await lockValidationChain(tx, claim.organizationId, claim.deliverableVersionId);
    if (ctx === null) return { kind: "LEASE_LOST" };

    if (ctx.validationStatus === "VALID") {
      // A usable deliverable cannot become an unusable one. This is a
      // contradiction between two measurements of immutable bytes, never a
      // correction to apply.
      throw new DeliverableValidationDefect("VALIDATION_VERDICT_CONFLICT");
    }
    if (ctx.validationStatus === "INVALID_MEDIA" || ctx.validationStatus === "INTEGRITY_MISMATCH") {
      if (
        ctx.validationStatus !== status ||
        ctx.invalidReason !== (verdict.invalidReason ?? null)
      ) {
        throw new DeliverableValidationDefect("VALIDATION_VERDICT_CONFLICT");
      }
      return { kind: "ALREADY_FINALIZED" };
    }
    if (!holdsClaim(ctx, claim)) return { kind: "LEASE_LOST" };
    // The same proof `finalizeValid` makes, through the same function rather than
    // a second comparison that could drift from it: the caller's receipt, the
    // row's frozen binding and the composition's current receipt must still
    // identify one set of bytes. Ordered after `holdsClaim` on purpose — a worker
    // whose row was reclaimed loses as an ordinary `LEASE_LOST`, and only a
    // caller that genuinely still holds the row can raise a defect here.
    assertBindingsAgree(ctx, claim.organizationId, claim.expectedReceipt);

    const written = await tx.generationDeliverableValidation.updateMany({
      where: {
        id: claim.validationId,
        status: "RUNNING",
        version: claim.version,
        leaseToken: claim.leaseToken,
      },
      data: {
        status,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        invalidReason: status === "INVALID_MEDIA" ? (verdict.invalidReason ?? null) : null,
        validatedAt: new Date(validatedAt),
        version: claim.version + 1,
      },
    });
    if (written.count !== 1) return { kind: "LEASE_LOST" };

    // Deliberately no transition event, on any aggregate, and no job move. The
    // job really does stay DELIVERABLE_VALIDATING, and inventing a customer-
    // visible failure state to carry this would put a value in the event stream
    // that no reviewed state machine contains. Nothing else moves either: during
    // a recomposition the customer may already hold a perfectly good video, and
    // settling an entitlement over a replacement that could not be validated
    // charges the platform's problem to them.
    await assertPointerUnmoved(tx, ctx);
    return { kind: "FINALIZED" };
  });
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

/**
 * Lock the job, the deliverable version, its composition and its validation, in
 * that order, and read all four under those locks.
 *
 * ## Why the lock and the read are separate statements
 *
 * This is not style. Under `READ COMMITTED` — Prisma's default — a statement that
 * blocks on `FOR UPDATE` re-evaluates the *locked* row when it is released, but
 * every other table in the same statement is still read from the snapshot taken
 * when the statement began. So a single locking statement with the composition
 * and validation rows outer-joined into it returns a **pre-block** view of them:
 * two workers racing to create the first validation record would both see no row,
 * both insert, and the loser would learn it through a raw uniqueness error rather
 * than through the outcome union its caller is written against.
 *
 * Locking first and reading afterwards fixes it exactly: the second statement
 * takes a fresh snapshot, so the loser sees the winner's committed row and
 * answers `NOT_CLAIMABLE`. A race test pins this against two real connections.
 *
 * ## Why the job and version locks are the ones that matter
 *
 * Every writer of a validation row is in this file, and every one of them takes
 * these two locks first; Phase 5B's composition writer takes the same two, in the
 * same order. The composition and validation row locks below are defence in
 * depth, taken after the read because they sit on the nullable side of an outer
 * join where PostgreSQL refuses `FOR UPDATE` — nothing can have changed them
 * between the read and the lock, because nothing can reach them without the job
 * lock this transaction already holds.
 *
 * The reservation is neither joined nor locked here. The lifecycle moves no
 * entitlement; Transaction G locks it separately, and first.
 *
 * A cross-tenant or unknown id matches no row, locks nothing, and is reported
 * exactly as a missing one — the caller's organization id is never trusted on its
 * own, and nothing discloses that the version exists for someone else.
 */
async function lockValidationChain(
  tx: Tx,
  organizationId: string,
  deliverableVersionId: string,
): Promise<ValidationChainRow | null> {
  const locked = await tx.$queryRaw<{ jobId: string }[]>`
    SELECT j."id" AS "jobId"
      FROM "generation_deliverable_versions" v
      JOIN "generation_jobs" j ON j."id" = v."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
     WHERE v."id" = ${deliverableVersionId}
       AND p."organizationId" = ${organizationId}
       FOR UPDATE OF j, v
  `;
  if (locked.length === 0) return null;

  const rows = await tx.$queryRaw<ValidationChainRow[]>`
    SELECT p."organizationId"              AS "organizationId",
           j."id"                          AS "jobId",
           j."state"::text                 AS "jobState",
           j."stateVersion"                AS "jobVersion",
           j."currentDeliverableVersionId" AS "currentDeliverableVersionId",
           cur."ordinal"                   AS "currentOrdinal",
           v."id"                          AS "versionId",
           v."ordinal"                     AS "versionOrdinal",
           (SELECT MAX(sib."ordinal")
              FROM "generation_deliverable_versions" sib
             WHERE sib."generationJobId" = j."id")  AS "highestOrdinal",
           c."status"::text                AS "compositionStatus",
           c."outputStorageKey"            AS "outputStorageKey",
           c."outputSha256"                AS "outputSha256",
           c."outputSizeBytes"             AS "outputSizeBytes",
           w."id"                          AS "validationId",
           w."status"::text                AS "validationStatus",
           w."version"                     AS "validationVersion",
           w."attemptCount"                AS "validationAttemptCount",
           w."leaseExpiresAt"              AS "validationLeaseExpiresAt",
           w."nextAttemptAt"               AS "validationNextAttemptAt",
           w."receiptSha256"               AS "receiptSha256",
           w."receiptSizeBytes"            AS "receiptSizeBytes",
           w."invalidReason"::text         AS "invalidReason",
           w."container"::text             AS "container",
           w."durationMs"                  AS "durationMs",
           w."videoWidth"                  AS "videoWidth",
           w."videoHeight"                 AS "videoHeight",
           w."videoStreamCount"            AS "videoStreamCount",
           w."audioStreamCount"            AS "audioStreamCount",
           w."validatedAt"                 AS "validatedAt"
      FROM "generation_deliverable_versions" v
      JOIN "generation_jobs" j ON j."id" = v."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
      LEFT JOIN "generation_deliverable_versions" cur
             ON cur."id" = j."currentDeliverableVersionId"
      LEFT JOIN "generation_deliverable_compositions" c
             ON c."deliverableVersionId" = v."id"
      LEFT JOIN "generation_deliverable_validations" w
             ON w."deliverableVersionId" = v."id"
     WHERE v."id" = ${deliverableVersionId}
       AND p."organizationId" = ${organizationId}
  `;
  const row = rows[0];
  if (row === undefined) return null;
  await tx.$queryRaw`
    SELECT "id" FROM "generation_deliverable_compositions"
     WHERE "deliverableVersionId" = ${row.versionId} FOR UPDATE
  `;
  if (row.validationId !== null) {
    await tx.$queryRaw`
      SELECT "id" FROM "generation_deliverable_validations"
       WHERE "id" = ${row.validationId} FOR UPDATE
    `;
  }
  return row;
}

/**
 * Lock the entitlement hold and read the state Transaction G will act on.
 *
 * The hold's state is publication authority: it decides whether this cycle owes a
 * unit at all, and reading it unlocked would be a time-of-check/time-of-use hole
 * — a concurrent release or reconciliation move could change it after the read
 * and before the publication committed, spending or skipping a unit against an
 * entitlement that no longer said so.
 *
 * Taken **before** the job, matching Transaction H and Transaction I. A job with
 * no reservation locks nothing and returns `null`, which the caller refuses.
 */
async function lockReservationForPublication(
  tx: Tx,
  organizationId: string,
  generationJobId: string,
): Promise<ReservationRow | null> {
  const rows = await tx.$queryRaw<ReservationRow[]>`
    SELECT res."id"                      AS "reservationId",
           res."state"::text             AS "reservationState",
           res."stateVersion"            AS "reservationVersion",
           res."funding"::text           AS "reservationFunding",
           res."reservedTotalVideoUnits" AS "reservedTotalVideoUnits"
      FROM "generation_reservations" res
      JOIN "generation_jobs" j ON j."id" = res."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
     WHERE res."generationJobId" = ${generationJobId}
       AND p."organizationId" = ${organizationId}
       FOR UPDATE OF res
  `;
  return rows[0] ?? null;
}

/**
 * A ledger-funded hold's frozen allocations fund exactly what it reserved.
 *
 * Read after the reservation lock and never locked themselves: allocation rows
 * have no update path, so there is nothing to race. The comparison is the
 * domain's, so Transaction G and the ledger cannot disagree about what "funded"
 * means.
 */
async function assertFrozenFundingIntact(
  tx: Tx,
  reservation: ReservationRow,
  generationJobId: string,
): Promise<void> {
  if (reservation.reservationFunding !== "ALLOCATED") return;
  const job = await tx.generationJob.findUniqueOrThrow({
    where: { id: generationJobId },
    select: { qualityTier: true },
  });
  const allocations = await tx.generationReservationAllocation.findMany({
    where: { reservationId: reservation.reservationId },
    select: { quality: true, quantity: true },
  });
  if (
    !frozenFundingCoversReservation({
      quality: job.qualityTier,
      reservedUnits: reservation.reservedTotalVideoUnits,
      allocations,
    })
  ) {
    throw new DeliverableValidationDefect("RESERVATION_FUNDING_INCOMPLETE");
  }
}

// ---------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------

/**
 * The composition's durable receipt, proved complete and canonical, or a defect.
 *
 * Three separate things are being refused, and each would otherwise produce a
 * verdict about the wrong bytes: a job awaiting validation whose composition
 * never verified, a verified composition with a half-written receipt, and a
 * receipt naming an object that is not this deliverable's canonical key.
 */
function provenCompositionReceipt(ctx: ValidationChainRow, organizationId: string) {
  if (ctx.compositionStatus !== "OUTPUT_VERIFIED") {
    throw new DeliverableValidationDefect("COMPOSITION_NOT_VERIFIED");
  }
  if (
    ctx.outputStorageKey === null ||
    ctx.outputSha256 === null ||
    ctx.outputSizeBytes === null ||
    ctx.outputStorageKey !==
      managedDeliverableOutputKey({
        organizationId,
        deliverableVersionId: ctx.versionId,
      })
  ) {
    throw new DeliverableValidationDefect("COMPOSITION_RECEIPT_INCOMPLETE");
  }
  return {
    sha256: sha256Digest(ctx.outputSha256),
    sizeBytes: safePositiveByteCount(Number(ctx.outputSizeBytes)),
  };
}

/**
 * Three receipts, and all three must be the same bytes.
 *
 * The caller's (what was validated or is being published), the validation row's
 * frozen binding (what the record has always been about), and the composition's
 * own durable receipt (what the platform says it published). Comparing only two
 * of them leaves the third free to move: an earlier version of this code proved
 * the claim against the frozen binding and then read the composition receipt
 * without comparing it, so a composition whose receipt changed underneath a
 * running validation was finalized as a verdict about bytes nobody had measured.
 */
function assertBindingsAgree(
  ctx: ValidationChainRow,
  organizationId: string,
  expected: { readonly sha256: string; readonly sizeBytes: number },
): void {
  const composition = provenCompositionReceipt(ctx, organizationId);
  if (
    composition.sha256 !== expected.sha256 ||
    composition.sizeBytes !== expected.sizeBytes
  ) {
    throw new DeliverableValidationDefect("VALIDATION_RECEIPT_CONFLICT");
  }
  assertReceiptBinding(ctx, expected);
}

/** The frozen binding must still name the bytes the caller is judging. */
function assertReceiptBinding(
  ctx: ValidationChainRow,
  receipt: { readonly sha256: string; readonly sizeBytes: number },
): void {
  if (ctx.receiptSha256 === null || ctx.receiptSizeBytes === null) return;
  if (
    ctx.receiptSha256 !== receipt.sha256 ||
    ctx.receiptSizeBytes !== BigInt(receipt.sizeBytes)
  ) {
    throw new DeliverableValidationDefect("VALIDATION_RECEIPT_CONFLICT");
  }
}

/** A replayed `VALID` verdict must describe the same video, to the byte. */
function assertSameFacts(ctx: ValidationChainRow, facts: ManagedOutputMediaFacts): void {
  const same =
    ctx.container === facts.container &&
    ctx.durationMs === BigInt(facts.durationMs) &&
    ctx.videoWidth === BigInt(facts.videoWidth) &&
    ctx.videoHeight === BigInt(facts.videoHeight) &&
    ctx.videoStreamCount === BigInt(facts.videoStreamCount) &&
    ctx.audioStreamCount === BigInt(facts.audioStreamCount);
  if (!same) throw new DeliverableValidationDefect("VALIDATION_VERDICT_CONFLICT");
}

/** Whether the row is still the exact `RUNNING` row this claim took. */
function holdsClaim(
  ctx: ValidationChainRow,
  claim: { readonly validationId: string; readonly version: number },
): boolean {
  return (
    ctx.validationId === claim.validationId &&
    ctx.validationStatus === "RUNNING" &&
    ctx.validationVersion === claim.version
  );
}

/** The customer's published deliverable must be exactly where it was. */
async function assertPointerUnmoved(tx: Tx, ctx: ValidationChainRow): Promise<void> {
  const after = await tx.generationJob.findFirst({
    where: { id: ctx.jobId },
    select: { currentDeliverableVersionId: true },
  });
  if (after?.currentDeliverableVersionId !== ctx.currentDeliverableVersionId) {
    throw new DeliverableValidationDefect("PARTIAL_PUBLICATION_STATE");
  }
}

/** The identity Transaction G needs, and deliberately nothing more. */
function publicationTarget(ctx: ValidationChainRow): DeliverableValidationPublicationTarget {
  if (
    ctx.validationId === null ||
    ctx.validationVersion === null ||
    ctx.receiptSha256 === null ||
    ctx.receiptSizeBytes === null
  ) {
    throw new DeliverableValidationDefect("PERSISTED_RECORD_MALFORMED");
  }
  return {
    organizationId: ctx.organizationId,
    generationJobId: ctx.jobId,
    deliverableVersionId: ctx.versionId,
    validationId: ctx.validationId,
    validationVersion: ctx.validationVersion,
    receipt: deliverableValidationReceipt({
      sha256: sha256Digest(ctx.receiptSha256),
      sizeBytes: safePositiveByteCount(Number(ctx.receiptSizeBytes)),
    }),
  };
}

/** The five normalized facts, proved back into the domain's own range. */
function persistedFacts(row: {
  readonly container: string | null;
  readonly durationMs: bigint | null;
  readonly videoWidth: bigint | null;
  readonly videoHeight: bigint | null;
  readonly videoStreamCount: bigint | null;
  readonly audioStreamCount: bigint | null;
}): ManagedOutputMediaFacts {
  if (
    row.container !== ISO_BMFF_CONTAINER ||
    row.durationMs === null ||
    row.videoWidth === null ||
    row.videoHeight === null ||
    row.videoStreamCount === null ||
    row.audioStreamCount === null
  ) {
    throw new DeliverableValidationDefect("PERSISTED_RECORD_MALFORMED");
  }
  return {
    container: ISO_BMFF_CONTAINER,
    durationMs: Number(row.durationMs),
    videoWidth: Number(row.videoWidth),
    videoHeight: Number(row.videoHeight),
    videoStreamCount: Number(row.videoStreamCount),
    audioStreamCount: Number(row.audioStreamCount),
  };
}

function validatedInstant(value: Date | null): number {
  if (value === null) throw new DeliverableValidationDefect("PERSISTED_RECORD_MALFORMED");
  return value.getTime();
}
