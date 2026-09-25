/**
 * Transaction I — atomic deliverable composition admission.
 *
 * One repository operation owns the whole business fact: the locks, the
 * authority re-reads, the per-Scene proofs, the deliverable version, every
 * frozen input row, the Job advance and every transition event. Splitting it
 * would re-create the crash boundary it exists to remove — a version with no
 * inputs, an input set no Job ever moved for, or a Job awaiting composition with
 * nothing to compose.
 *
 * ## Lock order
 *
 * ```text
 * GenerationJob
 *   → GenerationScenes (position ASC, id ASC)
 *     → selected SceneGenerationRequests
 *       → selected latest SceneGenerations
 *         → their ManagedOutputMediaValidations
 * ```
 *
 * The same Job-first order Transaction F, the recovery admission and
 * Transaction H take, so none of them can close a deadlock cycle with this one.
 * The **Job** lock is what makes the decision safe: two workers admitting a plan
 * for one `SCENES_READY` Job serialize there, and the loser re-reads a Job that
 * is already `COMPOSITION_PENDING` and answers `ALREADY_PLANNED`. It is also
 * what makes the plan non-stale — a revision start takes the same Job lock, so
 * it cannot move a Scene's delivered pointer underneath a plan being frozen.
 *
 * The reservation is joined as **evidence** and deliberately not locked: this
 * transaction proves which composition cycle it is in and then leaves the hold
 * entirely alone. There is no cost-admission advisory lock either — planning
 * authorizes no provider call and moves no quota.
 *
 * ## No external I/O
 *
 * Database work only. No object-store read, no `ffprobe`, no `ffmpeg`, no HTTP
 * and no temporary file is reachable from inside the transaction.
 */

import {
  COMPOSITION_PLAN_REASON_CODE,
  DELIVERABLE_PLANNED_EVENT_TYPE,
  DELIVERABLE_PLANNED_STATE,
  DeliverableCompositionDefect,
  FIRST_DELIVERABLE_ORDINAL,
  JOB_COMPOSITION_PENDING_EVENT_TYPE,
  computeDeliverableInputFingerprint,
  type AdmitCompositionPlanInput,
  type AdmitCompositionPlanOutcome,
  type DeliverableCompositionPlanRepository,
  type DeliverableInputFingerprintScene,
} from "@app/domain";
import { randomId } from "@app/shared";
import type { PrismaClient } from "@prisma/client";
import { appendGenerationEvent } from "./orchestration-repositories";

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

const INPUT_ID_PREFIX = "gdvin";

/** The Job's own facts, read under its lock. */
interface JobContextRow {
  readonly organizationId: string;
  readonly jobId: string;
  readonly jobState: string;
  readonly jobVersion: number;
  readonly currentDeliverableVersionId: string | null;
  readonly targetOutputResolution: string;
  readonly targetAspectRatio: string;
  readonly requestedDurationSeconds: number;
  readonly reservationState: string | null;
}

/**
 * One Scene's complete candidacy, read once under the locks.
 *
 * Every column a per-Scene proof needs, in one row per Scene, so the values
 * cannot disagree with each other and tenancy is proved in the same predicate
 * that finds them.
 */
interface SceneInputRow {
  readonly sceneId: string;
  readonly position: number;
  readonly sceneState: string;
  readonly currentDeliveredRequestId: string | null;
  // --- the selected request, joined through the same-Scene composite key ---
  readonly requestId: string | null;
  readonly requestState: string | null;
  // --- its latest attempt, by ordinal ---
  readonly attemptId: string | null;
  readonly attemptOrdinal: number | null;
  readonly maxAttemptOrdinal: number | null;
  readonly orchestrationState: string | null;
  readonly outputSha256: string | null;
  readonly outputSizeBytes: bigint | null;
  // --- the media verdict about those bytes ---
  readonly validationId: string | null;
  readonly validationStatus: string | null;
  readonly validationValidatedAt: Date | null;
  readonly receiptSha256: string | null;
  readonly receiptSizeBytes: bigint | null;
}

export function createDeliverableCompositionPlanRepository(
  prisma: PrismaClient,
): DeliverableCompositionPlanRepository {
  return {
    async admitCompositionPlan(input: AdmitCompositionPlanInput) {
      return prisma.$transaction(async (tx): Promise<AdmitCompositionPlanOutcome> => {
        // ---- 1. The entitlement and Job locks, held for the whole transaction.
        // **Reservation first, then Job.** That is the order Transaction H
        // takes, measured against the real settlement path, and taking them the
        // other way round closes a deadlock cycle — see
        // `lockReservationForComposition` below.
        //
        // The reservation's *state* is also composition-admission authority, so
        // it must be locked before it is read and stay locked until this
        // commits. Reading it unlocked was a time-of-check/time-of-use hole: a
        // concurrent release or reconciliation hold could move it after the read
        // and before the plan committed, admitting a deliverable against an
        // entitlement that no longer authorized one.
        const reservationState = await lockReservationForComposition(
          tx,
          input.organizationId,
          input.generationJobId,
        );
        const locked = await lockJobForComposition(
          tx,
          input.organizationId,
          input.generationJobId,
        );
        // Outcome semantics are unchanged by the reordering, and the order of
        // these two classifications is what keeps them so: an unknown or
        // cross-tenant job is `NOT_FOUND`, and only a job this tenant really
        // owns can go on to be refused for its entitlement. A missing
        // reservation falls through to the cycle check below, which admits
        // neither shape and answers `NOT_ELIGIBLE`.
        if (locked === null) return { kind: "NOT_FOUND" };
        const job: JobContextRow = { ...locked, reservationState };

        // ---- 2. Idempotent replay, before anything is judged ineligible. -
        // A Job already `COMPOSITION_PENDING` was planned by someone, and the
        // only honest answers are "here is that plan" or "the plan behind this
        // claim is broken". Re-deriving would create a second version for one
        // cycle.
        if (job.jobState === "COMPOSITION_PENDING") {
          return existingPlan(tx, job);
        }
        if (job.jobState !== "SCENES_READY") return { kind: "NOT_ELIGIBLE" };

        // ---- 3. Which composition cycle is this? ------------------------
        // Two legitimate combinations, and no third. The pointer says whether a
        // deliverable already reached the customer; the hold says whether the
        // entitlement behind it was spent. A Job with no deliverable and a
        // CONSUMED hold has been charged for something nobody received; a Job
        // with a deliverable and a RESERVED hold delivered something nobody was
        // charged for. Both fail closed, as do RESERVING, RECONCILIATION_HOLD,
        // RELEASED and a missing reservation.
        const initial =
          job.currentDeliverableVersionId === null && job.reservationState === "RESERVED";
        const recomposition =
          job.currentDeliverableVersionId !== null && job.reservationState === "CONSUMED";
        if (!initial && !recomposition) return { kind: "NOT_ELIGIBLE" };

        // ---- 4. Lock and read every Scene, in deterministic order. ------
        await lockSceneChain(tx, input.generationJobId);
        const scenes = await readSceneInputs(tx, input.generationJobId);
        // A job with no scenes has nothing to compose and no plan to describe.
        if (scenes.length === 0) return { kind: "NOT_FOUND" };

        // ---- 5. Per-Scene authority. Any failure fails the whole plan. --
        const frozen: DeliverableInputFingerprintScene[] = [];
        for (const scene of scenes) {
          const proved = proveSceneInput(scene);
          if (proved === null) return { kind: "NOT_ELIGIBLE" };
          frozen.push(proved);
        }

        // ---- 6. Freeze the identity. ------------------------------------
        const inputFingerprint = computeDeliverableInputFingerprint(
          {
            targetOutputResolution: job.targetOutputResolution,
            targetAspectRatio: job.targetAspectRatio,
            requestedDurationSeconds: job.requestedDurationSeconds,
          },
          frozen,
        );

        // ---- 7. The ordinal, derived under the Job lock. ----------------
        // `MAX + 1`, never caller-supplied. The unique index on
        // `(generationJobId, ordinal)` remains the database's own defence
        // against any writer that never took this lock.
        const highest = await tx.generationDeliverableVersion.aggregate({
          where: { generationJobId: job.jobId },
          _max: { ordinal: true },
        });
        const ordinal = (highest._max.ordinal ?? FIRST_DELIVERABLE_ORDINAL - 1) + 1;

        // ---- 8. The writes. All of them, or none. -----------------------
        await tx.generationDeliverableVersion.create({
          data: {
            id: input.deliverableVersionId,
            generationJobId: job.jobId,
            ordinal,
            inputFingerprint,
          },
        });
        await tx.generationDeliverableInput.createMany({
          data: frozen.map((scene) => ({
            id: randomId(INPUT_ID_PREFIX),
            deliverableVersionId: input.deliverableVersionId,
            position: scene.position,
            generationSceneId: scene.generationSceneId,
            sceneGenerationRequestId: scene.sceneGenerationRequestId,
            sceneGenerationAttemptId: scene.sceneGenerationAttemptId,
            mediaValidationId: scene.mediaValidationId,
            sourceSha256: scene.sourceSha256,
            sourceSizeBytes: scene.sourceSizeBytes,
          })),
        });

        // One vocabulary for both events. The reason code is this transaction's,
        // not the caller's: every row written here was written because a frozen
        // set of validated scene bytes proved itself, and a caller-supplied
        // reason would let two different causes share a code.
        const event = (eventType: string) => ({
          ...input.context,
          eventType,
          reasonCode: COMPOSITION_PLAN_REASON_CODE,
        });

        await appendGenerationEvent(tx, {
          organizationId: job.organizationId,
          aggregateType: "DELIVERABLE",
          aggregateId: input.deliverableVersionId,
          fromState: null,
          toState: DELIVERABLE_PLANNED_STATE,
          context: event(DELIVERABLE_PLANNED_EVENT_TYPE),
        });

        const moved = await tx.generationJob.updateMany({
          where: {
            id: job.jobId,
            state: "SCENES_READY",
            stateVersion: job.jobVersion,
          },
          data: { state: "COMPOSITION_PENDING", stateVersion: job.jobVersion + 1 },
        });
        // Not an outcome: the version and its inputs are already written in this
        // transaction, and returning would *commit* them with the Job left
        // behind. Under the Job lock taken in step 1 this cannot happen; if it
        // ever did, the only safe answer is to roll the whole thing back.
        if (moved.count !== 1) throw new DeliverableCompositionDefect("PARTIAL_PLAN_STATE");

        await appendGenerationEvent(tx, {
          organizationId: job.organizationId,
          aggregateType: "JOB",
          aggregateId: job.jobId,
          fromState: "SCENES_READY",
          toState: "COMPOSITION_PENDING",
          context: event(JOB_COMPOSITION_PENDING_EVENT_TYPE),
        });

        // ---- 9. The customer keeps the video they already have. ---------
        // Planning creates the next version; it never publishes it. Proved
        // rather than asserted, because "we do not write that column here" is
        // not a control — the re-read is.
        const after = await tx.generationJob.findFirst({
          where: { id: job.jobId },
          select: { currentDeliverableVersionId: true },
        });
        if (after?.currentDeliverableVersionId !== job.currentDeliverableVersionId) {
          throw new DeliverableCompositionDefect("CURRENT_DELIVERABLE_POINTER_MOVED");
        }

        return { kind: "PLANNED", deliverableVersionId: input.deliverableVersionId, ordinal, inputFingerprint };
      });
    },
  };
}

/**
 * The plan behind an existing `COMPOSITION_PENDING` claim, or a defect.
 *
 * "Exactly one latest version whose frozen inputs represent the current planned
 * cycle" is checked as three facts: a version exists, it holds one input per
 * Scene of this Job and no others, and its recorded fingerprint recomputes from
 * its own stored rows under this Job's frozen target.
 *
 * Self-consistency rather than re-derivation from live Scene rows, deliberately.
 * A `COMPOSITION_PENDING` Job cannot have its Scenes moved — revision start
 * requires `DELIVERABLE_READY` — so the two are equivalent today, and the local
 * check is the one that stays meaningful if that ever stops being true: it asks
 * whether the stored plan is a plan, not whether the world still agrees with it.
 */
async function existingPlan(
  tx: Tx,
  job: JobContextRow,
): Promise<AdmitCompositionPlanOutcome> {
  const version = await tx.generationDeliverableVersion.findFirst({
    where: { generationJobId: job.jobId },
    orderBy: { ordinal: "desc" },
    select: { id: true, ordinal: true, inputFingerprint: true },
  });
  if (version === null) throw new DeliverableCompositionDefect("PARTIAL_PLAN_STATE");

  // The latest version must be the one planned *for this pending cycle*, not
  // merely the latest one that exists.
  //
  // Without this, a recomposition is misread. Its Job legitimately still points
  // at the previous, still-usable deliverable while the new plan is non-current,
  // so a Job stuck in `COMPOSITION_PENDING` with **no** new version at all finds
  // the customer's *old* version at the top of the ordinal order, proves it
  // self-consistent — it is, it was planned correctly once — and reports
  // `ALREADY_PLANNED` for a deliverable that is not the pending cycle's. That is
  // precisely the partial plan this transaction must fail closed on.
  if (job.currentDeliverableVersionId === null) {
    // Initial cycle: nothing has been published, so the pending plan is the
    // first one.
    if (version.ordinal !== FIRST_DELIVERABLE_ORDINAL) {
      throw new DeliverableCompositionDefect("PARTIAL_PLAN_STATE");
    }
  } else {
    // Recomposition: the pending plan must be a *different*, *later* version
    // than the one the customer currently holds. The composite foreign key
    // already proves the current pointer names a version of this Job, so it is
    // resolved from the database rather than trusted from the caller.
    const current = await tx.generationDeliverableVersion.findFirst({
      where: { id: job.currentDeliverableVersionId, generationJobId: job.jobId },
      select: { id: true, ordinal: true },
    });
    if (current === null) throw new DeliverableCompositionDefect("PARTIAL_PLAN_STATE");
    if (version.id === current.id) {
      throw new DeliverableCompositionDefect("PARTIAL_PLAN_STATE");
    }
    // Exactly one ordinal after the current version. Phase 5A has no
    // failed-composition or retry lifecycle, so a pending cycle produces exactly
    // one new version and any gap is a plan nobody can account for. A later
    // phase that introduces retry history must revisit this deliberately rather
    // than widening it by accident.
    if (version.ordinal !== current.ordinal + 1) {
      throw new DeliverableCompositionDefect("PARTIAL_PLAN_STATE");
    }
  }

  const inputs = await tx.generationDeliverableInput.findMany({
    where: { deliverableVersionId: version.id },
    orderBy: [{ position: "asc" }, { generationSceneId: "asc" }],
    select: {
      position: true,
      generationSceneId: true,
      sceneGenerationRequestId: true,
      sceneGenerationAttemptId: true,
      mediaValidationId: true,
      sourceSha256: true,
      sourceSizeBytes: true,
    },
  });

  const sceneIds = await tx.generationScene.findMany({
    where: { generationJobId: job.jobId },
    select: { id: true },
  });
  const planned = new Set(inputs.map((row) => row.generationSceneId));
  const covered =
    planned.size === inputs.length &&
    planned.size === sceneIds.length &&
    sceneIds.every((scene) => planned.has(scene.id));
  if (!covered) throw new DeliverableCompositionDefect("PARTIAL_PLAN_STATE");

  const recomputed = computeDeliverableInputFingerprint(
    {
      targetOutputResolution: job.targetOutputResolution,
      targetAspectRatio: job.targetAspectRatio,
      requestedDurationSeconds: job.requestedDurationSeconds,
    },
    inputs.map((row) => ({
      position: row.position,
      generationSceneId: row.generationSceneId,
      sceneGenerationRequestId: row.sceneGenerationRequestId,
      sceneGenerationAttemptId: row.sceneGenerationAttemptId,
      mediaValidationId: row.mediaValidationId,
      sourceSha256: row.sourceSha256,
      sourceSizeBytes: row.sourceSizeBytes,
    })),
  );
  if (recomputed !== version.inputFingerprint) {
    throw new DeliverableCompositionDefect("PARTIAL_PLAN_STATE");
  }

  return {
    kind: "ALREADY_PLANNED",
    deliverableVersionId: version.id,
    ordinal: version.ordinal,
    inputFingerprint: version.inputFingerprint,
  };
}

/**
 * Everything one Scene must prove to enter a plan, or `null`.
 *
 * `null` is "this Scene cannot be composed right now" and fails the whole
 * admission closed — never "skip this Scene". A deliverable missing a Scene the
 * customer paid for is worse than no deliverable.
 *
 * The receipt mismatch is the one case that throws instead. Every other
 * condition here is a state the system legitimately passes through; a media
 * verdict bound to different bytes than the attempt it describes is not, and
 * delivering around it would be composing bytes nobody validated.
 */
function proveSceneInput(row: SceneInputRow): DeliverableInputFingerprintScene | null {
  // The Scene itself.
  if (row.sceneState !== "READY") return null;
  // The pointer *is* the authority. Not "the newest request", not "the highest
  // regeneration ordinal", not "the newest successful request" — those all guess
  // at what the customer currently holds, and a rolled-back regeneration is
  // exactly the case where the guess is wrong.
  if (row.currentDeliveredRequestId === null) return null;
  // Null here means the same-Scene composite join found nothing: the pointer
  // names a request of another Scene, which the foreign key already makes
  // impossible, or no request at all.
  if (row.requestId === null || row.requestState !== "DELIVERED") return null;

  // The latest attempt, by durable ordinal. `createdAt` is never used: two
  // attempts admitted in the same millisecond have no order, and the ordinal
  // does.
  if (
    row.attemptId === null ||
    row.attemptOrdinal === null ||
    row.maxAttemptOrdinal === null ||
    row.attemptOrdinal !== row.maxAttemptOrdinal
  ) {
    return null;
  }
  if (row.orchestrationState !== "OUTPUT_VERIFIED") return null;

  // The media verdict. One durable VALID row, and nothing else: no
  // INVALID_MEDIA, no INTEGRITY_MISMATCH, no PENDING or RUNNING.
  if (
    row.validationId === null ||
    row.validationStatus !== "VALID" ||
    row.validationValidatedAt === null
  ) {
    return null;
  }

  // Exact receipt binding: the verdict must be about *these* bytes.
  if (
    row.outputSha256 === null ||
    row.outputSizeBytes === null ||
    row.receiptSha256 !== row.outputSha256 ||
    row.receiptSizeBytes === null ||
    row.receiptSizeBytes !== row.outputSizeBytes
  ) {
    throw new DeliverableCompositionDefect("SOURCE_RECEIPT_BINDING_CONFLICT");
  }

  return {
    position: row.position,
    generationSceneId: row.sceneId,
    sceneGenerationRequestId: row.requestId,
    sceneGenerationAttemptId: row.attemptId,
    mediaValidationId: row.validationId,
    sourceSha256: row.outputSha256,
    sourceSizeBytes: row.outputSizeBytes,
  };
}

/**
 * Lock the Job and read its frozen delivery target, proving tenancy as it goes.
 *
 * `FOR UPDATE OF j` names the Job alias alone; the project is joined for
 * ownership and deliberately not locked.
 *
 * The reservation is **not joined here at all**, and its state is not among the
 * columns returned. That is the point: the only read of `res."state"` in this
 * file is the one that holds the reservation's row lock, so there is no unlocked
 * value for a later edit to start trusting by accident. A cross-tenant or
 * unknown id matches no row, locks nothing, and is reported as not found.
 */
async function lockJobForComposition(
  tx: Tx,
  organizationId: string,
  generationJobId: string,
): Promise<Omit<JobContextRow, "reservationState"> | null> {
  const rows = await tx.$queryRaw<Omit<JobContextRow, "reservationState">[]>`
    SELECT p."organizationId"              AS "organizationId",
           j."id"                          AS "jobId",
           j."state"::text                 AS "jobState",
           j."stateVersion"                AS "jobVersion",
           j."currentDeliverableVersionId" AS "currentDeliverableVersionId",
           j."targetOutputResolution"      AS "targetOutputResolution",
           j."targetAspectRatio"           AS "targetAspectRatio",
           j."requestedDurationSeconds"    AS "requestedDurationSeconds"
      FROM "generation_jobs" j
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
     WHERE j."id" = ${generationJobId}
       AND p."organizationId" = ${organizationId}
       FOR UPDATE OF j
  `;
  return rows[0] ?? null;
}

/**
 * Lock the entitlement hold and read the state this transaction will act on.
 *
 * The reservation's state is **composition-admission authority**: it is what
 * separates an initial composition from a recomposition, and what refuses a
 * released or reconciling hold. Reading it without the row lock was a
 * time-of-check/time-of-use hole — a concurrent release or reconciliation hold
 * could move it after the read and before the plan committed, admitting a
 * deliverable against an entitlement that no longer authorized one.
 *
 * ## Why before the Job
 *
 * Transaction H is the only other operation that locks both of these rows, and
 * it takes the **reservation first**. That was established against the real
 * `settleExhaustedMediaFailure` path, not by reading the query:
 *
 * ```text
 * hold the reservation row -> settlement blocks on it, and a third session can
 *                             still acquire the Job row       (not held)
 * hold the Job row         -> settlement blocks on it, and a third session is
 *                             REFUSED the reservation row     (held)
 * ```
 *
 * `pg_locks` agrees directly: while blocked on the reservation, the settling
 * backend holds only table-level `RowShareLock`s and no row lock on
 * `generation_jobs`. `lockSettlementChain` filters on `v."id"`, so its plan
 * reaches `generation_reservations` before `generation_jobs` — the aliases
 * listed after `FOR UPDATE OF` do not decide acquisition order, and neither does
 * the `FROM` clause's text order.
 *
 * An earlier version of this comment claimed the opposite, on the strength of a
 * hand-written two-table probe that filtered on `j."id"` and therefore scanned
 * jobs first. That probe measured the substitute, not production. Both orders
 * are now pinned behaviourally, against their real paths, in
 * `tests/integration/media-failure-settlement-races.db.test.ts` and
 * `tests/integration/deliverable-composition-races.db.test.ts`.
 *
 * Taking the Job first here would close a real cycle:
 *
 * ```text
 * Transaction I : holds Job,         waits for Reservation
 * Transaction H : holds Reservation, waits for Job
 * ```
 *
 * Disjoint business states do **not** prevent it. Transaction I requires
 * `SCENES_READY` and settlement acts on a `GENERATING` job, but both take their
 * row locks *before* concluding eligibility — so a Transaction I call that will
 * ultimately return `NOT_ELIGIBLE` still holds whatever it locked while
 * settlement runs.
 *
 * The three cost workflows — paid-submission authorization, reconciliation and
 * submission outcome — lock the reservation and never subsequently lock the Job,
 * so none of them can form the inverse pair in either direction.
 *
 * Locking this row is **not** an entitlement mutation. Transaction I authorizes
 * no paid provider call, moves no exposure, consumes no unit and releases none,
 * and takes no cost-admission advisory lock. The row is locked only because its
 * current state authorizes the composition cycle.
 *
 * A job with no reservation locks nothing and returns `null`, which the caller
 * refuses as `NOT_ELIGIBLE` — a composition cycle with no entitlement behind it
 * is not one of the two legitimate shapes.
 */
async function lockReservationForComposition(
  tx: Tx,
  organizationId: string,
  generationJobId: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<{ reservationState: string }[]>`
    SELECT res."state"::text AS "reservationState"
      FROM "generation_reservations" res
      JOIN "generation_jobs" j ON j."id" = res."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
     WHERE res."generationJobId" = ${generationJobId}
       AND p."organizationId" = ${organizationId}
       FOR UPDATE OF res
  `;
  return rows[0]?.reservationState ?? null;
}

/**
 * Take the Scene, request, attempt and media-verdict locks, in the fixed order.
 *
 * Three statements rather than one, and not by preference: PostgreSQL refuses
 * `FOR UPDATE` on the nullable side of an outer join, and the authoritative read
 * *must* be an outer join so that a Scene with no delivered pointer still
 * appears and is refused by name rather than silently vanishing from the plan.
 * So the locks are taken first, by inner join, and the read follows under them.
 *
 * `position ASC, id ASC` is the plan's order and the lock order at once, so two
 * transactions touching the same Job's Scenes take them in the same sequence.
 * `id` breaks the tie that the unique index on `(generationJobId, position)`
 * already makes impossible — kept because an order that depends on a constraint
 * staying in place is not an order.
 *
 * Scenes are locked unconditionally; requests and their latest attempts are
 * locked only where the delivered pointer resolves, because where it does not
 * there is nothing to lock and the plan is refused anyway. The Job above them is
 * already held by the caller, and that lock alone is what a concurrent revision
 * start collides with — these make the order explicit rather than incidental.
 */
async function lockSceneChain(tx: Tx, generationJobId: string): Promise<void> {
  await tx.$queryRaw<{ id: string }[]>`
    SELECT s."id"
      FROM "generation_scenes" s
     WHERE s."generationJobId" = ${generationJobId}
     ORDER BY s."position" ASC, s."id" ASC
       FOR UPDATE
  `;
  await tx.$queryRaw<{ id: string }[]>`
    SELECT r."id"
      FROM "generation_scenes" s
      JOIN "scene_generation_requests" r
             ON r."id" = s."currentDeliveredRequestId"
            AND r."generationSceneId" = s."id"
      JOIN "scene_generations" a
             ON a."generationSceneRequestId" = r."id"
            AND a."attemptOrdinal" = (
                  SELECT MAX(sib."attemptOrdinal")
                    FROM "scene_generations" sib
                   WHERE sib."generationSceneRequestId" = r."id"
                )
     WHERE s."generationJobId" = ${generationJobId}
     ORDER BY s."position" ASC, s."id" ASC
       FOR UPDATE OF r, a
  `;
  // The media verdicts, last and in the same order. They are authority — the
  // plan freezes a `VALID` status and its receipt — so reading them unlocked
  // left the same time-of-check/time-of-use gap the reservation had. A scene
  // with no verdict yields no row to lock and is refused by the authoritative
  // outer-join read, exactly as before; nothing about the media-validation
  // lifecycle changes here.
  await tx.$queryRaw<{ id: string }[]>`
    SELECT v."id"
      FROM "generation_scenes" s
      JOIN "scene_generation_requests" r
             ON r."id" = s."currentDeliveredRequestId"
            AND r."generationSceneId" = s."id"
      JOIN "scene_generations" a
             ON a."generationSceneRequestId" = r."id"
            AND a."attemptOrdinal" = (
                  SELECT MAX(sib."attemptOrdinal")
                    FROM "scene_generations" sib
                   WHERE sib."generationSceneRequestId" = r."id"
                )
      JOIN "managed_output_media_validations" v ON v."sceneGenerationId" = a."id"
     WHERE s."generationJobId" = ${generationJobId}
     ORDER BY s."position" ASC, s."id" ASC
       FOR UPDATE OF v
  `;
}

/**
 * One authoritative read of every Scene's candidacy, under the locks above.
 *
 * Outer joins throughout, so a Scene missing a delivered pointer, a latest
 * attempt or a media verdict still produces a row with nulls in it. Each null is
 * then refused by name in `proveSceneInput`; an inner join would drop the Scene
 * instead, and a plan assembled from the Scenes that happened to join is exactly
 * the silent omission this transaction exists to prevent.
 */
async function readSceneInputs(tx: Tx, generationJobId: string): Promise<SceneInputRow[]> {
  return tx.$queryRaw<SceneInputRow[]>`
    SELECT s."id"                          AS "sceneId",
           s."position"                    AS "position",
           s."state"::text                 AS "sceneState",
           s."currentDeliveredRequestId"   AS "currentDeliveredRequestId",
           r."id"                          AS "requestId",
           r."state"::text                 AS "requestState",
           a."id"                          AS "attemptId",
           a."attemptOrdinal"              AS "attemptOrdinal",
           a."orchestrationState"::text    AS "orchestrationState",
           a."outputSha256"                AS "outputSha256",
           a."outputSizeBytes"             AS "outputSizeBytes",
           v."id"                          AS "validationId",
           v."status"::text                AS "validationStatus",
           v."validatedAt"                 AS "validationValidatedAt",
           v."receiptSha256"               AS "receiptSha256",
           v."receiptSizeBytes"            AS "receiptSizeBytes",
           (SELECT MAX(sib."attemptOrdinal")
              FROM "scene_generations" sib
             WHERE sib."generationSceneRequestId" = r."id") AS "maxAttemptOrdinal"
      FROM "generation_scenes" s
      LEFT JOIN "scene_generation_requests" r
             ON r."id" = s."currentDeliveredRequestId"
            AND r."generationSceneId" = s."id"
      LEFT JOIN "scene_generations" a
             ON a."generationSceneRequestId" = r."id"
            AND a."attemptOrdinal" = (
                  SELECT MAX(sib2."attemptOrdinal")
                    FROM "scene_generations" sib2
                   WHERE sib2."generationSceneRequestId" = r."id"
                )
      LEFT JOIN "managed_output_media_validations" v ON v."sceneGenerationId" = a."id"
     WHERE s."generationJobId" = ${generationJobId}
     ORDER BY s."position" ASC, s."id" ASC
  `;
}
