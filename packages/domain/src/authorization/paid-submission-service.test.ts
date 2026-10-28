import { describe, expect, it } from "vitest";
import { sanitizeTransitionMetadata } from "../orchestration/transition-metadata";
import type { TransitionContext } from "../orchestration/ports";
import { createProviderPricingCatalog } from "../pricing/provider-pricing-catalog";
import type { ProviderPricingContract } from "../pricing/provider-pricing-contract";
import { epochMillisFromDate, yen, type EpochMillis, type Yen } from "../pricing/units";
import type { ExecutionSourceObservation, PreparedSourceIdentity } from "../generation/execution-source";
import { createFixedAuthorizationClock, type AuthorizationClock } from "./clock";
import { AUTHORIZATION_POLICY_VERSION } from "./gate";
import {
  createPaidSubmissionAuthorizationService,
  PAID_SUBMISSION_AUDIT_ACTION,
  PAID_SUBMISSION_AUTHORIZED_EVENT_TYPE,
} from "./paid-submission-service";
import { authorizedRoutes, ROUTING_POLICY_VERSION, type RoutePolicy } from "./routing";
import type {
  ArmResult,
  PaidSubmissionAudit,
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

/** The source preparation signed for the attempt. */
const SOURCE: PreparedSourceIdentity = {
  storageKey: "org/org_svc/p/prop/a/ast_svc/normalized.jpg",
  mimeType: "image/jpeg",
  sha256: "0123456789abcdef".repeat(4),
};

/** The locked asset as it reads when it is still that source. */
function sameSource(): ExecutionSourceObservation {
  return { status: "READY", deletionRequestedAt: null, ...SOURCE };
}

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
  readonly armedAudits: PaidSubmissionAudit[];
  readonly service: ReturnType<typeof createPaidSubmissionAuthorizationService>;
}

function serviceWith(
  arm: () => Promise<ArmResult>,
  options: {
    facts?: PaidSubmissionFactsSnapshot | null;
    cycleYen?: Yen | null;
    clock?: AuthorizationClock;
    routePolicy?: RoutePolicy;
    /** Called after the lock is taken and before facts are loaded. */
    onLock?: () => void;
    /** Each step the session is asked for, in order. */
    order?: string[];
    /** The locked source asset; the prepared source, usable, unless given. */
    source?: ExecutionSourceObservation | null;
    /** Whether the locked source's Property is deleted; standing unless given. */
    propertyDeleted?: boolean;
  } = {},
): Harness {
  const facts = options.facts === undefined ? permittingFacts() : options.facts;
  const cycleYen = options.cycleYen === undefined ? yen(49_800) : options.cycleYen;
  const calls = { arm: 0, clock: 0, factsLoaded: 0 };
  const armedContexts: TransitionContext[] = [];
  const armedAudits: PaidSubmissionAudit[] = [];
  const source = options.source === undefined ? sameSource() : options.source;
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
      options.order?.push("lock");
      const outcome = await run({
        async loadFacts() {
          calls.factsLoaded += 1;
          options.order?.push("facts");
          return facts;
        },
        async readBillingCycleRevenue() {
          options.order?.push("revenue");
          return cycleYen;
        },
        async lockSource() {
          options.order?.push("source");
          return source === null ? null : { asset: source, propertyDeleted: options.propertyDeleted ?? false };
        },
        async arm(input) {
          calls.arm += 1;
          options.order?.push("arm");
          armedContexts.push(input.context);
          armedAudits.push(input.audit);
          return arm();
        },
      });
      options.order?.push("unlock");
      return outcome;
    },
  };
  return {
    calls,
    armedContexts,
    armedAudits,
    service: createPaidSubmissionAuthorizationService({
      authorization,
      clock,
      ...(options.routePolicy === undefined ? {} : { routePolicy: options.routePolicy }),
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
    source: SOURCE,
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

describe("the billing cycle's revenue (ADR-0091)", () => {
  it("is read on the session, after the facts and before arming, inside the lock", async () => {
    // A purchase or a cancellation takes the same lock, so a read anywhere
    // else could feed the decision a figure that changed before it committed.
    const order: string[] = [];
    const { service } = serviceWith(async () => ({ kind: "ARMED", stateVersion: 4 }), { order });
    expect((await authorize(service)).kind).toBe("AUTHORIZED");
    expect(order).toEqual(["lock", "facts", "revenue", "source", "arm", "unlock"]);
  });

  it("is not read for an attempt with no cycle, which is refused", async () => {
    const order: string[] = [];
    const { service } = serviceWith(async () => ({ kind: "ARMED", stateVersion: 4 }), {
      order,
      facts: { ...permittingFacts(), billingCycleKey: null },
    });
    expect((await authorize(service)).kind).toBe("SAFETY_GUARD_HARD_PAUSE");
    expect(order).toEqual(["lock", "facts", "unlock"]);
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

  it("authorizes against the route policy it was given, and records that policy's version (ADR-0089)", async () => {
    const armed = async (): Promise<ArmResult> => ({ kind: "ARMED", stateVersion: 4 });
    const listing: RoutePolicy = {
      version: "itest-policy.1",
      qualityTiers: ["NORMAL"],
      routes: authorizedRoutes(),
    };
    const withRoute = serviceWith(armed, { routePolicy: listing });
    expect((await authorize(withRoute.service)).kind).toBe("AUTHORIZED");
    expect(withRoute.armedContexts[0]!.metadata).toMatchObject({ routingPolicyVersion: "itest-policy.1" });

    // A policy without the attempt's route refuses it, so the policy given is the one used.
    const without = serviceWith(armed, { routePolicy: { ...listing, routes: [] } });
    expect(await authorize(without.service)).toEqual({
      kind: "ROUTING_NOT_AUTHORIZED",
      reason: "QUALITY_TIER_ROUTE_NOT_AUTHORIZED",
    });
    expect(without.calls.arm).toBe(0);
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

describe("the source the attempt sends (ADR-0096)", () => {
  const armed = async (): Promise<ArmResult> => ({ kind: "ARMED", stateVersion: 4 });

  it("is locked after the gate permits and before the move", async () => {
    const order: string[] = [];
    const { service } = serviceWith(armed, { order });
    expect((await authorize(service)).kind).toBe("AUTHORIZED");
    expect(order.indexOf("source")).toBe(order.indexOf("arm") - 1);
  });

  it("is not locked for an attempt the gate refuses", async () => {
    const order: string[] = [];
    const { service } = serviceWith(armed, { order, cycleYen: null });
    expect((await authorize(service)).kind).toBe("SAFETY_GUARD_HARD_PAUSE");
    expect(order).not.toContain("source");
  });

  it("refuses an asset that is gone, without moving the attempt", async () => {
    const { service, calls } = serviceWith(armed, { source: null });
    expect(await authorize(service)).toEqual({ kind: "SOURCE_INVALID", reason: "ASSET_NOT_FOUND" });
    expect(calls.arm).toBe(0);
  });

  it("refuses an asset whose deletion was asked for", async () => {
    const { service, calls } = serviceWith(armed, {
      source: { ...sameSource(), deletionRequestedAt: new Date("2026-09-09T00:00:00.000Z") },
    });
    expect(await authorize(service)).toEqual({ kind: "SOURCE_INVALID", reason: "ASSET_UNRECOVERABLE" });
    expect(calls.arm).toBe(0);
  });

  it("refuses an asset that is no longer usable, with the classifier's reason", async () => {
    const { service, calls } = serviceWith(armed, {
      source: { ...sameSource(), status: "PROCESSING" },
    });
    expect(await authorize(service)).toEqual({ kind: "SOURCE_INVALID", reason: "ASSET_NOT_READY" });
    expect(calls.arm).toBe(0);
  });

  it("refuses an asset that is no longer the normalized JPEG", async () => {
    const { service, calls } = serviceWith(armed, { source: { ...sameSource(), mimeType: "image/png" } });
    expect(await authorize(service)).toEqual({ kind: "SOURCE_INVALID", reason: "ASSET_FORMAT_UNSUPPORTED" });
    expect(calls.arm).toBe(0);
  });

  it.each([
    ["still reads usable", sameSource()],
    ["is already asked to be deleted", { ...sameSource(), deletionRequestedAt: new Date("2026-09-09T00:00:00.000Z") }],
  ] as const)("refuses an attempt whose Property is deleted, while its photo %s", async (_case, source) => {
    const { service, calls } = serviceWith(armed, { source, propertyDeleted: true });
    expect(await authorize(service)).toEqual({ kind: "SOURCE_INVALID", reason: "PROPERTY_DELETED" });
    expect(calls.arm).toBe(0);
  });

  it.each([
    ["digest", { sha256: "f".repeat(64) }],
    ["storage key", { storageKey: "org/org_svc/p/prop/a/ast_other/normalized.jpg" }],
  ] as const)("refuses a usable asset whose %s is not the one prepared", async (_field, change) => {
    const { service, calls } = serviceWith(armed, { source: { ...sameSource(), ...change } });
    expect(await authorize(service)).toEqual({
      kind: "SOURCE_INVALID",
      reason: "ASSET_SOURCE_CHANGED",
    });
    expect(calls.arm).toBe(0);
  });
});

describe("the paid call's audit entry (ADR-0096)", () => {
  it("is handed to the move, naming the attempt and its job and nothing about the provider", async () => {
    const { service, armedAudits } = serviceWith(async () => ({ kind: "ARMED", stateVersion: 4 }));
    expect((await authorize(service)).kind).toBe("AUTHORIZED");
    expect(armedAudits).toEqual([
      {
        organizationId: "org_svc",
        actorUserId: null,
        action: PAID_SUBMISSION_AUDIT_ACTION,
        resourceType: "scene_generation",
        resourceId: "sgen_svc",
        metadata: {
          generationJobId: "genjob_svc",
          requestKind: "INITIAL",
          pricingSnapshotId: "gps_svc",
          correlationId: "corr_svc",
        },
      },
    ]);
    expect(PAID_SUBMISSION_AUDIT_ACTION).toBe("generation.submission_started");
  });

  it("names the caller's actor", async () => {
    const { service, armedAudits } = serviceWith(async () => ({ kind: "ARMED", stateVersion: 4 }));
    await authorize(service, { ...CONTEXT, actorType: "USER", actorUserId: "usr_operator" });
    expect(armedAudits[0]?.actorUserId).toBe("usr_operator");
  });

  it("names the request's kind", async () => {
    const facts = permittingFacts();
    const { service, armedAudits } = serviceWith(async () => ({ kind: "ARMED", stateVersion: 4 }), {
      facts: {
        ...facts,
        attempt: { ...facts.attempt, requestKind: "USER_REGENERATION", requestUserRegenerationOrdinal: 1 },
      },
    });
    expect((await authorize(service)).kind).toBe("AUTHORIZED");
    expect(armedAudits[0]?.metadata).toMatchObject({ requestKind: "USER_REGENERATION" });
  });
});
