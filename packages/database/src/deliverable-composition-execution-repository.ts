/**
 * Transactions J1 and J2 — durable composition execution.
 *
 * Three short database transactions, and nothing else. No object-store read, no
 * subprocess, no HTTP is reachable from inside any of them: a transaction held
 * open across a multi-gigabyte download and a twenty-minute encode pins a pooled
 * connection for the whole encode, and one slow deliverable becomes a
 * database-wide outage.
 *
 * ```text
 * J1  claim     COMPOSITION_PENDING -> COMPOSING, work created RUNNING
 *     (retry)   PENDING|expired RUNNING -> RUNNING, job untouched
 * --- external: materialize, compose, publish ---
 * J2  finalize  work -> OUTPUT_VERIFIED, COMPOSING -> DELIVERABLE_VALIDATING
 *     defer     work -> PENDING with a closed retry code, job untouched
 * ```
 *
 * ## Lock order
 *
 * ```text
 * GenerationJob → GenerationDeliverableVersion → composition work
 * ```
 *
 * The reservation is **not** locked and not read. Composition execution moves no
 * entitlement, so it has no reason to serialize against the workflows that do.
 * The system-wide `Reservation -> Job` rule constrains transactions that lock
 * *both* rows; adding a reservation lock here purely for symmetry would create
 * contention with settlement over a row this code never touches.
 */

import {
  COMPOSABLE_TARGETS,
  COMPOSITION_EXECUTION_REASON_CODE,
  DELIVERABLE_COMPOSING_EVENT_TYPE,
  DELIVERABLE_COMPOSING_STATE,
  DELIVERABLE_COMPOSITION_BLOCKED_EVENT_TYPE,
  DELIVERABLE_COMPOSITION_BLOCKED_STATE,
  DELIVERABLE_OUTPUT_VERIFIED_EVENT_TYPE,
  DELIVERABLE_OUTPUT_VERIFIED_STATE,
  DeliverableCompositionExecutionDefect,
  JOB_COMPOSING_EVENT_TYPE,
  JOB_DELIVERABLE_VALIDATING_EVENT_TYPE,
  assertRunnableProfile,
  managedDeliverableOutputKey,
  managedGenerationOutputKey,
  resolveCompositionProfile,
  safePositiveByteCount,
  sha256Digest,
  validateCompositionBatchLimit,
  type BlockCompositionInput,
  type BlockCompositionOutcome,
  type ClaimCompositionWorkInput,
  type ClaimCompositionWorkOutcome,
  type CompositionProfile,
  type CompositionSceneInput,
  type DeferCompositionInput,
  type DeferCompositionOutcome,
  type DeliverableCompositionCandidate,
  type DeliverableCompositionRecord,
  type DeliverableCompositionRepository,
  type FinalizeCompositionInput,
  type FinalizeCompositionOutcome,
} from "@app/domain";
import { randomId } from "@app/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import { appendGenerationEvent } from "./orchestration-repositories";

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

const COMPOSITION_ID_PREFIX = "gdcmp";

/**
 * The composable `(aspect ratio, resolution)` pairs, as bound parameters.
 *
 * Built from the domain's own raster table rather than written out in SQL, so
 * the discovery filter and the claim's profile resolution cannot disagree about
 * what v1 composes. Every element is a parameter, not interpolated text.
 */
const COMPOSABLE_TARGET_PAIRS = Prisma.join(
  COMPOSABLE_TARGETS.map(
    (target) =>
      Prisma.sql`(${target.targetAspectRatio}, ${target.targetOutputResolution})`,
  ),
);

/** The job and its pending plan, read under the locks the claim has taken. */
interface ClaimContextRow {
  readonly organizationId: string;
  readonly jobId: string;
  readonly jobState: string;
  readonly jobVersion: number;
  readonly currentDeliverableVersionId: string | null;
  readonly targetOutputResolution: string;
  readonly targetAspectRatio: string;
  readonly requestedDurationSeconds: number;
  readonly versionId: string;
  readonly versionOrdinal: number;
  readonly workId: string | null;
  readonly workStatus: string | null;
  readonly workVersion: number | null;
  readonly workLeaseExpiresAt: Date | null;
  readonly workNextAttemptAt: Date | null;
  readonly workAttemptCount: number | null;
  readonly workProfileKey: string | null;
  readonly workWidth: number | null;
  readonly workHeight: number | null;
  readonly workFpsNum: number | null;
  readonly workFpsDen: number | null;
  readonly workCodec: string | null;
  readonly workPixelFormat: string | null;
  readonly workFitMode: string | null;
  readonly workTransitionMode: string | null;
  readonly workAudioMode: string | null;
  readonly workPreset: string | null;
  readonly workCrf: number | null;
}

/** One frozen input joined to the immutable scene duration it names. */
interface PlanInputRow {
  readonly position: number;
  readonly generationSceneId: string;
  readonly sceneGenerationAttemptId: string;
  readonly mediaValidationId: string;
  readonly sourceSha256: string;
  readonly sourceSizeBytes: bigint;
  readonly snapshotDurationSeconds: number;
  readonly attemptOutputSha256: string | null;
  readonly attemptOutputSizeBytes: bigint | null;
  readonly validationStatus: string | null;
  readonly validationReceiptSha256: string | null;
  readonly validationReceiptSizeBytes: bigint | null;
}

export function createDeliverableCompositionExecutionRepository(
  prisma: PrismaClient,
): DeliverableCompositionRepository {
  return {
    async findCompositionCandidates({ limit: requested, now }) {
      const limit = validateCompositionBatchLimit(requested);
      const at = new Date(now);
      // Identifiers only, no lock, no transaction. Every condition the claim
      // refuses on is mirrored here, and that is not redundancy — it is what
      // keeps the bound useful. A row the claim will always refuse is still
      // listable forever, so enough permanently-ineligible rows at the head of
      // the queue would starve work that could actually be composed.
      //
      // Effective-eligibility ordering, the same discipline ADR-0048 settled for
      // media-failure resolution: a row is ordered by the instant it actually
      // becomes due, not by when its deliverable was planned. Ordering by plan
      // age alone lets a deferred row reclaim the head of the queue the moment
      // it is deferred, and a slow scheduler then re-offers the same prefix
      // forever.
      //
      // Two classes are excluded for exactly that reason. `BLOCKED` rows match
      // no arm below, because a deterministic refusal that kept appearing in
      // the batch would be re-claimed and re-refused forever. And a job whose
      // frozen delivery target is outside profile v1 is filtered here rather
      // than discovered at claim time — every claim would refuse it, so leaving
      // it listable lets enough such jobs crowd out work that can be composed.
      const rows = await prisma.$queryRaw<DeliverableCompositionCandidate[]>`
        SELECT v."id"              AS "deliverableVersionId",
               j."id"              AS "generationJobId",
               p."organizationId"  AS "organizationId"
          FROM "generation_deliverable_versions" v
          JOIN "generation_jobs" j ON j."id" = v."generationJobId"
          JOIN "video_projects" p ON p."id" = j."videoProjectId"
          LEFT JOIN "generation_deliverable_compositions" w
                 ON w."deliverableVersionId" = v."id"
         WHERE (
                 (w."id" IS NULL AND j."state" = 'COMPOSITION_PENDING'::"GenerationJobState")
              OR (w."status" = 'PENDING'::"DeliverableCompositionStatus"
                  AND w."nextAttemptAt" <= ${at}
                  AND j."state" = 'COMPOSING'::"GenerationJobState")
              OR (w."status" = 'RUNNING'::"DeliverableCompositionStatus"
                  AND w."leaseExpiresAt" <= ${at}
                  AND j."state" = 'COMPOSING'::"GenerationJobState")
               )
           AND (j."targetAspectRatio", j."targetOutputResolution")
               IN (${COMPOSABLE_TARGET_PAIRS})
         ORDER BY
           CASE
             WHEN w."id" IS NULL THEN v."createdAt"
             WHEN w."status" = 'PENDING'::"DeliverableCompositionStatus"
               THEN w."nextAttemptAt"
             WHEN w."status" = 'RUNNING'::"DeliverableCompositionStatus"
               THEN w."leaseExpiresAt"
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

    async claimCompositionWork(input: ClaimCompositionWorkInput) {
      return prisma.$transaction(async (tx): Promise<ClaimCompositionWorkOutcome> => {
        const ctx = await lockClaimChain(tx, input.organizationId, input.deliverableVersionId);
        if (ctx === null) return { kind: "NOT_FOUND" };

        if (ctx.workStatus === "OUTPUT_VERIFIED") return { kind: "ALREADY_VERIFIED" };
        // Stated rather than left to fall out of the due-date arithmetic below.
        // A BLOCKED row has no lease and no next attempt, so it would be
        // refused anyway — but "there is no instant at which this becomes due"
        // is a weak reason for a rule that must never be reachable.
        if (ctx.workStatus === "BLOCKED") return { kind: "NOT_CLAIMABLE" };

        const now = new Date(input.now);
        const first = ctx.workId === null;

        // Which claim is this, and is it allowed right now?
        if (first) {
          // A first claim is only legitimate from a job awaiting composition,
          // and only for the plan of *this* pending cycle — the Phase 5A replay
          // rules, reused rather than re-derived.
          if (ctx.jobState !== "COMPOSITION_PENDING") return { kind: "NOT_CLAIMABLE" };
          assertPendingCycleVersion(ctx);
        } else {
          // A retry is only legitimate while the job is already composing.
          if (ctx.jobState !== "COMPOSING") return { kind: "NOT_CLAIMABLE" };
          const due =
            ctx.workStatus === "PENDING"
              ? ctx.workNextAttemptAt !== null && ctx.workNextAttemptAt <= now
              : ctx.workLeaseExpiresAt !== null && ctx.workLeaseExpiresAt <= now;
          if (!due) return { kind: "NOT_CLAIMABLE" };
        }

        // The profile: derived once, reused verbatim forever after. Resolved
        // before anything is read or written, so a job this build cannot
        // compose leaves the transaction exactly as it found it.
        let profile: CompositionProfile;
        if (first) {
          const resolved = resolveCompositionProfile({
            targetAspectRatio: ctx.targetAspectRatio,
            targetOutputResolution: ctx.targetOutputResolution,
          });
          if (resolved.kind !== "RESOLVED") return { kind: "UNSUPPORTED_TARGET" };
          profile = resolved.profile;
        } else {
          profile = persistedProfile(ctx);
        }

        const plan = await readPlanInputs(tx, ctx.versionId);
        if (plan.length === 0) {
          throw new DeliverableCompositionExecutionDefect("PLAN_NOT_EXECUTABLE");
        }
        const scenes = proveExecutablePlan(ctx, plan);

        const leaseExpiresAt = new Date(input.leaseExpiresAt);
        let compositionId: string;
        let version: number;
        let attemptCount: number;

        if (first) {
          compositionId = randomId(COMPOSITION_ID_PREFIX);
          version = 1;
          attemptCount = 1;
          await tx.generationDeliverableComposition.create({
            data: {
              id: compositionId,
              deliverableVersionId: ctx.versionId,
              status: "RUNNING",
              profileKey: profile.profileKey,
              targetWidthPx: profile.targetWidthPx,
              targetHeightPx: profile.targetHeightPx,
              frameRateNumerator: profile.frameRateNumerator,
              frameRateDenominator: profile.frameRateDenominator,
              videoCodec: profile.videoCodec,
              pixelFormat: profile.pixelFormat,
              fitMode: profile.fitMode,
              transitionMode: profile.transitionMode,
              audioMode: profile.audioMode,
              encoderPreset: profile.encoderPreset,
              crf: profile.crf,
              leaseToken: input.leaseToken,
              leaseExpiresAt,
              attemptCount,
              version,
            },
          });

          const event = (eventType: string) => ({
            ...input.context,
            eventType,
            reasonCode: COMPOSITION_EXECUTION_REASON_CODE,
          });
          await appendGenerationEvent(tx, {
            organizationId: ctx.organizationId,
            aggregateType: "DELIVERABLE",
            aggregateId: ctx.versionId,
            fromState: null,
            toState: DELIVERABLE_COMPOSING_STATE,
            context: event(DELIVERABLE_COMPOSING_EVENT_TYPE),
          });

          const moved = await tx.generationJob.updateMany({
            where: {
              id: ctx.jobId,
              state: "COMPOSITION_PENDING",
              stateVersion: ctx.jobVersion,
            },
            data: { state: "COMPOSING", stateVersion: ctx.jobVersion + 1 },
          });
          // Not an outcome: the work row is already written in this transaction,
          // and returning would commit it with the job left behind. Under the
          // job lock taken above this cannot happen.
          if (moved.count !== 1) {
            throw new DeliverableCompositionExecutionDefect("PARTIAL_COMPOSITION_STATE");
          }
          await appendGenerationEvent(tx, {
            organizationId: ctx.organizationId,
            aggregateType: "JOB",
            aggregateId: ctx.jobId,
            fromState: "COMPOSITION_PENDING",
            toState: "COMPOSING",
            context: event(JOB_COMPOSING_EVENT_TYPE),
          });
        } else {
          compositionId = ctx.workId!;
          version = ctx.workVersion! + 1;
          attemptCount = ctx.workAttemptCount! + 1;
          const reclaimed = await tx.generationDeliverableComposition.updateMany({
            where: {
              id: compositionId,
              version: ctx.workVersion!,
              status: ctx.workStatus === "PENDING" ? "PENDING" : "RUNNING",
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
          // Deliberately no job transition and no job event. The job is already
          // COMPOSING, and a second COMPOSITION_PENDING -> COMPOSING event would
          // record a state change that did not happen.
        }

        return {
          kind: "CLAIMED",
          claim: {
            organizationId: ctx.organizationId,
            generationJobId: ctx.jobId,
            deliverableVersionId: ctx.versionId,
            compositionId,
            leaseToken: input.leaseToken,
            version,
            attemptCount,
            profile,
            outputStorageKey: managedDeliverableOutputKey({
              organizationId: ctx.organizationId,
              deliverableVersionId: ctx.versionId,
            }),
            requestedDurationSeconds: ctx.requestedDurationSeconds,
            scenes,
          },
        };
      });
    },

    async finalizeComposition(input: FinalizeCompositionInput) {
      return prisma.$transaction(async (tx): Promise<FinalizeCompositionOutcome> => {
        const ctx = await lockClaimChain(
          tx,
          input.claim.organizationId,
          input.claim.deliverableVersionId,
        );
        if (ctx === null) return { kind: "LEASE_LOST" };

        const expectedKey = managedDeliverableOutputKey({
          organizationId: input.claim.organizationId,
          deliverableVersionId: input.claim.deliverableVersionId,
        });

        if (ctx.workStatus === "OUTPUT_VERIFIED") {
          // Replay. The durable receipt is never rewritten: a second, different
          // receipt for one deliverable means two different objects were
          // believed canonical, and silently overwriting would erase the
          // evidence of which one a later phase may already have validated.
          const stored = await tx.generationDeliverableComposition.findUniqueOrThrow({
            where: { deliverableVersionId: input.claim.deliverableVersionId },
            select: { outputStorageKey: true, outputSha256: true, outputSizeBytes: true },
          });
          const same =
            stored.outputStorageKey === expectedKey &&
            stored.outputSha256 === input.outputSha256 &&
            stored.outputSizeBytes !== null &&
            stored.outputSizeBytes === BigInt(input.outputSizeBytes);
          if (!same) {
            throw new DeliverableCompositionExecutionDefect("OUTPUT_RECEIPT_CONFLICT");
          }
          return { kind: "ALREADY_FINALIZED" };
        }

        // The lease and version this caller observed must still be the row's.
        // Anything else means another worker reclaimed the work while this one
        // was composing; its object is harmless, but it may not write history.
        if (
          ctx.workId !== input.claim.compositionId ||
          ctx.workStatus !== "RUNNING" ||
          ctx.workVersion !== input.claim.version
        ) {
          return { kind: "LEASE_LOST" };
        }
        if (ctx.jobState !== "COMPOSING") return { kind: "LEASE_LOST" };

        const verified = await tx.generationDeliverableComposition.updateMany({
          where: {
            id: input.claim.compositionId,
            status: "RUNNING",
            version: input.claim.version,
            leaseToken: input.claim.leaseToken,
          },
          data: {
            status: "OUTPUT_VERIFIED",
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            outputStorageKey: expectedKey,
            outputSha256: input.outputSha256,
            outputSizeBytes: BigInt(input.outputSizeBytes),
            outputVerifiedAt: new Date(input.verifiedAt),
            version: input.claim.version + 1,
          },
        });
        if (verified.count !== 1) return { kind: "LEASE_LOST" };

        const event = (eventType: string) => ({
          ...input.context,
          eventType,
          reasonCode: COMPOSITION_EXECUTION_REASON_CODE,
        });
        await appendGenerationEvent(tx, {
          organizationId: ctx.organizationId,
          aggregateType: "DELIVERABLE",
          aggregateId: ctx.versionId,
          fromState: DELIVERABLE_COMPOSING_STATE,
          toState: DELIVERABLE_OUTPUT_VERIFIED_STATE,
          context: event(DELIVERABLE_OUTPUT_VERIFIED_EVENT_TYPE),
        });

        const moved = await tx.generationJob.updateMany({
          where: { id: ctx.jobId, state: "COMPOSING", stateVersion: ctx.jobVersion },
          data: { state: "DELIVERABLE_VALIDATING", stateVersion: ctx.jobVersion + 1 },
        });
        if (moved.count !== 1) {
          throw new DeliverableCompositionExecutionDefect("PARTIAL_COMPOSITION_STATE");
        }
        await appendGenerationEvent(tx, {
          organizationId: ctx.organizationId,
          aggregateType: "JOB",
          aggregateId: ctx.jobId,
          fromState: "COMPOSING",
          toState: "DELIVERABLE_VALIDATING",
          context: event(JOB_DELIVERABLE_VALIDATING_EVENT_TYPE),
        });

        // The customer keeps the video they already have. Proved rather than
        // asserted: "we do not write that column here" is not a control.
        await assertPointerUnmoved(tx, ctx);
        return { kind: "FINALIZED" };
      });
    },

    async deferComposition(input: DeferCompositionInput): Promise<DeferCompositionOutcome> {
      return prisma.$transaction(async (tx): Promise<DeferCompositionOutcome> => {
        const ctx = await lockClaimChain(
          tx,
          input.claim.organizationId,
          input.claim.deliverableVersionId,
        );
        if (ctx === null) return { kind: "LEASE_LOST" };

        const deferred = await tx.generationDeliverableComposition.updateMany({
          where: {
            id: input.claim.compositionId,
            status: "RUNNING",
            version: input.claim.version,
            leaseToken: input.claim.leaseToken,
          },
          data: {
            status: "PENDING",
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: new Date(input.nextAttemptAt),
            lastRetryCode: input.retryCode,
            version: input.claim.version + 1,
          },
        });
        if (deferred.count !== 1) return { kind: "LEASE_LOST" };
        // The job stays COMPOSING and no job event is appended: nothing about
        // the job changed, and a deferral is not a customer-visible fact.
        await assertPointerUnmoved(tx, ctx);
        return { kind: "DEFERRED" };
      });
    },

    async blockComposition(input: BlockCompositionInput): Promise<BlockCompositionOutcome> {
      return prisma.$transaction(async (tx): Promise<BlockCompositionOutcome> => {
        const ctx = await lockClaimChain(
          tx,
          input.claim.organizationId,
          input.claim.deliverableVersionId,
        );
        if (ctx === null) return { kind: "LEASE_LOST" };

        if (ctx.workStatus === "BLOCKED") {
          // Replay. A block already recorded is never rewritten: a different
          // code would overwrite the reason an operator is reading, and a
          // repeat of the same one would append a second event for a transition
          // that happened once.
          const stored = await tx.generationDeliverableComposition.findUniqueOrThrow({
            where: { deliverableVersionId: input.claim.deliverableVersionId },
            select: { blockCode: true },
          });
          if (stored.blockCode !== input.blockCode) {
            throw new DeliverableCompositionExecutionDefect("COMPOSITION_BLOCK_CONFLICT");
          }
          return { kind: "ALREADY_BLOCKED" };
        }

        const blocked = await tx.generationDeliverableComposition.updateMany({
          where: {
            id: input.claim.compositionId,
            status: "RUNNING",
            version: input.claim.version,
            leaseToken: input.claim.leaseToken,
          },
          data: {
            status: "BLOCKED",
            leaseToken: null,
            leaseExpiresAt: null,
            // Cleared, not merely left alone: a BLOCKED row carrying an instant
            // at which it becomes due is exactly the automatic retry this state
            // exists to stop, and the status shape constraint refuses it.
            nextAttemptAt: null,
            blockCode: input.blockCode,
            blockedAt: new Date(input.blockedAt),
            version: input.claim.version + 1,
          },
        });
        if (blocked.count !== 1) return { kind: "LEASE_LOST" };

        // The deliverable aggregate records that automatic composition stopped.
        // The job is deliberately left COMPOSING with no job event: nothing
        // about the job changed, no unit is consumed, no reservation is
        // released, and terminalizing it would destroy a video the customer may
        // already hold.
        await appendGenerationEvent(tx, {
          organizationId: ctx.organizationId,
          aggregateType: "DELIVERABLE",
          aggregateId: ctx.versionId,
          fromState: DELIVERABLE_COMPOSING_STATE,
          toState: DELIVERABLE_COMPOSITION_BLOCKED_STATE,
          context: {
            ...input.context,
            eventType: DELIVERABLE_COMPOSITION_BLOCKED_EVENT_TYPE,
            reasonCode: COMPOSITION_EXECUTION_REASON_CODE,
          },
        });

        await assertPointerUnmoved(tx, ctx);
        return { kind: "BLOCKED" };
      });
    },

    async findCompositionByVersionId(organizationId, deliverableVersionId) {
      const rows = await prisma.$queryRaw<DeliverableCompositionRecord[]>`
        SELECT w."id"                  AS "id",
               w."deliverableVersionId" AS "deliverableVersionId",
               w."status"::text        AS "status",
               w."attemptCount"        AS "attemptCount",
               w."version"             AS "version",
               w."lastRetryCode"::text AS "lastRetryCode",
               w."blockCode"::text     AS "blockCode",
               w."outputStorageKey"    AS "outputStorageKey",
               w."outputSha256"        AS "outputSha256",
               w."outputSizeBytes"     AS "outputSizeBytes"
          FROM "generation_deliverable_compositions" w
          JOIN "generation_deliverable_versions" v ON v."id" = w."deliverableVersionId"
          JOIN "generation_jobs" j ON j."id" = v."generationJobId"
          JOIN "video_projects" p ON p."id" = j."videoProjectId"
         WHERE w."deliverableVersionId" = ${deliverableVersionId}
           AND p."organizationId" = ${organizationId}
      `;
      return rows[0] ?? null;
    },
  };
}

/**
 * Lock the job, the deliverable version and its composition work, in that order.
 *
 * `FOR UPDATE OF j, v, w` names the three rows this transaction writes. The
 * project is joined for tenancy and deliberately not locked. The reservation is
 * neither joined nor locked: composition moves no entitlement.
 *
 * A cross-tenant or unknown id matches no row, locks nothing, and is reported
 * exactly as a missing one — the caller's organization id is never trusted on
 * its own, and nothing discloses that the version exists for someone else.
 */
async function lockClaimChain(
  tx: Tx,
  organizationId: string,
  deliverableVersionId: string,
): Promise<ClaimContextRow | null> {
  const rows = await tx.$queryRaw<ClaimContextRow[]>`
    SELECT p."organizationId"              AS "organizationId",
           j."id"                          AS "jobId",
           j."state"::text                 AS "jobState",
           j."stateVersion"                AS "jobVersion",
           j."currentDeliverableVersionId" AS "currentDeliverableVersionId",
           j."targetOutputResolution"      AS "targetOutputResolution",
           j."targetAspectRatio"           AS "targetAspectRatio",
           j."requestedDurationSeconds"    AS "requestedDurationSeconds",
           v."id"                          AS "versionId",
           v."ordinal"                     AS "versionOrdinal",
           w."id"                          AS "workId",
           w."status"::text                AS "workStatus",
           w."version"                     AS "workVersion",
           w."leaseExpiresAt"              AS "workLeaseExpiresAt",
           w."nextAttemptAt"               AS "workNextAttemptAt",
           w."attemptCount"                AS "workAttemptCount",
           w."profileKey"                  AS "workProfileKey",
           w."targetWidthPx"               AS "workWidth",
           w."targetHeightPx"              AS "workHeight",
           w."frameRateNumerator"          AS "workFpsNum",
           w."frameRateDenominator"        AS "workFpsDen",
           w."videoCodec"                  AS "workCodec",
           w."pixelFormat"                 AS "workPixelFormat",
           w."fitMode"                     AS "workFitMode",
           w."transitionMode"              AS "workTransitionMode",
           w."audioMode"                   AS "workAudioMode",
           w."encoderPreset"               AS "workPreset",
           w."crf"                         AS "workCrf"
      FROM "generation_deliverable_versions" v
      JOIN "generation_jobs" j ON j."id" = v."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
      LEFT JOIN "generation_deliverable_compositions" w
             ON w."deliverableVersionId" = v."id"
     WHERE v."id" = ${deliverableVersionId}
       AND p."organizationId" = ${organizationId}
       FOR UPDATE OF j, v
  `;
  const row = rows[0];
  if (row === undefined) return null;
  // The work row cannot be locked in the statement above: it is the nullable
  // side of an outer join, and PostgreSQL refuses `FOR UPDATE` there. It is
  // locked here instead, after the job and version, keeping the declared order.
  if (row.workId !== null) {
    await tx.$queryRaw`
      SELECT "id" FROM "generation_deliverable_compositions"
       WHERE "id" = ${row.workId} FOR UPDATE
    `;
  }
  return row;
}

/** The frozen plan, joined to the immutable facts each input names. */
async function readPlanInputs(tx: Tx, deliverableVersionId: string): Promise<PlanInputRow[]> {
  return tx.$queryRaw<PlanInputRow[]>`
    SELECT i."position"                 AS "position",
           i."generationSceneId"        AS "generationSceneId",
           i."sceneGenerationAttemptId" AS "sceneGenerationAttemptId",
           i."mediaValidationId"        AS "mediaValidationId",
           i."sourceSha256"             AS "sourceSha256",
           i."sourceSizeBytes"          AS "sourceSizeBytes",
           s."snapshotDurationSeconds"  AS "snapshotDurationSeconds",
           a."outputSha256"             AS "attemptOutputSha256",
           a."outputSizeBytes"          AS "attemptOutputSizeBytes",
           mv."status"::text            AS "validationStatus",
           mv."receiptSha256"           AS "validationReceiptSha256",
           mv."receiptSizeBytes"        AS "validationReceiptSizeBytes"
      FROM "generation_deliverable_inputs" i
      JOIN "generation_scenes" s ON s."id" = i."generationSceneId"
      JOIN "scene_generations" a ON a."id" = i."sceneGenerationAttemptId"
      JOIN "managed_output_media_validations" mv ON mv."id" = i."mediaValidationId"
     WHERE i."deliverableVersionId" = ${deliverableVersionId}
     ORDER BY i."position" ASC
  `;
}

/**
 * The version being claimed must be the plan of *this* pending cycle.
 *
 * Phase 5A's replay rules, reused verbatim rather than re-derived: an initial
 * cycle's plan is ordinal 1, and a recomposition's is exactly one after the
 * version the customer currently holds. Executing any other version would
 * compose a deliverable nobody planned for this cycle — and for a recomposition
 * the wrong answer is the customer's *existing* video.
 */
function assertPendingCycleVersion(ctx: ClaimContextRow): void {
  if (ctx.currentDeliverableVersionId === null) {
    if (ctx.versionOrdinal !== 1) {
      throw new DeliverableCompositionExecutionDefect("PLAN_NOT_EXECUTABLE");
    }
    return;
  }
  if (ctx.versionId === ctx.currentDeliverableVersionId) {
    throw new DeliverableCompositionExecutionDefect("PLAN_NOT_EXECUTABLE");
  }
}

/**
 * Prove the frozen plan still agrees with the durable rows it names.
 *
 * This is **not** Phase 5A's selection algorithm run again. Nothing here reads
 * `GenerationScene.currentDeliveredRequestId`, `MAX(attemptOrdinal)` or any
 * "latest" rule: the plan is authority, and the rows are checked only for
 * *agreement* with what it already froze. The one live fact used is the scene's
 * immutable `snapshotDurationSeconds`, reached through the scene id the plan
 * itself names.
 *
 * A disagreement is a defect rather than a repair. Re-selecting a different
 * attempt would compose bytes the plan never approved.
 */
function proveExecutablePlan(
  ctx: ClaimContextRow,
  rows: readonly PlanInputRow[],
): readonly CompositionSceneInput[] {
  const scenes: CompositionSceneInput[] = [];

  for (const row of rows) {
    if (
      row.attemptOutputSha256 !== row.sourceSha256 ||
      row.attemptOutputSizeBytes === null ||
      row.attemptOutputSizeBytes !== row.sourceSizeBytes ||
      row.validationStatus !== "VALID" ||
      row.validationReceiptSha256 !== row.sourceSha256 ||
      row.validationReceiptSizeBytes === null ||
      row.validationReceiptSizeBytes !== row.sourceSizeBytes
    ) {
      throw new DeliverableCompositionExecutionDefect("PLAN_SOURCE_DISAGREEMENT");
    }
    if (row.snapshotDurationSeconds <= 0) {
      throw new DeliverableCompositionExecutionDefect("PLAN_SOURCE_DISAGREEMENT");
    }
    scenes.push({
      position: row.position,
      generationSceneId: row.generationSceneId,
      sceneGenerationAttemptId: row.sceneGenerationAttemptId,
      sourceStorageKey: managedGenerationOutputKey({
        organizationId: ctx.organizationId,
        attemptId: row.sceneGenerationAttemptId,
      }),
      sourceSha256: sha256Digest(row.sourceSha256),
      sourceSizeBytes: safePositiveByteCount(Number(row.sourceSizeBytes)),
      durationSeconds: row.snapshotDurationSeconds,
    });
  }

  // The duration invariant is deliberately **not** checked here. A frozen scene
  // total that disagrees with the job's admitted length is a deterministic
  // refusal, and a defect thrown inside this transaction would roll the claim
  // back and leave the deliverable to be rediscovered and re-refused forever.
  // The caller proves it against the returned claim and blocks the row.
  return scenes;
}

/**
 * The profile this deliverable was first claimed under, read back verbatim.
 *
 * Never re-derived from today's defaults. A build carrying profile v2 that
 * re-derived here would encode the retry of a v1 deliverable with v2 settings,
 * and the two halves of one deliverable's history would disagree about what the
 * customer was promised.
 */
function persistedProfile(ctx: ClaimContextRow): CompositionProfile {
  return assertRunnableProfile({
    profileKey: ctx.workProfileKey!,
    targetWidthPx: ctx.workWidth!,
    targetHeightPx: ctx.workHeight!,
    frameRateNumerator: ctx.workFpsNum!,
    frameRateDenominator: ctx.workFpsDen!,
    videoCodec: ctx.workCodec!,
    pixelFormat: ctx.workPixelFormat!,
    fitMode: ctx.workFitMode!,
    transitionMode: ctx.workTransitionMode!,
    audioMode: ctx.workAudioMode!,
    encoderPreset: ctx.workPreset!,
    crf: ctx.workCrf!,
  });
}

/** The customer's published deliverable must be exactly where it was. */
async function assertPointerUnmoved(tx: Tx, ctx: ClaimContextRow): Promise<void> {
  const after = await tx.generationJob.findFirst({
    where: { id: ctx.jobId },
    select: { currentDeliverableVersionId: true },
  });
  if (after?.currentDeliverableVersionId !== ctx.currentDeliverableVersionId) {
    throw new DeliverableCompositionExecutionDefect("CURRENT_DELIVERABLE_POINTER_MOVED");
  }
}
