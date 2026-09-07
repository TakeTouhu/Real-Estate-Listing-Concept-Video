import type { Prisma, PrismaClient } from "@prisma/client";
import {
  COST_EXPOSED_ATTEMPT_STATES,
  IN_FLIGHT_COST_ATTEMPT_STATES,
  UNCERTAIN_COST_ATTEMPT_STATES,
  convertMicroUsdToYen,
  createProviderPricingCatalog,
  isTargetOutputResolution,
  microUsd,
  riskProfileKeyForQualityTier,
  validateFxSnapshot,
  yen,
  type ArmResult,
  type AttemptGateFacts,
  type FxSnapshot,
  type GenerationAttemptState,
  type JobGateFacts,
  type PaidSubmissionAuthorizationRepository,
  type PaidSubmissionAuthorizationSession,
  type PaidSubmissionFactsSnapshot,
  type PricingGateFacts,
  type ProviderCostExposure,
  type ProviderPricingContract,
  type ReservationGateFacts,
  type Yen,
} from "@app/domain";
import { armProviderBoundaryWithin } from "./orchestration-repositories";

/**
 * Persistence for the paid submission authorization gate.
 *
 * Everything one decision reads, and the serialization point that makes two
 * decisions safe, in one place. There is no provider client here and no HTTP:
 * this module reads rows and runs one compare-and-set.
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

interface SnapshotRow {
  sceneGenerationId: string;
  provider: string;
  contractKey: string;
  requestedSeconds: number;
  riskProfileKey: string;
  identityJson: Prisma.JsonValue;
  estimatedPlanningCostMicroUsd: bigint;
  fxSnapshotId: string | null;
}

/**
 * Aggregate this organization and cycle's provider-cost exposure.
 *
 * Grouped by orchestration state so the three categories stay separable, and
 * summed from each attempt's own immutable planning snapshot rather than from
 * any current price. What an in-flight attempt exposes is what it was costed at
 * when it was admitted; a later catalog change must not silently restate it.
 *
 * Scoped to the organization *and* the cycle its reservation named — never
 * globally, so one tenant's incident cannot pause another.
 */
async function loadExposure(
  tx: Tx,
  organizationId: string,
  billingCycleKey: string,
  excludeAttemptId: string,
  toYen: (microUsdAmount: bigint, fxSnapshotId: string | null) => Promise<Yen | null>,
): Promise<{ uncertain: Yen; inFlight: Yen; unconvertible: boolean }> {
  const rows = await tx.$queryRaw<
    {
      orchestrationState: GenerationAttemptState;
      estimatedPlanningCostMicroUsd: bigint;
      fxSnapshotId: string | null;
    }[]
  >`
    SELECT a."orchestrationState"::text AS "orchestrationState",
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
       AND a."orchestrationState"::text = ANY(${[...COST_EXPOSED_ATTEMPT_STATES]}::text[])
  `;

  let uncertain = 0;
  let inFlight = 0;
  let unconvertible = false;
  for (const row of rows) {
    const amount = await toYen(row.estimatedPlanningCostMicroUsd, row.fxSnapshotId);
    if (amount === null) {
      // An exposure that cannot be converted is not zero. Marking it here makes
      // the gate fail closed rather than quietly under-counting the guard.
      unconvertible = true;
      continue;
    }
    if ((UNCERTAIN_COST_ATTEMPT_STATES as readonly string[]).includes(row.orchestrationState)) {
      uncertain += amount;
    } else if (
      (IN_FLIGHT_COST_ATTEMPT_STATES as readonly string[]).includes(row.orchestrationState)
    ) {
      inFlight += amount;
    }
  }
  return { uncertain: yen(uncertain), inFlight: yen(inFlight), unconvertible };
}

/** Load and validate one persisted FX snapshot through the canonical path. */
async function loadFxSnapshot(tx: Tx, id: string): Promise<FxSnapshot | null> {
  const row = await tx.fxRateSnapshot.findUnique({ where: { id } });
  if (row === null) return null;
  const candidate: FxSnapshot = {
    id: row.id,
    baseCurrency: row.baseCurrency,
    quoteCurrency: row.quoteCurrency,
    rateNumerator: Number(row.rateNumerator),
    rateDenominator: Number(row.rateDenominator),
    effectiveAt: Number(row.effectiveAtEpochMs) as never,
    sourceReference: row.sourceReference,
  } as FxSnapshot;
  const validated = validateFxSnapshot(candidate);
  return validated.ok ? validated.value : null;
}

function contractFor(
  snapshot: SnapshotRow,
): { contract: ProviderPricingContract | null; generationMode: string; audioMode: string } {
  const identity = snapshot.identityJson as {
    provider?: unknown;
    pricingModelKey?: unknown;
    generationMode?: unknown;
    nativeTier?: unknown;
    audioMode?: unknown;
    durationBillingRuleId?: unknown;
    pricingVersion?: unknown;
  } | null;
  const fields = [
    identity?.provider,
    identity?.pricingModelKey,
    identity?.generationMode,
    identity?.nativeTier,
    identity?.audioMode,
    identity?.durationBillingRuleId,
    identity?.pricingVersion,
  ];
  if (fields.some((f) => typeof f !== "string")) {
    return { contract: null, generationMode: "", audioMode: "" };
  }
  // Resolved by the snapshot's *own* frozen identity, so the contract judged
  // here is the one this attempt was admitted against — not whatever the
  // catalog would return for its provider and model today.
  const contract = createProviderPricingCatalog().findByIdentity({
    provider: identity!.provider as string,
    pricingModelKey: identity!.pricingModelKey as string,
    generationMode: identity!.generationMode as string,
    nativeTier: identity!.nativeTier as string,
    audioMode: identity!.audioMode as string,
    durationBillingRuleId: identity!.durationBillingRuleId as string,
    pricingVersion: identity!.pricingVersion as string,
  });
  return {
    contract: contract ?? null,
    generationMode: identity!.generationMode as string,
    audioMode: identity!.audioMode as string,
  };
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
              SELECT ps."sceneGenerationId", ps."provider", ps."contractKey",
                     ps."requestedSeconds", ps."riskProfileKey", ps."identityJson",
                     ps."estimatedPlanningCostMicroUsd", ps."fxSnapshotId"
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
              const fx = await loadFxSnapshot(tx, fxSnapshotId);
              if (fx === null) return null;
              const converted = convertMicroUsdToYen(microUsd(Number(amountMicroUsd)), fx);
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
                plannedCostYen: null,
                fxFailure: null,
              };
            } else {
              const { contract, generationMode, audioMode } = contractFor(snapshot);
              const plannedCostYen = await toYen(
                snapshot.estimatedPlanningCostMicroUsd,
                snapshot.fxSnapshotId,
              );
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
                plannedCostYen,
                fxFailure:
                  snapshot.fxSnapshotId === null
                    ? "MISSING"
                    : plannedCostYen === null
                      ? "INVALID"
                      : null,
              };
            }

            const cycle = cycleKey;
            let exposure: ProviderCostExposure = {
              knownActualCostYen: yen(0),
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
