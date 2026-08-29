import type { SceneGeneration as DbSceneGeneration, PrismaClient } from "@prisma/client";
import type {
  ClaimedSceneGeneration,
  ExecutionSourceObservation,
  FailedSceneGeneration,
  PreflightRefusalReason,
  PreparedSourceIdentity,
  SceneGeneration,
  SceneGenerationExecutionRepository,
  SubmissionClaimOutcome,
  SystemGenerationCandidate,
} from "@app/domain";
import {
  assertTransition,
  classifyExecutionSource,
  isMediaAssetStatus,
  preflightFailureStateFor,
  sameSourceIdentity,
} from "@app/domain";
import { AppError } from "@app/shared";
import { toGeneration } from "./generation-repositories";

/**
 * The rows a `VideoProject` join must yield for tenant resolution.
 *
 * `organizationId` is read from the parent, never from the generation row —
 * `scene_generations` has no such column, and adding one was rejected: a
 * duplicated tenant id can disagree with its parent, and the moment it does,
 * one of the two is silently wrong.
 */
type DbSceneGenerationWithProject = DbSceneGeneration & {
  readonly videoProject: { readonly organizationId: string };
};

function toCandidate(row: DbSceneGenerationWithProject): SystemGenerationCandidate {
  return { organizationId: row.videoProject.organizationId, generation: toGeneration(row) };
}

/**
 * Rebuild the mapped row with its state narrowed to one the caller has already
 * proved.
 *
 * `state` is passed separately rather than read back off the row, so the value
 * in the returned object is the one the invariant check above it tested — not a
 * second read that a cast would have to assume still agrees. Nothing is
 * asserted away: `toGeneration` produces the row, and only the field whose value
 * has just been verified is replaced, with the same value.
 */
function inState<S extends SceneGeneration["state"]>(
  row: DbSceneGenerationWithProject,
  state: S,
): Omit<SceneGeneration, "state"> & { readonly state: S } {
  return { ...toGeneration(row), state };
}

const NOT_CLAIMABLE: SubmissionClaimOutcome = { kind: "NOT_CLAIMABLE" };

function sourceInvalid(reason: PreflightRefusalReason): SubmissionClaimOutcome {
  return { kind: "SOURCE_INVALID", reason };
}

/**
 * The columns the locking read asks for, as they actually arrive.
 *
 * Every field is typed as it is *before* validation, which is the point:
 * `$queryRaw` bypasses Prisma's model mapping, so its type parameter is an
 * assertion, not a check. `status` comes back as a plain `string` rather than
 * the generated enum — verified against PostgreSQL, not assumed — and
 * `deletionRequestedAt` as `Date | null` from `TIMESTAMP(3)`. Nothing here may
 * be handed to the domain until {@link toExecutionSourceObservation} has looked
 * at it.
 */
interface RawLockedAssetRow {
  readonly id: unknown;
  readonly organizationId: unknown;
  readonly status: unknown;
  readonly storageKey: unknown;
  readonly mimeType: unknown;
  readonly sha256: unknown;
  readonly deletionRequestedAt: unknown;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableInstant(value: unknown): value is Date | null {
  return value === null || (value instanceof Date && Number.isFinite(value.getTime()));
}

/**
 * Turn one raw locked row into the five-field observation the domain classifies.
 *
 * Validates rather than casts. `raw.status as MediaAssetStatus` would launder an
 * arbitrary database value into `classifyExecutionSource`, where the exhaustive
 * status map would yield `undefined` and fall through every branch — a source of
 * unknown lifecycle treated as though it had been classified.
 *
 * A row that fails these checks is an **invariant failure, not a refusal**. The
 * column set is constrained by the schema, so a value outside it means the
 * database and this process disagree about what `media_assets` contains;
 * reporting that as a `PreflightRefusalReason` would file a system defect as a
 * verdict about the customer's photo, and would durably park their work for it.
 *
 * The thrown error names nothing: no key, digest, MIME type or id. It is raised
 * inside the claim transaction, so the claim rolls back.
 */
function toExecutionSourceObservation(raw: RawLockedAssetRow): ExecutionSourceObservation {
  if (
    typeof raw.id !== "string" ||
    typeof raw.organizationId !== "string" ||
    !isMediaAssetStatus(raw.status) ||
    typeof raw.storageKey !== "string" ||
    !isNullableString(raw.mimeType) ||
    !isNullableString(raw.sha256) ||
    !isNullableInstant(raw.deletionRequestedAt)
  ) {
    throw new AppError("INTERNAL_ERROR", "The locked source asset row could not be read");
  }
  return {
    status: raw.status,
    deletionRequestedAt: raw.deletionRequestedAt,
    storageKey: raw.storageKey,
    mimeType: raw.mimeType,
    sha256: raw.sha256,
  };
}

/**
 * The system-scoped execution boundary, backed by PostgreSQL.
 *
 * **This adapter is trusted, and its trust is bounded by its surface.** It is
 * the only place in the system where a `SceneGeneration` is reachable without
 * naming its organization first, which is exactly why it is three methods long
 * and lives apart from `createPrismaSceneGenerationRepository`. Every method
 * here *resolves* tenant identity and hands it back; none accepts one.
 *
 * Discovery runs without a transaction because it writes nothing. The claim and
 * the preflight-failure park each run inside one, and it is worth being exact
 * about what that buys: **the transaction guarantees only that the method never
 * hands back a row other than the one it moved itself.** It does not make every
 * future writer of this row safe. A writer that starts after that transaction commits
 * is entirely unaffected by it, and `SceneGenerationRepository.update` carries
 * no state predicate — so any future competing transition (cancellation above
 * all) must carry its own expected-state predicate. That requirement is
 * recorded as a hard prerequisite in `docs/decisions/TODO.md`; it is not
 * something this adapter can provide on its behalf.
 */
export function createPrismaSceneGenerationExecutionRepository(
  prisma: PrismaClient,
): SceneGenerationExecutionRepository {
  return {
    async findNextQueuedForPreparation() {
      const row = await prisma.sceneGeneration.findFirst({
        where: { state: "QUEUED" },
        // Oldest first, with `id` breaking ties so two rows written in the same
        // millisecond still order deterministically — the same convention
        // `findLatestSucceededByRequestIdentity` uses, inverted.
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: { videoProject: { select: { organizationId: true } } },
      });
      return row ? toCandidate(row) : null;
    },

    async claimPreparedForSubmission(
      generationId: string,
      sourceIdentity: PreparedSourceIdentity,
    ) {
      // Legality first, and from the domain rather than restated here. This
      // adapter decides *who* gets to make the move; whether `QUEUED →
      // SUBMITTING` is a legal move at all is the state machine's answer, and
      // asking it is what keeps a hard-coded pair in a persistence file from
      // quietly becoming a second state machine.
      assertTransition("QUEUED", "SUBMITTING");

      return prisma.$transaction(async (tx): Promise<SubmissionClaimOutcome> => {
        // --- 1. Non-locking authoritative read -----------------------------
        // Deliberately does not lock `scene_generations`: the frozen order is
        // MediaAsset first, and taking a conflicting generation lock here would
        // invert it. Everything this claim addresses is *resolved* from the row
        // and its parent — the asset id it was admitted against and the owning
        // organization — never accepted from the caller.
        const before = await tx.sceneGeneration.findUnique({
          where: { id: generationId },
          include: { videoProject: { select: { organizationId: true } } },
        });
        if (!before?.videoProject || before.state !== "QUEUED") return NOT_CLAIMABLE;

        const organizationId = before.videoProject.organizationId;
        const { assetId, videoProjectId } = before;

        // --- 2. The serialization barrier -----------------------------------
        // Prisma 5.22 exposes no fluent row lock, so this is the repository's
        // only raw statement, and it stays private to this file: no generic raw
        // helper, no lock helper, no exported transaction primitive.
        //
        // A tagged template, so both values are bound parameters rather than
        // interpolated text. `FOR NO KEY UPDATE` rather than `FOR UPDATE`
        // because the claim must conflict with asset *writers* — `requestDeletion`
        // and every `updateIfCurrent` — while `storyboard_scenes` holds
        // `FOR KEY SHARE` on this same row for referential integrity, and
        // blocking ordinary storyboard composition for the length of a claim
        // buys nothing. Both halves verified against PostgreSQL (ADR-0030).
        const locked = await tx.$queryRaw<RawLockedAssetRow[]>`
          SELECT "id",
                 "organizationId",
                 "status",
                 "storageKey",
                 "mimeType",
                 "sha256",
                 "deletionRequestedAt"
            FROM "media_assets"
           WHERE "id" = ${assetId}
             AND "organizationId" = ${organizationId}
           FOR NO KEY UPDATE
        `;

        // --- 3. Re-read the generation, after the lock wait ------------------
        // Load-bearing, and not redundant with the compare-and-swap below.
        //
        // Acquiring the asset lock can block for as long as another writer holds
        // it, and in that time the generation may be claimed, cancelled or
        // parked by someone else. Without this read, a claimant that waited and
        // then found the source invalid would answer `SOURCE_INVALID` — a stale
        // verdict about the source of work that is no longer anyone's to do.
        // `NOT_CLAIMABLE` is the truthful answer, and it must win.
        //
        // A plain read suffices *because* PostgreSQL runs this at READ
        // COMMITTED: each statement sees the latest committed data, so a
        // transition that committed during the wait is visible here. Under
        // REPEATABLE READ it would not be, and this check would silently stop
        // working — which is why the isolation level is stated rather than
        // assumed (ADR-0030).
        const during = await tx.sceneGeneration.findUnique({
          where: { id: generationId },
          include: { videoProject: { select: { organizationId: true } } },
        });
        if (!during?.videoProject || during.state !== "QUEUED") return NOT_CLAIMABLE;

        // Still `QUEUED`, so the addressing facts this claim already used must
        // still hold. They are immutable by construction — nothing writes
        // `assetId` or `videoProjectId` after admission — so disagreement means
        // the row was altered underneath, and the lock just taken is on the
        // wrong asset. Refusing to validate a source this claim did not lock.
        if (
          during.assetId !== assetId ||
          during.videoProjectId !== videoProjectId ||
          during.videoProject.organizationId !== organizationId
        ) {
          throw new AppError(
            "INTERNAL_ERROR",
            "The generation changed its source or owner during its own claim",
          );
        }

        // --- 4. Only now may a source verdict be returned --------------------
        // Zero rows is indistinguishable from an asset in another organization,
        // and that is the tenant guarantee: `organizationId` is in the `WHERE`,
        // so a foreign row is never loaded and never described.
        if (locked.length === 0) return sourceInvalid("ASSET_NOT_FOUND");
        if (locked.length !== 1) {
          throw new AppError("INTERNAL_ERROR", "The locked source asset row could not be read");
        }

        const classified = classifyExecutionSource(toExecutionSourceObservation(locked[0]!));
        if (classified.kind === "REFUSED") return sourceInvalid(classified.reason);

        // Two independently usable sources, so the only question left is whether
        // they are the *same* one. All three fields, compared exactly — no
        // trimming, no normalization, no re-hashing. `storageKey` and `mimeType`
        // agree across every re-processed JPEG for an asset, so the digest is
        // what actually decides this (ADR-0029).
        if (!sameSourceIdentity(classified.identity, sourceIdentity)) {
          return sourceInvalid("ASSET_SOURCE_CHANGED");
        }

        // --- 5. The compare-and-swap, still holding the asset lock ------------
        // `updateMany` rather than `update`: `update` requires a unique selector
        // and throws when the predicate does not match, turning "someone else
        // won" into an exception. Losing is ordinary, and is reported as
        // `NOT_CLAIMABLE` — never as a source verdict, because the source was
        // fine and something else moved the row.
        //
        // Only `state` is written. `updatedAt` is the database's. Nothing else
        // is touched: a future explicit requeue policy may legitimately return a
        // row to `QUEUED` still carrying diagnostics from an earlier attempt,
        // and silently clearing them here would erase that history.
        const { count } = await tx.sceneGeneration.updateMany({
          where: { id: generationId, state: "QUEUED" },
          data: { state: "SUBMITTING" },
        });
        if (count === 0) return NOT_CLAIMABLE;

        // --- 6. Past here a licence was won, so nothing may be reported lost --
        // `NOT_CLAIMABLE` has exactly one meaning to a caller: *you did not win*.
        // The database has just said the opposite. Reporting an invariant
        // failure as a lost race would leave a row in `SUBMITTING` that every
        // worker believes belongs to someone else — stalled work no alarm fires
        // for. Throwing inside the transaction rolls the claim back instead, so
        // the row returns to `QUEUED` and stays discoverable.
        const after = await tx.sceneGeneration.findUnique({
          where: { id: generationId },
          include: { videoProject: { select: { organizationId: true } } },
        });
        if (!after) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Claimed scene generation disappeared within its own claim transaction",
            { details: { generationId } },
          );
        }
        if (after.videoProject === null || after.videoProject === undefined) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Claimed scene generation has no resolvable owning VideoProject",
            { details: { generationId } },
          );
        }
        if (after.state !== "SUBMITTING") {
          throw new AppError(
            "INTERNAL_ERROR",
            "Claimed scene generation was not SUBMITTING after a won claim",
            { details: { generationId, state: after.state } },
          );
        }
        // The licence must name the same source and the same tenant the lock and
        // the validation were performed against. Checked rather than trusted:
        // returning a claim whose asset or organization drifted would be worse
        // than any other failure here, because it is the one nobody would notice.
        if (
          after.assetId !== assetId ||
          after.videoProjectId !== videoProjectId ||
          after.videoProject.organizationId !== organizationId
        ) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Claimed scene generation no longer names the source it was claimed against",
            { details: { generationId } },
          );
        }

        return {
          kind: "CLAIMED",
          claim: {
            organizationId: after.videoProject.organizationId,
            // `SUBMITTING` is not asserted here — it was proved a few lines up,
            // against the row this transaction wrote and locked.
            generation: inState(after, "SUBMITTING"),
          } satisfies ClaimedSceneGeneration,
        };
      });
    },

    async failQueuedPreflight(generationId: string, reason: PreflightRefusalReason) {
      // The target is derived from the refusal, not chosen here and not accepted
      // from a caller. `preflightFailureStateFor` routes the reason through its
      // disposition, so this adapter has no opinion about which refusals are
      // recoverable — restating that opinion in a persistence file is how the
      // durable record starts disagreeing with the domain.
      const target = preflightFailureStateFor(reason);

      // Legality from the domain, exactly as the claim does it. Both new edges
      // are legal only because nothing has been sent yet; asking the state
      // machine rather than assuming is what keeps this file from becoming a
      // second transition table.
      assertTransition("QUEUED", target);

      // Same transaction shape as the claim, for the same reason: `updateMany`
      // returns a count rather than rows, so the parked row must be read back,
      // and outside a transaction that read is a TOCTOU window a legal
      // `QUEUED -> CANCELLED` can commit inside. Within the transaction the
      // `UPDATE` holds the row lock until commit, so the `SELECT` sees this
      // transaction's own write and nothing else's.
      return prisma.$transaction(async (tx) => {
        // The compare-and-swap, competing on the identical predicate the claim
        // uses. That shared predicate is the whole safety argument for R1: two
        // writers, one row, one `state = 'QUEUED'` — the database picks one, and
        // a preflight failure can therefore never overwrite a row that has
        // already been claimed and may already have been paid for.
        //
        // `normalizedErrorMessage: null` is written **explicitly**, not omitted.
        // Omitting it would leave whatever message the column already held, and
        // a future explicit requeue policy can bring a row back to `QUEUED` with
        // a message from an earlier failure still on it. The durable code would
        // then describe this refusal while the durable message described the
        // previous one — a diagnostic that is worse than none, because it reads
        // as authoritative.
        const { count } = await tx.sceneGeneration.updateMany({
          where: { id: generationId, state: "QUEUED" },
          data: { state: target, normalizedErrorCode: reason, normalizedErrorMessage: null },
        });
        if (count === 0) return null;

        const row = await tx.sceneGeneration.findUnique({
          where: { id: generationId },
          include: { videoProject: { select: { organizationId: true } } },
        });

        // Past here `null` is unavailable, for the reason it is unavailable in
        // the claim: `null` means *this caller did not win*, and the database
        // has just said the opposite. Reporting an invariant failure as a lost
        // race would leave a row parked in a failure state that no caller
        // believes it wrote. Throwing inside the transaction rolls the write
        // back, so the row stays `QUEUED` and stays discoverable — which is the
        // safe direction here precisely because nothing was submitted.
        if (!row) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Failed scene generation disappeared within its own preflight-failure transaction",
            { details: { generationId } },
          );
        }
        if (row.videoProject === null || row.videoProject === undefined) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Failed scene generation has no resolvable owning VideoProject",
            { details: { generationId } },
          );
        }
        if (row.state !== target) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Scene generation was not in its derived failure state after a won preflight failure",
            { details: { generationId, state: row.state, expected: target } },
          );
        }
        // The diagnostics are checked, not assumed, because they are the whole
        // product of this method: a parked row whose code did not persist is
        // indistinguishable from one parked for some other reason entirely.
        if (row.normalizedErrorCode !== reason) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Scene generation did not carry its refusal reason after a won preflight failure",
            { details: { generationId, reason } },
          );
        }
        if (row.normalizedErrorMessage !== null) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Scene generation retained a stale diagnostic message after a won preflight failure",
            { details: { generationId } },
          );
        }
        return {
          organizationId: row.videoProject.organizationId,
          // Likewise `target`: the check above compared it against the row, so
          // this narrows to a value already verified rather than a claim.
          generation: inState(row, target),
        } satisfies FailedSceneGeneration;
      });
    },
  };
}
