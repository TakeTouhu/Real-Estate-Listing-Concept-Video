import type { Prisma, PrismaClient } from "@prisma/client";
import {
  ALWAYS_COST_EXPOSED_ATTEMPT_STATES,
  COST_BEARING_SUBMISSION_CERTAINTIES,
  classifyProviderCostExposure,
  convertMicroUsdToYen,
  createProviderPricingCatalog,
  isTargetOutputResolution,
  persistedIntegerToNumber,
  riskProfileKeyForQualityTier,
  validateFxSnapshot,
  verifyPersistedPricingSnapshot,
  yen,
  type ArmResult,
  type AttemptGateFacts,
  type FxSnapshot,
  type GenerationAttemptState,
  type JobGateFacts,
  type PaidSubmissionAuthorizationRepository,
  type PaidSubmissionAuthorizationSession,
  type PaidSubmissionFactsSnapshot,
  type PersistedPricingSnapshotFacts,
  type PricingAuthorizationFailure,
  type PricingGateFacts,
  type ProviderCostExposure,
  type ProviderPricingContract,
  type ReservationGateFacts,
  type SceneGenerationRequestKind,
  type SubmissionCertainty,
  type Yen,
} from "@app/domain";
import { armProviderBoundaryWithin } from "./orchestration-repositories";

/**
 * Persistence for the paid submission authorization gate.
 *
 * Everything one decision reads, and the serialization point that makes two
 * decisions safe, in one place. There is no provider client here and no HTTP:
 * this module reads rows and runs one compare-and-set.
 *
 * It also performs no pricing arithmetic. Amounts are read, range-checked at the
 * `BIGINT` boundary, and handed to the domain's `verifyPersistedPricingSnapshot`,
 * which re-derives the whole snapshot through the same calculation admission
 * used. A repository that recomputed a cost here would become a second pricing
 * authority, and the two would drift.
 */

type Tx = Prisma.TransactionClient;

/**
 * The organization + billing-cycle cost-admission lock.
 *
 * A PostgreSQL transaction-scoped advisory lock, which needs no table and no
 * migration: the correctness property is "two authorizations for one
 * organization and cycle are ordered", and an advisory lock states exactly that
 * without inventing a row to lock. It releases automatically at commit or
 * rollback, so a crashed worker cannot strand an organization.
 *
 * Two 32-bit keys rather than one: `hashtext` over the organization id and over
 * the cycle key. A collision between two organizations would serialize them
 * unnecessarily — a throughput cost, never a correctness one — while the pair
 * makes that vanishingly unlikely anyway.
 *
 * **Lock ordering.** This is the outermost lock in the system. The Phase
 * 4C-3B-2E locks — `scene_generation_requests` (attempt admission),
 * `generation_scenes` (regeneration admission) and `video_projects`
 * (job creation) — are all taken *inside* their own transactions and are never
 * held while this one is acquired, because authorization never admits anything.
 * The one nesting that exists is this lock around `armProviderBoundaryWithin`,
 * which takes no row lock of its own beyond the CAS it performs. There is
 * therefore no cycle: nothing acquires a 2E lock and then waits for this one.
 */
async function acquireCostAdmissionLock(
  tx: Tx,
  organizationId: string,
  billingCycleKey: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${`paid-submission:${organizationId}`}),
      hashtext(${`cycle:${billingCycleKey}`})
    )::text AS locked
  `;
}

/**
 * The cycle an attempt's cost is attributed to.
 *
 * Read from the job's reservation, which froze it when the hold was taken. A
 * cycle derived from "now" would move an in-flight attempt's exposure into a
 * different bucket the moment a month boundary passed.
 */
async function billingCycleKeyForAttempt(
  tx: Tx,
  organizationId: string,
  attemptId: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<{ billingCycleKey: string }[]>`
    SELECT res."billingCycleKey"
      FROM "scene_generations" a
      JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
      JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
      JOIN "generation_jobs" j ON j."id" = s."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
      JOIN "generation_reservations" res ON res."generationJobId" = j."id"
     WHERE a."id" = ${attemptId}
       AND p."organizationId" = ${organizationId}
  `;
  return rows[0]?.billingCycleKey ?? null;
}

/**
 * Hold the entitlement that authorizes this attempt still, for the whole
 * transaction.
 *
 * The cost-admission lock orders two *authorizations* against one cycle. It
 * says nothing about a third party changing the reservation those
 * authorizations depend on, and that leaves a legal and expensive race:
 *
 * ```text
 * T1  lock cycle → read reservation RESERVED → gate permits
 * T2                UPDATE reservation → RELEASED (or RECONCILIATION_HOLD)
 * T2                commit
 * T1  arm QUEUED → SUBMITTING → commit
 * ```
 *
 * The paid boundary is crossed after the hold that authorized it stopped
 * authorizing it. Nothing later can undo that: the provider may already have
 * been paid.
 *
 * `FOR SHARE`, not `FOR UPDATE`. The authorization does not modify the
 * reservation — it must only be sure nobody else does while it decides — and a
 * shared lock blocks every state-changing `UPDATE`/`DELETE` on that row until
 * this transaction commits or rolls back, which is exactly the guarantee
 * needed. Two authorizations against the same reservation are not in conflict
 * with each other; the cost lock already serializes those, and the attempt CAS
 * is the final authority. Taking `FOR UPDATE` would serialize readers against
 * each other for no correctness gain.
 *
 * Tenant-scoped through the whole chain — attempt → request → scene → job →
 * reservation — so the row locked is provably the one belonging to this
 * attempt's job, and a cross-tenant id locks nothing and returns nothing.
 *
 * **Lock ordering.** `cost-admission advisory lock → reservation row lock →
 * attempt CAS`. Every future workflow that mutates reservation state as part of
 * submission reconciliation or entitlement release must take these in the same
 * order.
 */
async function lockReservationForAttempt(
  tx: Tx,
  organizationId: string,
  attemptId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT res."id"
      FROM "scene_generations" a
      JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
      JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
      JOIN "generation_jobs" j ON j."id" = s."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
      JOIN "generation_reservations" res ON res."generationJobId" = j."id"
     WHERE a."id" = ${attemptId}
       AND p."organizationId" = ${organizationId}
       FOR SHARE OF res
  `;
  return rows.length > 0;
}

interface AttemptRow {
  attemptId: string;
  orchestrationState: GenerationAttemptState | null;
  submissionCertainty: string | null;
  stateVersion: number;
  providerName: string;
  providerModelId: string;
  requestModelKey: string | null;
  requestNativeGenerationResolution: string | null;
  requestTargetOutputResolution: string | null;
  requestDurationSeconds: number | null;
  pricingContractKey: string | null;
  requestKind: SceneGenerationRequestKind;
  userRegenerationOrdinal: number | null;
  jobId: string;
  qualityTier: "NORMAL" | "HIGH_QUALITY";
  requiredVideoUnits: number;
  requiredHighQualityUnits: number;
}

/**
 * The authoritative chain, in one tenant-scoped statement.
 *
 * attempt → request → scene → job → project, with the project's organization
 * as the predicate. A cross-tenant id joins nothing and returns no row, which
 * the caller reports identically to a missing one.
 *
 * The parent request's `kind` and `userRegenerationOrdinal` come from here and
 * from nowhere else. They decide whether a `CONSUMED` reservation may stand
 * behind this attempt, which makes them exactly the kind of fact a caller must
 * not be able to assert.
 */
async function loadAttemptChain(
  tx: Tx,
  organizationId: string,
  attemptId: string,
): Promise<AttemptRow | null> {
  const rows = await tx.$queryRaw<AttemptRow[]>`
    SELECT a."id"                                AS "attemptId",
           a."orchestrationState"::text          AS "orchestrationState",
           a."submissionCertainty"::text         AS "submissionCertainty",
           a."stateVersion"                      AS "stateVersion",
           a."providerName"                      AS "providerName",
           a."providerModelId"                   AS "providerModelId",
           a."requestModelKey"                   AS "requestModelKey",
           a."requestNativeGenerationResolution" AS "requestNativeGenerationResolution",
           a."requestTargetOutputResolution"     AS "requestTargetOutputResolution",
           a."requestDurationSeconds"            AS "requestDurationSeconds",
           a."pricingContractKey"                AS "pricingContractKey",
           r."kind"::text                        AS "requestKind",
           r."userRegenerationOrdinal"           AS "userRegenerationOrdinal",
           j."id"                                AS "jobId",
           j."qualityTier"::text                 AS "qualityTier",
           j."requiredVideoUnits"                AS "requiredVideoUnits",
           j."requiredHighQualityUnits"          AS "requiredHighQualityUnits"
      FROM "scene_generations" a
      JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
      JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
      JOIN "generation_jobs" j ON j."id" = s."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
     WHERE a."id" = ${attemptId}
       AND p."organizationId" = ${organizationId}
  `;
  return rows[0] ?? null;
}

/** The complete persisted pricing snapshot, every column the verifier needs. */
interface SnapshotRow {
  id: string;
  sceneGenerationId: string;
  pricingVersion: string;
  provider: string;
  contractKey: string;
  contractFingerprint: string;
  identityJson: Prisma.JsonValue;
  stablePriceReferenceJson: Prisma.JsonValue;
  riskProfileKey: string;
  riskBufferBps: number;
  requestedSeconds: number;
  billableSeconds: number;
  estimatedStableCostMicroUsd: bigint;
  estimatedPlanningCostMicroUsd: bigint;
  pricingEffectiveAtEpochMs: bigint;
  fxSnapshotId: string | null;
}

/**
 * One cost-bearing sibling, with its complete snapshot.
 *
 * The whole snapshot, not just the amount. A sibling's stored planning cost
 * feeds the same Safety Guard equation the candidate's does, so verifying one
 * and trusting the other leaves the equation exactly as forgeable as before —
 * corrupt a `PROCESSING` sibling's cost from ¥5,000 to ¥10 and a candidate with
 * a flawless snapshot authorizes against ¥4,990 of exposure that quietly
 * vanished.
 */
/**
 * One potentially cost-bearing sibling, and its snapshot **if one exists**.
 *
 * Every snapshot column is nullable here, and that is the correction this
 * shape exists for. An inner join would have made the pricing row decide
 * whether the *attempt* is visible at all, so an attempt sitting in
 * `PROCESSING` with `ACCEPTED` and no snapshot vanished from the result set —
 * unclassified, contributing zero, with `exposureVerified` still true. That is
 * a fail-open financial defect in the exact shape the guard exists to catch.
 *
 * Phase 4C-3B-2E requires exactly one snapshot from `SUBMITTING` onward and
 * enforces it transactionally, but it cannot be a cross-table database CHECK.
 * The paid boundary is therefore where its absence has to be detected.
 */
interface ExposureRow {
  orchestrationState: GenerationAttemptState;
  submissionCertainty: SubmissionCertainty | null;
  id: string | null;
  sceneGenerationId: string | null;
  pricingVersion: string | null;
  provider: string | null;
  contractKey: string | null;
  contractFingerprint: string | null;
  identityJson: Prisma.JsonValue | null;
  stablePriceReferenceJson: Prisma.JsonValue | null;
  riskProfileKey: string | null;
  riskBufferBps: number | null;
  requestedSeconds: number | null;
  billableSeconds: number | null;
  estimatedStableCostMicroUsd: bigint | null;
  estimatedPlanningCostMicroUsd: bigint | null;
  pricingEffectiveAtEpochMs: bigint | null;
  fxSnapshotId: string | null;
}

/**
 * The snapshot carried by an exposure row, or `null` when the row has none.
 *
 * Narrowing is all-or-nothing on the columns the verifier needs. A row with
 * some of them present and others missing is not a partially usable snapshot;
 * it is a corrupt one, and it fails closed exactly as an absent one does.
 */
function snapshotOf(row: ExposureRow): SnapshotRow | null {
  if (
    row.id === null ||
    row.sceneGenerationId === null ||
    row.pricingVersion === null ||
    row.provider === null ||
    row.contractKey === null ||
    row.contractFingerprint === null ||
    row.identityJson === null ||
    row.stablePriceReferenceJson === null ||
    row.riskProfileKey === null ||
    row.riskBufferBps === null ||
    row.requestedSeconds === null ||
    row.billableSeconds === null ||
    row.estimatedStableCostMicroUsd === null ||
    row.estimatedPlanningCostMicroUsd === null ||
    row.pricingEffectiveAtEpochMs === null
  ) {
    return null;
  }
  return {
    id: row.id,
    sceneGenerationId: row.sceneGenerationId,
    pricingVersion: row.pricingVersion,
    provider: row.provider,
    contractKey: row.contractKey,
    contractFingerprint: row.contractFingerprint,
    identityJson: row.identityJson,
    stablePriceReferenceJson: row.stablePriceReferenceJson,
    riskProfileKey: row.riskProfileKey,
    riskBufferBps: row.riskBufferBps,
    requestedSeconds: row.requestedSeconds,
    billableSeconds: row.billableSeconds,
    estimatedStableCostMicroUsd: row.estimatedStableCostMicroUsd,
    estimatedPlanningCostMicroUsd: row.estimatedPlanningCostMicroUsd,
    pricingEffectiveAtEpochMs: row.pricingEffectiveAtEpochMs,
    fxSnapshotId: row.fxSnapshotId,
  };
}

/**
 * Aggregate this organization and cycle's provider-cost exposure.
 *
 * Summed from each attempt's own immutable planning snapshot rather than from
 * any current price. What an attempt exposes is what it was costed at when it
 * was admitted; a later catalog change must not silently restate it.
 *
 * Scoped to the organization *and* the cycle its reservation named — never
 * globally, so one tenant's incident cannot pause another.
 *
 * The `WHERE` clause is a **prefilter**, mirroring
 * `isPotentiallyCostExposed` from the exposure module and built from the two
 * constants that module exports. It narrows; it does not classify. Every row it
 * returns is bucketed by `classifyProviderCostExposure`, which is the single
 * authority on which category an attempt belongs to — including the rows that
 * classify to `NONE`, which the prefilter is deliberately loose enough to let
 * through. A parity test proves the prefilter never excludes anything the
 * classifier would have counted.
 */
async function loadExposure(
  tx: Tx,
  organizationId: string,
  billingCycleKey: string,
  excludeAttemptId: string,
  verifiedPlanningCostYen: (snapshot: SnapshotRow) => Promise<Yen | null>,
): Promise<{
  settledEstimated: Yen;
  uncertain: Yen;
  inFlight: Yen;
  unverifiable: boolean;
}> {
  const rows = await tx.$queryRaw<ExposureRow[]>`
    SELECT a."orchestrationState"::text  AS "orchestrationState",
           a."submissionCertainty"::text AS "submissionCertainty",
           ps."id", ps."sceneGenerationId", ps."pricingVersion", ps."provider",
           ps."contractKey", ps."contractFingerprint", ps."identityJson",
           ps."stablePriceReferenceJson", ps."riskProfileKey", ps."riskBufferBps",
           ps."requestedSeconds", ps."billableSeconds",
           ps."estimatedStableCostMicroUsd", ps."estimatedPlanningCostMicroUsd",
           ps."pricingEffectiveAtEpochMs", ps."fxSnapshotId"
      FROM "scene_generations" a
      -- LEFT, deliberately. Snapshot existence must never decide whether an
      -- attempt is visible to the classifier: a cost-bearing attempt with no
      -- pricing row has to be *seen* and refused, not silently filtered away.
      LEFT JOIN "generation_pricing_snapshots" ps ON ps."sceneGenerationId" = a."id"
      JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
      JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
      JOIN "generation_jobs" j ON j."id" = s."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
      JOIN "generation_reservations" res ON res."generationJobId" = j."id"
     WHERE p."organizationId" = ${organizationId}
       AND res."billingCycleKey" = ${billingCycleKey}
       AND a."id" <> ${excludeAttemptId}
       AND a."orchestrationState" IS NOT NULL
       AND COALESCE(a."submissionCertainty"::text, 'PRE_SUBMISSION') <> 'DEFINITIVELY_REJECTED'
       AND (
             a."orchestrationState"::text = ANY(${[
               ...ALWAYS_COST_EXPOSED_ATTEMPT_STATES,
             ]}::text[])
          OR COALESCE(a."submissionCertainty"::text, 'PRE_SUBMISSION') = ANY(${[
               ...COST_BEARING_SUBMISSION_CERTAINTIES,
             ]}::text[])
       )
  `;

  let settledEstimated = 0;
  let uncertain = 0;
  let inFlight = 0;
  let unverifiable = false;
  for (const row of rows) {
    // A legacy row with no certainty has not crossed any boundary this phase
    // knows about; `PRE_SUBMISSION` is both the schema default and the
    // conservative reading for a state that already passed the prefilter.
    const certainty: SubmissionCertainty = row.submissionCertainty ?? "PRE_SUBMISSION";
    const category = classifyProviderCostExposure(row.orchestrationState, certainty);
    // A definitively rejected attempt contributes nothing, so nothing about its
    // historical price needs to reproduce. Requiring reproduction here would
    // turn an attempt the provider refused into cost purely because its rate
    // card is no longer reconstructible.
    if (category === "NONE" || category === "KNOWN_ACTUAL") continue;

    // Only now, after the attempt has been classified as cost-bearing, does
    // the snapshot matter — and now its absence is itself the finding. Phase
    // 4C-3B-2E requires exactly one from `SUBMITTING` onward; a cost-bearing
    // attempt without one means the cycle total cannot be known.
    const snapshot = snapshotOf(row);
    if (snapshot === null) {
      unverifiable = true;
      continue;
    }

    // The sibling's own snapshot, re-derived through the same verifier the
    // candidate goes through. Trusting the stored amount here would leave the
    // Safety Guard equation exactly as forgeable as it was before the candidate
    // was protected: every term of a sum has to be verified, not one of them.
    const amount = await verifiedPlanningCostYen(snapshot);
    if (amount === null) {
      // Not zero, and not skipped. A cost-bearing sibling whose snapshot cannot
      // be reproduced means the cycle total is unknown, and an unknown total
      // must not authorize a payment.
      unverifiable = true;
      continue;
    }
    if (category === "SETTLED_ESTIMATED") settledEstimated += amount;
    else if (category === "UNCERTAIN") uncertain += amount;
    else inFlight += amount;
  }
  return {
    settledEstimated: yen(settledEstimated),
    uncertain: yen(uncertain),
    inFlight: yen(inFlight),
    unverifiable,
  };
}

/**
 * Load and validate one persisted FX snapshot through the canonical path.
 *
 * The rate's integer columns are range-checked before they are narrowed, for
 * the same reason the money columns are: a `BIGINT` beyond the safe-integer
 * range is a corrupt financial fact, and narrowing it first would produce a
 * plausible-looking rate that silently mis-converts every amount it touches.
 */
async function loadFxSnapshot(tx: Tx, id: string): Promise<FxSnapshot | null> {
  const row = await tx.fxRateSnapshot.findUnique({ where: { id } });
  if (row === null) return null;
  const numerator = persistedIntegerToNumber(BigInt(row.rateNumerator));
  const denominator = persistedIntegerToNumber(BigInt(row.rateDenominator));
  const effectiveAt = persistedIntegerToNumber(BigInt(row.effectiveAtEpochMs));
  if (numerator === null || denominator === null || effectiveAt === null) return null;
  const candidate: FxSnapshot = {
    id: row.id,
    baseCurrency: row.baseCurrency,
    quoteCurrency: row.quoteCurrency,
    rateNumerator: numerator,
    rateDenominator: denominator,
    effectiveAt: effectiveAt as never,
    sourceReference: row.sourceReference,
  } as FxSnapshot;
  const validated = validateFxSnapshot(candidate);
  return validated.ok ? validated.value : null;
}

/**
 * Resolve the contract this snapshot was priced against, by its own identity.
 *
 * Identity resolution alone is not proof of sameness — that is what the
 * verifier's fingerprint comparison is for — but it is how the right candidate
 * is found in the first place. Resolving by the *attempt's* provider and model
 * instead would hand the verifier whatever the catalog sells today.
 */
function contractFor(snapshot: SnapshotRow): {
  contract: ProviderPricingContract | null;
  generationMode: string;
  audioMode: string;
} {
  const identity = snapshot.identityJson as {
    provider?: unknown;
    pricingModelKey?: unknown;
    generationMode?: unknown;
    nativeTier?: unknown;
    audioMode?: unknown;
    durationBillingRuleId?: unknown;
    pricingVersion?: unknown;
  } | null;
  const provider = identity?.provider;
  const pricingModelKey = identity?.pricingModelKey;
  const generationMode = identity?.generationMode;
  const nativeTier = identity?.nativeTier;
  const audioMode = identity?.audioMode;
  const durationBillingRuleId = identity?.durationBillingRuleId;
  const pricingVersion = identity?.pricingVersion;
  if (
    typeof provider !== "string" ||
    typeof pricingModelKey !== "string" ||
    typeof generationMode !== "string" ||
    typeof nativeTier !== "string" ||
    typeof audioMode !== "string" ||
    typeof durationBillingRuleId !== "string" ||
    typeof pricingVersion !== "string"
  ) {
    return { contract: null, generationMode: "", audioMode: "" };
  }
  const contract = createProviderPricingCatalog().findByIdentity({
    provider,
    pricingModelKey,
    generationMode,
    nativeTier,
    audioMode,
    durationBillingRuleId,
    pricingVersion,
  });
  return { contract: contract ?? null, generationMode, audioMode };
}

/** The persisted row, in the shape the domain verifier consumes. */
function persistedFacts(snapshot: SnapshotRow): PersistedPricingSnapshotFacts {
  return {
    sceneGenerationId: snapshot.sceneGenerationId,
    pricingVersion: snapshot.pricingVersion,
    provider: snapshot.provider,
    contractKey: snapshot.contractKey,
    contractFingerprint: snapshot.contractFingerprint,
    identityJson: snapshot.identityJson,
    stablePriceReferenceJson: snapshot.stablePriceReferenceJson,
    riskProfileKey: snapshot.riskProfileKey,
    riskBufferBps: snapshot.riskBufferBps,
    requestedSeconds: snapshot.requestedSeconds,
    billableSeconds: snapshot.billableSeconds,
    estimatedStableCostMicroUsd: snapshot.estimatedStableCostMicroUsd,
    estimatedPlanningCostMicroUsd: snapshot.estimatedPlanningCostMicroUsd,
    pricingEffectiveAtEpochMs: snapshot.pricingEffectiveAtEpochMs,
    fxSnapshotId: snapshot.fxSnapshotId,
  };
}

type VerifiedCost =
  | { readonly ok: true; readonly yen: Yen }
  | { readonly ok: false; readonly reason: PricingAuthorizationFailure };

/**
 * One snapshot's planning cost in yen, or why it cannot be trusted.
 *
 * **The single path for every amount that enters the Safety Guard equation.**
 * The candidate's own cost and every cost-bearing sibling's go through exactly
 * this function, because verifying one term of a sum and trusting the rest
 * leaves the sum as forgeable as it was: a `PROCESSING` sibling whose stored
 * planning cost is edited from ¥5,000 to ¥10 removes ¥4,990 of real exposure
 * from a cycle whose candidate snapshot is flawless.
 *
 * Note what is deliberately *not* checked here: whether the contract is
 * eligible **now**. That is a different question with a different answer.
 * Current stable/list eligibility is required of the candidate, because the
 * candidate is about to be priced and paid for. A sibling has already been
 * priced; the only question about it is whether its persisted historical
 * snapshot reproduces exactly. A rate card that expired last month still
 * describes real money that was really committed, and erasing that cost
 * because the card lapsed would understate the cycle in precisely the
 * situation — a provider price change mid-incident — where the guard matters
 * most.
 */
async function verifiedPlanningCostYen(tx: Tx, snapshot: SnapshotRow): Promise<VerifiedCost> {
  if (snapshot.fxSnapshotId === null) {
    return { ok: false, reason: "PRICING_FX_SNAPSHOT_MISSING" };
  }
  const fx = await loadFxSnapshot(tx, snapshot.fxSnapshotId);
  if (fx === null) return { ok: false, reason: "PRICING_FX_SNAPSHOT_INVALID" };

  const { contract } = contractFor(snapshot);
  const verified = verifyPersistedPricingSnapshot({
    persisted: persistedFacts(snapshot),
    contract,
    fx,
  });
  if (!verified.ok) return { ok: false, reason: verified.reason };

  // The re-derived amount, never the stored column.
  const converted = convertMicroUsdToYen(verified.snapshot.estimatedPlanningCostMicroUsd, fx);
  if (!converted.ok) return { ok: false, reason: "PRICING_AMOUNT_UNREPRESENTABLE" };
  return { ok: true, yen: converted.value };
}

export function createPaidSubmissionAuthorizationRepository(
  prisma: PrismaClient,
): PaidSubmissionAuthorizationRepository {
  return {
    async withCostAdmission(input, run) {
      return prisma.$transaction(async (tx) => {
        // The cycle is resolved before the lock so the lock can be keyed on it.
        // A read outside the lock is safe here: it decides only *which* lock to
        // take, and the reservation's cycle is immutable once written.
        const cycleKey = await billingCycleKeyForAttempt(
          tx,
          input.organizationId,
          input.attemptId,
        );
        // With no reservation there is no cycle, and nothing to serialize on.
        // The gate refuses such an attempt on the reservation rule; a stable
        // per-organization key keeps the lock discipline uniform meanwhile.
        await acquireCostAdmissionLock(tx, input.organizationId, cycleKey ?? "unreserved");

        // Then the reservation row itself, before any fact that depends on it
        // is read. The advisory lock orders two authorizations against one
        // cycle; it does nothing about a release or a reconciliation hold
        // landing between this gate's decision and its commit. `false` means
        // there is no reservation to lock — the gate refuses such an attempt on
        // the reservation rule a few statements later.
        await lockReservationForAttempt(tx, input.organizationId, input.attemptId);

        const session: PaidSubmissionAuthorizationSession = {
          async loadFacts(): Promise<PaidSubmissionFactsSnapshot | null> {
            const row = await loadAttemptChain(tx, input.organizationId, input.attemptId);
            // Missing, cross-tenant, or a legacy row with no logical request.
            if (row === null || row.orchestrationState === null) return null;

            const snapshotRows = await tx.$queryRaw<SnapshotRow[]>`
              SELECT ps."id", ps."sceneGenerationId", ps."pricingVersion",
                     ps."provider", ps."contractKey", ps."contractFingerprint",
                     ps."identityJson", ps."stablePriceReferenceJson",
                     ps."riskProfileKey", ps."riskBufferBps",
                     ps."requestedSeconds", ps."billableSeconds",
                     ps."estimatedStableCostMicroUsd",
                     ps."estimatedPlanningCostMicroUsd",
                     ps."pricingEffectiveAtEpochMs", ps."fxSnapshotId"
                FROM "generation_pricing_snapshots" ps
               WHERE ps."sceneGenerationId" = ${input.attemptId}
            `;
            const snapshot = snapshotRows[0] ?? null;

            const attempt: AttemptGateFacts = {
              attemptId: row.attemptId,
              orchestrationState: row.orchestrationState,
              submissionCertainty: (row.submissionCertainty ??
                "PRE_SUBMISSION") as AttemptGateFacts["submissionCertainty"],
              stateVersion: row.stateVersion,
              generationJobId: row.jobId,
              qualityTier: row.qualityTier,
              providerName: row.providerName,
              providerModelId: row.providerModelId,
              requestModelKey: row.requestModelKey,
              requestNativeGenerationResolution: row.requestNativeGenerationResolution,
              // Refuse a value outside the closed product vocabulary rather
              // than widening it here.
              requestTargetOutputResolution: isTargetOutputResolution(
                row.requestTargetOutputResolution,
              )
                ? row.requestTargetOutputResolution
                : null,
              requestDurationSeconds: row.requestDurationSeconds,
              pricingContractKey: row.pricingContractKey,
              requestKind: row.requestKind,
              requestUserRegenerationOrdinal: row.userRegenerationOrdinal,
            };
            const job: JobGateFacts = {
              id: row.jobId,
              qualityTier: row.qualityTier,
              requiredVideoUnits: row.requiredVideoUnits,
              requiredHighQualityUnits: row.requiredHighQualityUnits,
            };

            const reservationRow = await tx.generationReservation.findFirst({
              where: { generationJobId: row.jobId },
            });
            const reservation: ReservationGateFacts | null =
              reservationRow === null
                ? null
                : {
                    generationJobId: reservationRow.generationJobId,
                    state: reservationRow.state,
                    reservedTotalVideoUnits: reservationRow.reservedTotalVideoUnits,
                    reservedHighQualityUnits: reservationRow.reservedHighQualityUnits,
                  };

            let pricing: PricingGateFacts;
            if (snapshot === null) {
              pricing = {
                snapshotBoundToAttempt: false,
                bindingValid: false,
                contract: null,
                identityGenerationMode: "",
                identityAudioMode: "",
                integrityFailure: null,
                plannedCostYen: null,
                fxFailure: null,
                pricingSnapshotId: null,
              };
            } else {
              const { contract, generationMode, audioMode } = contractFor(snapshot);
              // The same verifier every sibling goes through: the whole row
              // re-derived, and the re-derived amount used.
              const verified = await verifiedPlanningCostYen(tx, snapshot);

              // FX failures keep their own field so the gate can report them
              // with their own reasons; everything else is an integrity verdict.
              const fxFailure: "MISSING" | "INVALID" | null = verified.ok
                ? null
                : verified.reason === "PRICING_FX_SNAPSHOT_MISSING"
                  ? "MISSING"
                  : verified.reason === "PRICING_FX_SNAPSHOT_INVALID"
                    ? "INVALID"
                    : null;
              const integrityFailure: PricingAuthorizationFailure | null =
                verified.ok || fxFailure !== null ? null : verified.reason;

              pricing = {
                snapshotBoundToAttempt: snapshot.sceneGenerationId === row.attemptId,
                // Defence in depth over the persisted row: provider, contract
                // key and risk profile must still agree with the attempt and
                // its job. `armProviderBoundaryWithin` re-checks the rest.
                bindingValid:
                  snapshot.provider === row.providerName &&
                  snapshot.contractKey === row.pricingContractKey &&
                  snapshot.requestedSeconds === row.requestDurationSeconds &&
                  snapshot.riskProfileKey === riskProfileKeyForQualityTier(row.qualityTier),
                contract,
                identityGenerationMode: generationMode,
                identityAudioMode: audioMode,
                integrityFailure,
                plannedCostYen: verified.ok ? verified.yen : null,
                fxFailure,
                pricingSnapshotId: snapshot.id,
              };
            }

            const cycle = cycleKey;
            let exposure: ProviderCostExposure = {
              knownActualCostYen: yen(0),
              settledEstimatedCostYen: yen(0),
              uncertainCostYen: yen(0),
              inFlightCostYen: yen(0),
              nextProjectedCostYen: pricing.plannedCostYen ?? yen(0),
            };
            let exposureVerified = true;
            if (cycle !== null) {
              const aggregated = await loadExposure(
                tx,
                input.organizationId,
                cycle,
                input.attemptId,
                async (sibling) => {
                  const verified = await verifiedPlanningCostYen(tx, sibling);
                  return verified.ok ? verified.yen : null;
                },
              );
              exposure = {
                // Nothing persists what a provider actually billed, so this is
                // structurally zero rather than an estimate wearing the name of
                // an actual. See the exposure module.
                knownActualCostYen: yen(0),
                settledEstimatedCostYen: aggregated.settledEstimated,
                uncertainCostYen: aggregated.uncertain,
                inFlightCostYen: aggregated.inFlight,
                nextProjectedCostYen: pricing.plannedCostYen ?? yen(0),
              };
              // Reported separately from the candidate's own pricing. A
              // sibling's broken snapshot is not evidence about this attempt's
              // FX rate, and labelling it that way would send an operator to
              // the wrong row.
              exposureVerified = !aggregated.unverifiable;
            }

            return {
              attempt,
              job,
              reservation,
              pricing,
              exposure,
              exposureVerified,
              billingCycleKey: cycle,
            };
          },

          async arm({ expectedVersion, context }): Promise<ArmResult> {
            const armed = await armProviderBoundaryWithin(tx, {
              organizationId: input.organizationId,
              id: input.attemptId,
              expectedVersion,
              context,
            });
            if (armed.kind === "ARMED") {
              return { kind: "ARMED", stateVersion: armed.attempt.stateVersion };
            }
            if (armed.kind === "LOST") return { kind: "LOST" };
            return { kind: "REFUSED_BY_BOUNDARY" };
          },
        };

        return run(session);
      });
    },
  };
}
