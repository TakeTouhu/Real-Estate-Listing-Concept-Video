/**
 * The durable media-validation lifecycle repository.
 *
 * Database work only. Every method opens and closes its own short transaction,
 * and none of them accepts a callback — so there is no shape in which an S3
 * GET, a stream materialization, a temp-file write or an `ffprobe` invocation
 * can happen while a transaction is open. The lifecycle runner sequences
 * `claim` → validator → `finalize`, and the port's shape is what makes that the
 * only possible sequence.
 *
 * ## Three things guard every write after a claim
 *
 * ```text
 * version        the row has not moved since the claim
 * leaseToken     this worker, not a worker that reclaimed it
 * receipt        still the same bytes the claim was established against
 * ```
 *
 * All three are in the `WHERE` clause, so a stale worker's late finalize
 * matches zero rows rather than overwriting the worker that reclaimed it. A
 * zero-row write is reported as `LOST`, which is a correct outcome and not an
 * error.
 */

import { randomUUID } from "node:crypto";
import { AppError } from "@app/shared";
import {
  isSafePositiveByteCount,
  isSha256Digest,
  isManagedOutputContainerFamily,
  isManagedOutputMediaInvalidReason,
  managedGenerationOutputKey,
  validateMediaValidationBatchLimit,
  type DurableMediaValidationRecord,
  type ManagedGenerationOutputKey,
  type ManagedOutputMediaFacts,
  type ManagedOutputVerificationReceipt,
  type MediaValidationCandidate,
  type MediaValidationClaim,
  type MediaValidationClaimOutcome,
  type MediaValidationLifecycleRepository,
  type MediaValidationWriteOutcome,
} from "@app/domain";
import type { PrismaClient } from "@prisma/client";

/** The largest value the columns and the domain both admit. */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Narrow a persisted integer, or refuse to.
 *
 * `Number(someBigint)` is lossy above 2^53-1 and silent about it: a stored
 * 9007199254740993 comes back as ...992 and would validate cleanly, so a value
 * that was never written would be read as a durable fact. CHECK constraints
 * make such a row impossible; this makes *reading* one impossible too, because
 * a constraint added by a migration is not evidence about a database that
 * migration has not reached.
 *
 * `INTERNAL_ERROR` rather than a validation failure: no customer input reaches
 * here, so an out-of-range persisted value is a defect or a corrupted row.
 */
function narrowPersisted(value: bigint, allowZero: boolean): number {
  const floor = allowZero ? 0n : 1n;
  if (value < floor || value > MAX_SAFE) {
    throw new AppError(
      "INTERNAL_ERROR",
      "A persisted media-validation value is outside the safe integer range",
    );
  }
  return Number(value);
}

/** Row shape of the candidate sweep. Identifiers only, deliberately. */
interface CandidateRow {
  readonly sceneGenerationId: string;
}

/** What the claim transaction re-reads about the attempt and its record. */
interface ClaimContextRow {
  readonly attemptId: string;
  readonly organizationId: string;
  readonly orchestrationState: string | null;
  readonly outputStorageKey: string | null;
  readonly outputSha256: string | null;
  readonly outputSizeBytes: bigint | null;
  readonly outputVerifiedAt: Date | null;
  readonly validationId: string | null;
  readonly status: string | null;
  readonly receiptSha256: string | null;
  readonly receiptSizeBytes: bigint | null;
  readonly leaseExpiresAt: Date | null;
  readonly nextAttemptAt: Date | null;
  readonly version: number | null;
}

/**
 * Whether the attempt itself is still eligible, judged under the claim's own
 * transaction rather than trusted from the candidate listing.
 */
function eligibleAttempt(row: ClaimContextRow): {
  readonly destinationKey: ManagedGenerationOutputKey;
  readonly receipt: ManagedOutputVerificationReceipt;
} | null {
  if (row.orchestrationState !== "OUTPUT_VERIFIED") return null;
  if (row.outputVerifiedAt === null) return null;
  if (row.outputStorageKey === null) return null;
  if (!isSha256Digest(row.outputSha256)) return null;
  if (row.outputSizeBytes === null) return null;

  let sizeBytes: number;
  try {
    sizeBytes = narrowPersisted(row.outputSizeBytes, false);
  } catch {
    return null;
  }
  if (!isSafePositiveByteCount(sizeBytes)) return null;

  // The key is *derived*, never trusted from the column: a stored key that does
  // not match what this organization and attempt derive to would point the
  // validator at some other object, so a disagreement makes the row ineligible
  // rather than something to validate anyway.
  const derived = managedGenerationOutputKey({
    organizationId: row.organizationId,
    attemptId: row.attemptId,
  });
  if (derived !== row.outputStorageKey) return null;

  return { destinationKey: derived, receipt: { sha256: row.outputSha256, sizeBytes } };
}

export function createMediaValidationLifecycleRepository(
  prisma: PrismaClient,
): MediaValidationLifecycleRepository {
  /** Read one attempt plus its validation row, if any. */
  async function readContext(
    tx: Pick<PrismaClient, "$queryRaw">,
    sceneGenerationId: string,
  ): Promise<ClaimContextRow | null> {
    const rows = await tx.$queryRaw<ClaimContextRow[]>`
      SELECT a."id"                 AS "attemptId",
             p."organizationId"     AS "organizationId",
             a."orchestrationState"::text AS "orchestrationState",
             a."outputStorageKey"   AS "outputStorageKey",
             a."outputSha256"       AS "outputSha256",
             a."outputSizeBytes"    AS "outputSizeBytes",
             a."outputVerifiedAt"   AS "outputVerifiedAt",
             v."id"                 AS "validationId",
             v."status"::text       AS "status",
             v."receiptSha256"      AS "receiptSha256",
             v."receiptSizeBytes"   AS "receiptSizeBytes",
             v."leaseExpiresAt"     AS "leaseExpiresAt",
             v."nextAttemptAt"      AS "nextAttemptAt",
             v."version"            AS "version"
        FROM "scene_generations" a
        JOIN "video_projects" p ON p."id" = a."videoProjectId"
        LEFT JOIN "managed_output_media_validations" v
               ON v."sceneGenerationId" = a."id"
       WHERE a."id" = ${sceneGenerationId}
       LIMIT 1
    `;
    return rows[0] ?? null;
  }

  return {
    async findCandidates({ now, limit: requested }) {
      // Validated here as well as in the runner, because this method is public:
      // a caller reaching it directly must not be able to put `Infinity`, a
      // fraction or 5000 into a SQL LIMIT. One canonical validator, so the two
      // boundaries cannot disagree about the bound.
      const limit = validateMediaValidationBatchLimit(requested);
      const at = new Date(now);
      // No lock, no transaction, identifiers only. Everything needed to
      // *decide* is deliberately absent, so a caller cannot mistake this for
      // authority: `claim` re-checks every condition under the row's own lock.
      //
      // The LEFT JOIN is what makes historical OUTPUT_VERIFIED attempts
      // discoverable — `v."id" IS NULL` is an eligible state, not a gap.
      const rows = await prisma.$queryRaw<CandidateRow[]>`
        SELECT a."id" AS "sceneGenerationId"
          FROM "scene_generations" a
          LEFT JOIN "managed_output_media_validations" v
                 ON v."sceneGenerationId" = a."id"
         WHERE a."orchestrationState" = 'OUTPUT_VERIFIED'::"GenerationAttemptState"
           AND a."outputStorageKey"  IS NOT NULL
           AND a."outputSha256"      IS NOT NULL
           AND a."outputSizeBytes"   IS NOT NULL
           AND a."outputVerifiedAt"  IS NOT NULL
           AND (
                 v."id" IS NULL
              OR (v."status" = 'PENDING'::"ManagedOutputMediaValidationStatus"
                  AND (v."nextAttemptAt" IS NULL OR v."nextAttemptAt" <= ${at}))
              OR (v."status" = 'RUNNING'::"ManagedOutputMediaValidationStatus"
                  AND v."leaseExpiresAt" IS NOT NULL
                  AND v."leaseExpiresAt" <= ${at})
           )
         ORDER BY a."outputVerifiedAt" ASC, a."id" ASC
         LIMIT ${limit}
      `;
      return rows.map((row): MediaValidationCandidate => ({
        sceneGenerationId: row.sceneGenerationId,
      }));
    },

    async claim({ sceneGenerationId, now, leaseToken, leaseExpiresAt }) {
      if (typeof leaseToken !== "string" || leaseToken.length === 0) {
        throw new AppError("VALIDATION_FAILED", "A media-validation lease token must be non-empty");
      }
      const expires = new Date(leaseExpiresAt);

      // One short transaction. No external I/O is reachable from inside it:
      // this function calls only Prisma.
      return prisma.$transaction(async (tx): Promise<MediaValidationClaimOutcome> => {
        const row = await readContext(tx, sceneGenerationId);
        if (row === null) return { kind: "NOT_ELIGIBLE" };

        const eligible = eligibleAttempt(row);
        if (eligible === null) return { kind: "NOT_ELIGIBLE" };

        // ---- No record yet: the historical-attempt path. -------------------
        if (row.validationId === null) {
          const id = `momv_${randomUUID()}`;
          try {
            const created = await tx.managedOutputMediaValidation.create({
              data: {
                id,
                sceneGenerationId,
                status: "RUNNING",
                receiptSha256: eligible.receipt.sha256,
                receiptSizeBytes: BigInt(eligible.receipt.sizeBytes),
                leaseToken,
                leaseExpiresAt: expires,
                nextAttemptAt: null,
                attemptCount: 1,
                version: 1,
              },
              select: { id: true, version: true },
            });
            return {
              kind: "CLAIMED",
              claim: {
                validationId: created.id,
                sceneGenerationId,
                version: created.version,
                leaseToken,
                destinationKey: eligible.destinationKey,
                expectedReceipt: eligible.receipt,
              },
            };
          } catch (error) {
            // Two workers discovered the same missing row. The unique index let
            // exactly one insert win; the loser re-reads and reports what it
            // found. Bounded — one re-read, no retry loop — and safe, because
            // no provider or storage action has happened yet. The Prisma
            // exception itself never leaves this method.
            if (!isUniqueViolation(error)) throw error;
            const again = await readContext(tx, sceneGenerationId);
            if (again === null || again.status === null) return { kind: "NOT_CLAIMED" };
            return again.status === "PENDING" || again.status === "RUNNING"
              ? { kind: "NOT_CLAIMED" }
              : { kind: "ALREADY_TERMINAL" };
          }
        }

        // ---- A record exists. -----------------------------------------------
        if (row.status === null || row.version === null) return { kind: "NOT_ELIGIBLE" };

        // A terminal verdict is never reopened, whatever it says.
        if (
          row.status === "VALID" ||
          row.status === "INVALID_MEDIA" ||
          row.status === "INTEGRITY_MISMATCH"
        ) {
          return { kind: "ALREADY_TERMINAL" };
        }

        // The frozen receipt must still describe the attempt's durable receipt.
        // A disagreement is an internal consistency defect, not something to
        // repair by overwriting either side: validating new bytes under an old
        // record would silently answer a different question.
        if (
          row.receiptSha256 !== eligible.receipt.sha256 ||
          row.receiptSizeBytes === null ||
          row.receiptSizeBytes !== BigInt(eligible.receipt.sizeBytes)
        ) {
          throw new AppError(
            "INTERNAL_ERROR",
            "A media-validation record is bound to different bytes than the attempt's verified receipt",
          );
        }

        const claimable =
          row.status === "PENDING"
            ? row.nextAttemptAt === null || row.nextAttemptAt.getTime() <= now
            : row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() <= now;
        if (!claimable) return { kind: "NOT_CLAIMED" };

        // The version in the WHERE clause is what makes two workers reclaiming
        // the same expired lease resolve to one winner.
        const nextVersion = row.version + 1;
        const { count } = await tx.managedOutputMediaValidation.updateMany({
          where: {
            id: row.validationId,
            version: row.version,
            status: row.status === "PENDING" ? "PENDING" : "RUNNING",
          },
          data: {
            status: "RUNNING",
            leaseToken,
            leaseExpiresAt: expires,
            nextAttemptAt: null,
            attemptCount: { increment: 1 },
            version: nextVersion,
          },
        });
        if (count !== 1) return { kind: "NOT_CLAIMED" };

        return {
          kind: "CLAIMED",
          claim: {
            validationId: row.validationId,
            sceneGenerationId,
            version: nextVersion,
            leaseToken,
            destinationKey: eligible.destinationKey,
            expectedReceipt: eligible.receipt,
          },
        };
      });
    },

    async finalizeValid({ claim, facts, validatedAt }) {
      assertFacts(facts);
      return write(prisma, claim, {
        status: "VALID",
        container: facts.container,
        durationMs: BigInt(facts.durationMs),
        videoWidth: BigInt(facts.videoWidth),
        videoHeight: BigInt(facts.videoHeight),
        videoStreamCount: BigInt(facts.videoStreamCount),
        audioStreamCount: BigInt(facts.audioStreamCount),
        invalidReason: null,
        validatedAt: new Date(validatedAt),
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      });
    },

    async finalizeInvalidMedia({ claim, reason, validatedAt }) {
      if (!isManagedOutputMediaInvalidReason(reason)) {
        throw new AppError("VALIDATION_FAILED", "Unknown media invalid reason");
      }
      return write(prisma, claim, {
        status: "INVALID_MEDIA",
        invalidReason: reason,
        container: null,
        durationMs: null,
        videoWidth: null,
        videoHeight: null,
        videoStreamCount: null,
        audioStreamCount: null,
        validatedAt: new Date(validatedAt),
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      });
    },

    async finalizeIntegrityMismatch({ claim, validatedAt }) {
      return write(prisma, claim, {
        status: "INTEGRITY_MISMATCH",
        invalidReason: null,
        container: null,
        durationMs: null,
        videoWidth: null,
        videoHeight: null,
        videoStreamCount: null,
        audioStreamCount: null,
        validatedAt: new Date(validatedAt),
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      });
    },

    async releaseToPending({ claim, nextAttemptAt }) {
      // Back to PENDING, never to a terminal state. A transient storage or
      // inspector problem is the absence of a verdict, not a verdict.
      return write(prisma, claim, {
        status: "PENDING",
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(nextAttemptAt),
        invalidReason: null,
        container: null,
        durationMs: null,
        videoWidth: null,
        videoHeight: null,
        videoStreamCount: null,
        audioStreamCount: null,
        validatedAt: null,
      });
    },

    async findBySceneGeneration(sceneGenerationId) {
      const row = await prisma.managedOutputMediaValidation.findUnique({
        where: { sceneGenerationId },
      });
      return row === null ? null : toReadModel(row);
    },
  };
}

/** Every facts field must be present and in range before it is persisted. */
function assertFacts(facts: ManagedOutputMediaFacts): void {
  if (!isManagedOutputContainerFamily(facts.container)) {
    throw new AppError("VALIDATION_FAILED", "Unknown managed output container family");
  }
  const positives = [
    facts.durationMs,
    facts.videoWidth,
    facts.videoHeight,
    facts.videoStreamCount,
  ];
  for (const value of positives) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AppError("VALIDATION_FAILED", "Media facts must be positive safe integers");
    }
  }
  if (!Number.isSafeInteger(facts.audioStreamCount) || facts.audioStreamCount < 0) {
    throw new AppError("VALIDATION_FAILED", "Audio stream count must be a non-negative integer");
  }
}

/**
 * The one guarded write.
 *
 * Every post-claim mutation goes through here so the three guards cannot be
 * forgotten in one branch: the version, the lease token, and the frozen receipt
 * are all in the `WHERE` clause, together with `status: "RUNNING"` so a row
 * that already reached a terminal verdict cannot be overwritten.
 */
async function write(
  prisma: PrismaClient,
  claim: MediaValidationClaim,
  data: Record<string, unknown>,
): Promise<MediaValidationWriteOutcome> {
  const { count } = await prisma.managedOutputMediaValidation.updateMany({
    where: {
      id: claim.validationId,
      version: claim.version,
      leaseToken: claim.leaseToken,
      status: "RUNNING",
      receiptSha256: claim.expectedReceipt.sha256,
      receiptSizeBytes: BigInt(claim.expectedReceipt.sizeBytes),
    },
    // The version advances on every transition, so a worker that already lost
    // cannot win a later race by replaying the same write.
    data: { ...data, version: claim.version + 1 },
  });
  return count === 1 ? { kind: "WRITTEN" } : { kind: "LOST" };
}

/** Whether a thrown value is a Prisma unique-constraint violation. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    return (error as { code?: unknown }).code === "P2002";
  } catch {
    return false;
  }
}

/** Row shape the read model is built from. */
interface PersistedRow {
  readonly status: string;
  readonly receiptSha256: string;
  readonly receiptSizeBytes: bigint;
  readonly attemptCount: number;
  readonly version: number;
  readonly leaseExpiresAt: Date | null;
  readonly nextAttemptAt: Date | null;
  readonly invalidReason: string | null;
  readonly container: string | null;
  readonly durationMs: bigint | null;
  readonly videoWidth: bigint | null;
  readonly videoHeight: bigint | null;
  readonly videoStreamCount: bigint | null;
  readonly audioStreamCount: bigint | null;
  readonly validatedAt: Date | null;
}

/**
 * Build the application-owned read model, or refuse.
 *
 * No Prisma object, Prisma enum, raw `bigint`, provider identifier, provider
 * URL, S3 metadata or inspector output crosses this boundary. Anything the
 * domain cannot represent is a defect rather than a value to coerce.
 */
function toReadModel(row: PersistedRow): DurableMediaValidationRecord {
  if (!isSha256Digest(row.receiptSha256)) {
    throw new AppError("INTERNAL_ERROR", "A persisted media-validation receipt digest is malformed");
  }
  const sizeBytes = narrowPersisted(row.receiptSizeBytes, false);
  if (!isSafePositiveByteCount(sizeBytes)) {
    throw new AppError("INTERNAL_ERROR", "A persisted media-validation receipt size is malformed");
  }
  const receipt = { sha256: row.receiptSha256, sizeBytes };
  const base = { receipt, attemptCount: row.attemptCount, version: row.version };

  switch (row.status) {
    case "PENDING":
      return { status: "PENDING", ...base, nextAttemptAt: row.nextAttemptAt?.getTime() ?? null };
    case "RUNNING": {
      if (row.leaseExpiresAt === null) {
        throw new AppError("INTERNAL_ERROR", "A RUNNING media-validation row has no lease expiry");
      }
      return { status: "RUNNING", ...base, leaseExpiresAt: row.leaseExpiresAt.getTime() };
    }
    case "VALID": {
      if (
        !isManagedOutputContainerFamily(row.container) ||
        row.durationMs === null ||
        row.videoWidth === null ||
        row.videoHeight === null ||
        row.videoStreamCount === null ||
        row.audioStreamCount === null ||
        row.validatedAt === null
      ) {
        throw new AppError("INTERNAL_ERROR", "A VALID media-validation row is missing its facts");
      }
      return {
        status: "VALID",
        ...base,
        facts: {
          container: row.container,
          durationMs: narrowPersisted(row.durationMs, false),
          videoWidth: narrowPersisted(row.videoWidth, false),
          videoHeight: narrowPersisted(row.videoHeight, false),
          videoStreamCount: narrowPersisted(row.videoStreamCount, false),
          audioStreamCount: narrowPersisted(row.audioStreamCount, true),
        },
        validatedAt: row.validatedAt.getTime(),
      };
    }
    case "INVALID_MEDIA": {
      if (!isManagedOutputMediaInvalidReason(row.invalidReason) || row.validatedAt === null) {
        throw new AppError(
          "INTERNAL_ERROR",
          "An INVALID_MEDIA media-validation row is missing its reason",
        );
      }
      return {
        status: "INVALID_MEDIA",
        ...base,
        reason: row.invalidReason,
        validatedAt: row.validatedAt.getTime(),
      };
    }
    case "INTEGRITY_MISMATCH": {
      if (row.validatedAt === null) {
        throw new AppError(
          "INTERNAL_ERROR",
          "An INTEGRITY_MISMATCH media-validation row has no verdict time",
        );
      }
      return { status: "INTEGRITY_MISMATCH", ...base, validatedAt: row.validatedAt.getTime() };
    }
    default:
      throw new AppError("INTERNAL_ERROR", "A persisted media-validation status is unknown");
  }
}
