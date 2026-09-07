import type { Prisma, PrismaClient } from "@prisma/client";
import {
  ALWAYS_COST_EXPOSED_ATTEMPT_STATES,
  COST_BEARING_SUBMISSION_CERTAINTIES,
  classifyProviderCostExposure,
  convertMicroUsdToYen,
  createProviderPricingCatalog,
  isTargetOutputResolution,
  persistedIntegerToNumber,
  persistedMicroUsd,
  riskProfileKeyForQualityTier,
  validateFxSnapshot,
  verifyPersistedPricingSnapshot,
  yen,
  type ArmResult,
  type AttemptGateFacts,
  type FxSnapshot,
  type GenerationAttemptState,
  type JobGateFacts,
  type MicroUsd,
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

interface ExposureRow {
  orchestrationState: GenerationAttemptState;
  submissionCertainty: SubmissionCertainty | null;
  estimatedPlanningCostMicroUsd: bigint;
  fxSnapshotId: string | null;
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
  toYen: (microUsdAmount: bigint, fxSnapshotId: string | null) => Promise<Yen | null>,
): Promise<{
  settledEstimated: Yen;
  uncertain: Yen;
  inFlight: Yen;
  unconvertible: boolean;
}> {
  const rows = await tx.$queryRaw<ExposureRow[]>`
    SELECT a."orchestrationState"::text  AS "orchestrationState",
           a."submissionCertainty"::text AS "submissionCertainty",
           ps."estimatedPlanningCostMicroUsd",
           ps."fxSnapshotId"
      FROM "scene_generations" a
      JOIN "generation_pricing_snapshots" ps ON ps."sceneGenerationId" = a."id"
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
  let unconvertible = false;
  for (const row of rows) {
    // A legacy row with no certainty has not crossed any boundary this phase
    // knows about; `PRE_SUBMISSION` is both the schema default and the
    // conservative reading for a state that already passed the prefilter.
    const certainty: SubmissionCertainty = row.submissionCertainty ?? "PRE_SUBMISSION";
    const category = classifyProviderCostExposure(row.orchestrationState, certainty);
    if (category === "NONE" || category === "KNOWN_ACTUAL") continue;

    const amount = await toYen(row.estimatedPlanningCostMicroUsd, row.fxSnapshotId);
    if (amount === null) {
      // An exposure that cannot be converted is not zero. Marking it here makes
      // the gate fail closed rather than quietly under-counting the guard.
      unconvertible = true;
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
    unconvertible,
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

            /** Micro-USD to yen through the attempt's own persisted rate. */
            const toYen = async (
              amountMicroUsd: bigint,
              fxSnapshotId: string | null,
            ): Promise<Yen | null> => {
              if (fxSnapshotId === null) return null;
              const amount: MicroUsd | null = persistedMicroUsd(amountMicroUsd);
              if (amount === null) return null;
              const fx = await loadFxSnapshot(tx, fxSnapshotId);
              if (fx === null) return null;
              const converted = convertMicroUsdToYen(amount, fx);
              return converted.ok ? converted.value : null;
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
              const fx =
                snapshot.fxSnapshotId === null
                  ? null
                  : await loadFxSnapshot(tx, snapshot.fxSnapshotId);
              const fxFailure: "MISSING" | "INVALID" | null =
                snapshot.fxSnapshotId === null ? "MISSING" : fx === null ? "INVALID" : null;

              // The whole row, re-derived through the pricing domain. Only the
              // amount that survives that is allowed to become exposure.
              let integrityFailure: PricingAuthorizationFailure | null = null;
              let plannedCostYen: Yen | null = null;
              if (fxFailure === null) {
                const persisted: PersistedPricingSnapshotFacts = {
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
                const verified = verifyPersistedPricingSnapshot({ persisted, contract, fx });
                if (verified.ok) {
                  const converted = convertMicroUsdToYen(
                    verified.snapshot.estimatedPlanningCostMicroUsd,
                    // Verified above; `fxFailure === null` implies a rate.
                    fx as FxSnapshot,
                  );
                  if (converted.ok) plannedCostYen = converted.value;
                  else integrityFailure = "PRICING_AMOUNT_UNREPRESENTABLE";
                } else {
                  integrityFailure = verified.reason;
                }
              }

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
                plannedCostYen,
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
            if (cycle !== null) {
              const aggregated = await loadExposure(
                tx,
                input.organizationId,
                cycle,
                input.attemptId,
                toYen,
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
              if (aggregated.unconvertible) {
                // Some existing exposure could not be valued. Refuse rather
                // than authorize against a total known to be short.
                pricing = { ...pricing, fxFailure: pricing.fxFailure ?? "INVALID" };
              }
            }

            return { attempt, job, reservation, pricing, exposure, billingCycleKey: cycle };
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
