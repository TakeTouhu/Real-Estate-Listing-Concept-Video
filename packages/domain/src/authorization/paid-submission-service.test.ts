import { describe, expect, it } from "vitest";
import { sanitizeTransitionMetadata } from "../orchestration/transition-metadata";
import type { TransitionContext } from "../orchestration/ports";
import { createProviderPricingCatalog } from "../pricing/provider-pricing-catalog";
import type { ProviderPricingContract } from "../pricing/provider-pricing-contract";
import { epochMillisFromDate, yen, type EpochMillis, type Yen } from "../pricing/units";
import { createFixedAuthorizationClock, type AuthorizationClock } from "./clock";
import { AUTHORIZATION_POLICY_VERSION } from "./gate";
import {
  createPaidSubmissionAuthorizationService,
  PAID_SUBMISSION_AUTHORIZED_EVENT_TYPE,
} from "./paid-submission-service";
import { ROUTING_POLICY_VERSION } from "./routing";
import type {
  ArmResult,
  BillingCycleRevenueReader,
  PaidSubmissionAuthorizationRepository,
  PaidSubmissionFactsSnapshot,
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
      requestKind: "INITIAL",
      requestUserRegenerationOrdinal: null,
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
      integrityFailure: null,
      plannedCostYen: yen(100),
      fxFailure: null,
      pricingSnapshotId: "gps_svc",
    },
    exposure: {
      knownActualCostYen: yen(0),
      settledEstimatedCostYen: yen(0),
      uncertainCostYen: yen(0),
      inFlightCostYen: yen(0),
      nextProjectedCostYen: yen(100),
    },
    exposureVerified: true,
    billingCycleKey: "2026-09",
  };
}

interface Harness {
  readonly calls: { arm: number; clock: number; factsLoaded: number };
  readonly armedContexts: TransitionContext[];
  readonly service: ReturnType<typeof createPaidSubmissionAuthorizationService>;
}

function serviceWith(
  arm: () => Promise<ArmResult>,
  options: {
    facts?: PaidSubmissionFactsSnapshot | null;
    cycleYen?: Yen | null;
    clock?: AuthorizationClock;
    /** Called after the lock is taken and before facts are loaded. */
    onLock?: () => void;
  } = {},
): Harness {
  const facts = options.facts === undefined ? permittingFacts() : options.facts;
  const cycleYen = options.cycleYen === undefined ? yen(49_800) : options.cycleYen;
  const calls = { arm: 0, clock: 0, factsLoaded: 0 };
  const armedContexts: TransitionContext[] = [];
  const baseClock = options.clock ?? createFixedAuthorizationClock(AT);
  const clock: AuthorizationClock = {
    now() {
      calls.clock += 1;
      return baseClock.now();
    },
  };
  const authorization: PaidSubmissionAuthorizationRepository = {
    async withCostAdmission(_input, run) {
      options.onLock?.();
      return run({
        async loadFacts() {
          calls.factsLoaded += 1;
          return facts;
        },
        async arm(input) {
          calls.arm += 1;
          armedContexts.push(input.context);
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
  return {
    calls,
    armedContexts,
    service: createPaidSubmissionAuthorizationService({
      authorization,
      billingCycleRevenue,
      clock,
    }),
  };
}

const CONTEXT: TransitionContext = {
  actorType: "SYSTEM",
  actorUserId: null,
  correlationId: "corr_svc",
  causationId: null,
  reasonCode: null,
  eventType: "CALLER_CHOSEN",
  metadata: sanitizeTransitionMetadata({}),
};

function authorize(
  service: Harness["service"],
  context: TransitionContext = CONTEXT,
) {
  return service.authorize({
    organizationId: "org_svc",
    attemptId: "sgen_svc",
    context,
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
      { cycleYen: null },
    );
    const outcome = await authorize(service);
    expect(outcome).toMatchObject({ kind: "SAFETY_GUARD_HARD_PAUSE" });
    expect(calls.arm).toBe(0);
  });

  it("answers a missing or cross-tenant attempt without reaching the boundary", async () => {
    const { service, calls } = serviceWith(
      async () => ({ kind: "ARMED", stateVersion: 4 }),
      { facts: null },
    );
    expect(await authorize(service)).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
    expect(calls.arm).toBe(0);
  });

  it("carries a Safety Guard warning out with the authorization", async () => {
    // WARNING does not block, and it is not swallowed either.
    const { service } = serviceWith(async () => ({ kind: "ARMED", stateVersion: 4 }), {
      // Revenue chosen so profit lands between the ¥15,000 and ¥20,000 floors.
      cycleYen: yen(19_900),
    });
    const outcome = await authorize(service);
    if (outcome.kind !== "AUTHORIZED") throw new Error("expected AUTHORIZED");
    expect(outcome.safetyGuardWarning?.state).toBe("WARNING");
  });
});

describe("the authorization clock", () => {
  it("is read after the cost-admission lock, not before it", async () => {
    // A request that waited behind a long queue must be judged at the time it
    // reached the front. Reading before the lock is how a contract that expired
    // during the wait still authorizes a payment.
    const order: string[] = [];
    const { service } = serviceWith(async () => ({ kind: "ARMED", stateVersion: 4 }), {
      onLock: () => order.push("lock"),
      clock: {
        now(): EpochMillis {
          order.push("clock");
          return AT;
        },
      },
    });
    await authorize(service);
    expect(order).toEqual(["lock", "clock"]);
  });

  it("refuses a contract that expired while the request waited for the lock", async () => {
    // A contract whose window closes at noon. The request arrived before then
    // and reached the front of the cost lock after — evaluated at the instant it
    // joined the queue it is eligible, evaluated at the instant it was actually
    // decided it is not, and the second is the honest one.
    const closesAt = epochMillisFromDate(new Date("2026-09-10T12:00:00.000Z"));
    const closing: ProviderPricingContract = { ...CONTRACT, effectiveUntil: closesAt };
    const beforeClose = epochMillisFromDate(new Date("2026-09-10T11:59:00.000Z"));
    const afterClose = epochMillisFromDate(new Date("2026-09-10T12:01:00.000Z"));
    const withClosing: PaidSubmissionFactsSnapshot = {
      ...permittingFacts(),
      pricing: { ...permittingFacts().pricing, contract: closing },
    };

    // The same facts, decided a minute earlier, do authorize — so the refusal
    // below is the clock and nothing else about this fixture.
    const early = serviceWith(async () => ({ kind: "ARMED", stateVersion: 4 }), {
      facts: withClosing,
      clock: createFixedAuthorizationClock(beforeClose),
    });
    expect((await authorize(early.service)).kind).toBe("AUTHORIZED");

    const late = serviceWith(async () => ({ kind: "ARMED", stateVersion: 4 }), {
      facts: withClosing,
      clock: createFixedAuthorizationClock(afterClose),
    });
    const outcome = await authorize(late.service);
    expect(outcome).toEqual({
      kind: "PRICING_INELIGIBLE",
      reason: "PRICING_CONTRACT_EXPIRED",
    });
    expect(late.calls.arm).toBe(0);
  });

  it("reads the instant exactly once for one decision", async () => {
    // Two reads could straddle an expiry and let two parts of one decision
    // disagree about when "now" is.
    const { service, calls } = serviceWith(async () => ({ kind: "ARMED", stateVersion: 4 }));
    await authorize(service);
    expect(calls.clock).toBe(1);
  });
});

describe("the durable authorization record", () => {
  it("writes the financial basis into the transition the CAS commits", async () => {
    const { service, armedContexts } = serviceWith(
      async () => ({ kind: "ARMED", stateVersion: 4 }),
      {
        facts: {
          ...permittingFacts(),
          exposure: {
            knownActualCostYen: yen(0),
            settledEstimatedCostYen: yen(1_100),
            uncertainCostYen: yen(2_200),
            inFlightCostYen: yen(3_300),
            nextProjectedCostYen: yen(100),
          },
        },
      },
    );
    await authorize(service);
    expect(armedContexts).toHaveLength(1);
    expect(armedContexts[0]!.metadata).toMatchObject({
      authorizationPolicyVersion: AUTHORIZATION_POLICY_VERSION,
      routingPolicyVersion: ROUTING_POLICY_VERSION,
      safetyGuardState: "SAFE",
      billingCycleRevenueYen: 49_800,
      knownActualCostYen: 0,
      settledEstimatedCostYen: 1_100,
      uncertainCostYen: 2_200,
      inFlightCostYen: 3_300,
      nextProjectedCostYen: 100,
      projectedContributionProfitYen: 43_100,
      warningFloorYen: 20_000,
      hardPauseFloorYen: 15_000,
      pricingSnapshotId: "gps_svc",
    });
  });

  it("labels the event itself, rather than trusting the caller's label", async () => {
    // The label is what an audit query selects on. A caller able to write
    // something else could make a paid authorization indistinguishable from any
    // other transition — not necessarily on purpose; a copied context is enough.
    const { service, armedContexts } = serviceWith(
      async () => ({ kind: "ARMED", stateVersion: 4 }),
    );
    await authorize(service);
    expect(armedContexts[0]!.eventType).toBe(PAID_SUBMISSION_AUTHORIZED_EVENT_TYPE);
    expect(armedContexts[0]!.eventType).not.toBe(CONTEXT.eventType);
  });

  it("keeps the caller's actor, correlation and causation", async () => {
    // Who asked and why is the caller's to say; only the label and the money
    // are overridden.
    const { service, armedContexts } = serviceWith(
      async () => ({ kind: "ARMED", stateVersion: 4 }),
    );
    await authorize(service, {
      ...CONTEXT,
      actorType: "USER",
      actorUserId: "usr_1",
      causationId: "evt_parent",
      reasonCode: "MANUAL_RETRY",
    });
    expect(armedContexts[0]).toMatchObject({
      actorType: "USER",
      actorUserId: "usr_1",
      correlationId: "corr_svc",
      causationId: "evt_parent",
      reasonCode: "MANUAL_RETRY",
    });
  });

  it("overwrites a caller-supplied guard state rather than merging it", async () => {
    // A caller that pre-seeded a friendlier figure into its own authorization
    // record would make the record worthless exactly when it matters.
    const { service, armedContexts } = serviceWith(
      async () => ({ kind: "ARMED", stateVersion: 4 }),
    );
    await authorize(service, {
      ...CONTEXT,
      metadata: sanitizeTransitionMetadata({
        safetyGuardState: "SAFE",
        nextProjectedCostYen: 0,
      }),
    });
    expect(armedContexts[0]!.metadata).toMatchObject({
      safetyGuardState: "SAFE",
      nextProjectedCostYen: 100,
    });
  });

  it("records WARNING when the guard warned", async () => {
    const { service, armedContexts } = serviceWith(
      async () => ({ kind: "ARMED", stateVersion: 4 }),
      { cycleYen: yen(19_900) },
    );
    await authorize(service);
    expect(armedContexts[0]!.metadata).toMatchObject({
      safetyGuardState: "WARNING",
      billingCycleRevenueYen: 19_900,
    });
  });
});
