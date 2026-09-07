import { describe, expect, it } from "vitest";
import { sanitizeTransitionMetadata } from "../orchestration/transition-metadata";
import { createProviderPricingCatalog } from "../pricing/provider-pricing-catalog";
import type { ProviderPricingContract } from "../pricing/provider-pricing-contract";
import { epochMillisFromDate, yen, type Yen } from "../pricing/units";
import { createPaidSubmissionAuthorizationService } from "./paid-submission-service";
import type {
  ArmResult,
  BillingCycleRevenueReader,
  PaidSubmissionAuthorizationRepository,
  PaidSubmissionFactsSnapshot,
  SceneRevenueReader,
} from "./ports";

/**
 * The service's translation contract, at the seams the database cannot reach.
 *
 * Some of what the service must never do is unreachable through two in-process
 * authorizations: the cost-admission lock serializes them, so the second one
 * re-reads and refuses on state long before its compare-and-set could lose.
 * The `LOST` arm is still real — the repository's own `armProviderBoundary` is
 * a writer outside the lock discipline, and a future worker is another — so it
 * is exercised here directly rather than left to a race that cannot be
 * constructed.
 */

const AT = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));

const CONTRACT_LOOKUP = createProviderPricingCatalog().findByIdentity({
  provider: "wavespeed",
  pricingModelKey: "wavespeed-open-video",
  generationMode: "image-to-video",
  nativeTier: "1080p",
  audioMode: "none",
  durationBillingRuleId: "per-second",
  pricingVersion: "2026-09-02.1",
});
if (CONTRACT_LOOKUP === undefined) throw new Error("expected the OpenVideo contract");
const CONTRACT: ProviderPricingContract = CONTRACT_LOOKUP;

/** Facts that would authorize, so only the arm's answer decides the outcome. */
function permittingFacts(): PaidSubmissionFactsSnapshot {
  return {
    attempt: {
      attemptId: "sgen_svc",
      orchestrationState: "QUEUED",
      submissionCertainty: "PRE_SUBMISSION",
      stateVersion: 3,
      generationJobId: "genjob_svc",
      qualityTier: "NORMAL",
      providerName: "wavespeed",
      providerModelId: "wavespeed-ai/open-video/image-to-video",
      requestModelKey: "wavespeed-open-video",
      requestNativeGenerationResolution: "1080p",
      requestTargetOutputResolution: "1080p",
      requestDurationSeconds: 5,
      pricingContractKey: "wavespeed:wavespeed-open-video:2026-09-02.1",
    },
    job: {
      id: "genjob_svc",
      qualityTier: "NORMAL",
      requiredVideoUnits: 1,
      requiredHighQualityUnits: 0,
    },
    reservation: {
      generationJobId: "genjob_svc",
      state: "RESERVED",
      reservedTotalVideoUnits: 1,
      reservedHighQualityUnits: 0,
    },
    pricing: {
      snapshotBoundToAttempt: true,
      bindingValid: true,
      contract: CONTRACT,
      identityGenerationMode: "image-to-video",
      identityAudioMode: "none",
      plannedCostYen: yen(100),
      fxFailure: null,
    },
    exposure: {
      knownActualCostYen: yen(0),
      uncertainCostYen: yen(0),
      inFlightCostYen: yen(0),
      nextProjectedCostYen: yen(100),
    },
    billingCycleKey: "2026-09",
  };
}

function serviceWith(
  arm: () => Promise<ArmResult>,
  facts: PaidSubmissionFactsSnapshot | null = permittingFacts(),
  cycleYen: Yen | null = yen(49_800),
  sceneYen: Yen | null = yen(3_320),
) {
  const calls = { arm: 0 };
  const authorization: PaidSubmissionAuthorizationRepository = {
    async withCostAdmission(_input, run) {
      return run({
        async loadFacts() {
          return facts;
        },
        async arm() {
          calls.arm += 1;
          return arm();
        },
      });
    },
  };
  const billingCycleRevenue: BillingCycleRevenueReader = {
    async revenueYen() {
      return cycleYen;
    },
  };
  const sceneRevenue: SceneRevenueReader = {
    async revenueYen() {
      return sceneYen;
    },
  };
  return {
    calls,
    service: createPaidSubmissionAuthorizationService({
      authorization,
      billingCycleRevenue,
      sceneRevenue,
    }),
  };
}

const CONTEXT = {
  actorType: "SYSTEM" as const,
  actorUserId: null,
  correlationId: "corr_svc",
  causationId: null,
  reasonCode: null,
  eventType: "TEST",
  metadata: sanitizeTransitionMetadata({}),
};

function authorize(service: ReturnType<typeof serviceWith>["service"]) {
  return service.authorize({
    organizationId: "org_svc",
    attemptId: "sgen_svc",
    authorizationInstant: AT,
    context: CONTEXT,
  });
}

describe("the authorization service's translation of the boundary result", () => {
  it("reports a lost compare-and-set as LOST_CONCURRENCY, never as authorization", async () => {
    // The whole point of the CAS is that the loser gets nothing. Reporting
    // AUTHORIZED here would hand a second worker permission to POST for an
    // attempt another worker already armed — the duplicate charge this entire
    // phase is arranged to prevent.
    const { service } = serviceWith(async () => ({ kind: "LOST" }));
    const outcome = await authorize(service);
    expect(outcome).toEqual({ kind: "LOST_CONCURRENCY" });
  });

  it("reports a boundary refusal as a pricing refusal, never as authorization", async () => {
    // The boundary re-checks the pricing binding from the stored row. It
    // disagreeing with the gate means the snapshot moved under both of them.
    const { service } = serviceWith(async () => ({ kind: "REFUSED_BY_BOUNDARY" }));
    const outcome = await authorize(service);
    expect(outcome).toEqual({
      kind: "PRICING_INELIGIBLE",
      reason: "PRICING_SNAPSHOT_BINDING_INVALID",
    });
  });

  it("reports the version the database committed, not the one it expected", async () => {
    // The gate carried expectedStateVersion 3 into the CAS; what came back is 4.
    // Returning the expected value would report a version that never existed.
    const { service } = serviceWith(async () => ({ kind: "ARMED", stateVersion: 4 }));
    const outcome = await authorize(service);
    expect(outcome).toMatchObject({
      kind: "AUTHORIZED",
      attemptId: "sgen_svc",
      armedStateVersion: 4,
    });
  });

  it("never reaches the boundary when the gate refuses", async () => {
    // A policy refusal must not touch the attempt at all, so `arm` is not
    // called — not called and rolled back, but never called.
    const { service, calls } = serviceWith(
      async () => ({ kind: "ARMED", stateVersion: 4 }),
      permittingFacts(),
      null,
    );
    const outcome = await authorize(service);
    expect(outcome).toMatchObject({ kind: "SAFETY_GUARD_HARD_PAUSE" });
    expect(calls.arm).toBe(0);
  });

  it("answers a missing or cross-tenant attempt without reaching the boundary", async () => {
    const { service, calls } = serviceWith(
      async () => ({ kind: "ARMED", stateVersion: 4 }),
      null,
    );
    expect(await authorize(service)).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
    expect(calls.arm).toBe(0);
  });

  it("carries a Safety Guard warning out with the authorization", async () => {
    // WARNING does not block, and it is not swallowed either.
    const { service } = serviceWith(
      async () => ({ kind: "ARMED", stateVersion: 4 }),
      permittingFacts(),
      // Revenue chosen so profit lands between the ¥15,000 and ¥20,000 floors.
      yen(19_900),
    );
    const outcome = await authorize(service);
    if (outcome.kind !== "AUTHORIZED") throw new Error("expected AUTHORIZED");
    expect(outcome.safetyGuardWarning?.state).toBe("WARNING");
  });

  it("treats an unknown scene revenue as worth nothing rather than assuming", async () => {
    // Fail closed: any positive provider cost against unknown revenue is
    // negative worst-case economics.
    const { service, calls } = serviceWith(
      async () => ({ kind: "ARMED", stateVersion: 4 }),
      permittingFacts(),
      yen(49_800),
      null,
    );
    const outcome = await authorize(service);
    expect(outcome).toMatchObject({
      kind: "PROFITABILITY_REJECTED",
      reason: "NEGATIVE_WORST_CASE_UNIT_ECONOMICS",
    });
    expect(calls.arm).toBe(0);
  });
});
