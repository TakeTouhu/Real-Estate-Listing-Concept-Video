import { describe, expect, it } from "vitest";
import {
  GENERATION_ATTEMPT_STATES,
  GENERATION_RESERVATION_STATES,
  SUBMISSION_CERTAINTIES,
  type GenerationAttemptState,
  type SubmissionCertainty,
} from "../orchestration/types";
import { createProviderPricingCatalog } from "../pricing/provider-pricing-catalog";
import type { ProviderPricingContract } from "../pricing/provider-pricing-contract";
import { safetyGuardThresholds } from "../pricing/safety-guard";
import { epochMillisFromDate, yen, type Yen } from "../pricing/units";
import { evaluatePaidSubmissionGate, type PaidSubmissionGateFacts } from "./gate";
import { H3_MAX_PROVIDER_MODEL_ID } from "./routing";

/**
 * The paid submission gate, as a pure decision.
 *
 * Every test here answers the same question in a different state of the world:
 * may this one attempt cross into `SUBMITTING`? Nothing touches a database and
 * nothing could reach a provider, which is what lets the money-spending rule be
 * exercised exhaustively and cheaply.
 */

const AT = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));

const H3_MAX_LOOKUP = createProviderPricingCatalog().findByIdentity({
  provider: "fal",
  pricingModelKey: "minimax-h3-max",
  generationMode: "image-to-video",
  nativeTier: "768P",
  audioMode: "none",
  durationBillingRuleId: "per-second",
  pricingVersion: "2026-09-02.1",
});
if (H3_MAX_LOOKUP === undefined) throw new Error("expected the H3 Max pricing contract");
const H3_MAX: ProviderPricingContract = H3_MAX_LOOKUP;

/**
 * A world in which authorization succeeds.
 *
 * Standard plan revenue, a modest exposure, a comfortably positive scene: every
 * test below starts here and breaks exactly one thing, so a failure names the
 * rule that fired rather than the fixture that drifted.
 */
function facts(overrides: {
  attempt?: Partial<PaidSubmissionGateFacts["attempt"]>;
  job?: Partial<PaidSubmissionGateFacts["job"]>;
  reservation?: Partial<PaidSubmissionGateFacts["reservation"]> | null;
  pricing?: Partial<PaidSubmissionGateFacts["pricing"]>;
  commercial?: Partial<PaidSubmissionGateFacts["commercial"]>;
} = {}): PaidSubmissionGateFacts {
  const base: PaidSubmissionGateFacts = {
    authorizationInstant: AT,
    attempt: {
      attemptId: "sgen_gate",
      orchestrationState: "QUEUED",
      submissionCertainty: "PRE_SUBMISSION",
      stateVersion: 0,
      generationJobId: "genjob_gate",
      qualityTier: "NORMAL",
      providerName: "fal",
      providerModelId: H3_MAX_PROVIDER_MODEL_ID,
      requestModelKey: "minimax-h3-max",
      requestNativeGenerationResolution: "768P",
      requestTargetOutputResolution: "720p",
      requestDurationSeconds: 5,
      pricingContractKey: "fal:minimax-h3-max:2026-09-02.1",
    },
    job: {
      id: "genjob_gate",
      qualityTier: "NORMAL",
      requiredVideoUnits: 1,
      requiredHighQualityUnits: 0,
    },
    reservation: {
      generationJobId: "genjob_gate",
      state: "RESERVED",
      reservedTotalVideoUnits: 1,
      reservedHighQualityUnits: 0,
    },
    pricing: {
      snapshotBoundToAttempt: true,
      bindingValid: true,
      contract: H3_MAX,
      identityGenerationMode: "image-to-video",
      identityAudioMode: "none",
      plannedCostYen: yen(100),
      fxFailure: null,
    },
    commercial: {
      billingCycleRevenueYen: yen(49_800),
      exposure: {
        knownActualCostYen: yen(0),
        uncertainCostYen: yen(0),
        inFlightCostYen: yen(0),
        nextProjectedCostYen: yen(100),
      },
      sceneRevenueYen: yen(3_320),
    },
  };
  return {
    ...base,
    attempt: { ...base.attempt, ...overrides.attempt },
    job: { ...base.job, ...overrides.job },
    reservation:
      overrides.reservation === null
        ? null
        : { ...base.reservation!, ...(overrides.reservation ?? {}) },
    pricing: { ...base.pricing, ...overrides.pricing },
    commercial: { ...base.commercial, ...overrides.commercial },
  };
}

describe("the paid submission gate", () => {
  it("permits exactly the one shape that may cross the boundary", () => {
    const decision = evaluatePaidSubmissionGate(facts());
    if (decision.kind !== "PERMITTED") {
      throw new Error(`expected PERMITTED, got ${JSON.stringify(decision.outcome)}`);
    }
    expect(decision.attemptId).toBe("sgen_gate");
    // The version the CAS must name. Carrying it out of the decision is what
    // makes the arm a compare-and-set against the state that was evaluated.
    expect(decision.expectedStateVersion).toBe(0);
    expect(decision.safetyGuardWarning).toBeNull();
  });

  describe("attempt state and certainty", () => {
    const nonQueued = GENERATION_ATTEMPT_STATES.filter((s) => s !== "QUEUED");

    it.each(nonQueued.map((s) => [s] as const))(
      "refuses an attempt in %s",
      (orchestrationState: GenerationAttemptState) => {
        const decision = evaluatePaidSubmissionGate(facts({ attempt: { orchestrationState } }));
        if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
        expect(decision.outcome.kind).toBe("ATTEMPT_NOT_ARMABLE");
      },
    );

    it("covers every attempt state exactly once", () => {
      // The armable set is a single state, and this is what keeps it that way:
      // a new state added to the vocabulary lands here rather than inheriting
      // whichever branch happened to be last.
      expect(nonQueued.length).toBe(GENERATION_ATTEMPT_STATES.length - 1);
      expect(GENERATION_ATTEMPT_STATES).toContain("QUEUED");
    });

    const nonPreSubmission = SUBMISSION_CERTAINTIES.filter((c) => c !== "PRE_SUBMISSION");

    it.each(nonPreSubmission.map((c) => [c] as const))(
      "refuses certainty %s",
      (submissionCertainty: SubmissionCertainty) => {
        const decision = evaluatePaidSubmissionGate(facts({ attempt: { submissionCertainty } }));
        if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
        expect(decision.outcome.kind).toBe("ATTEMPT_NOT_ARMABLE");
      },
    );

    it("never re-arms an attempt whose submission is unknown", () => {
      // The invariant the whole gate exists to protect. The provider may
      // already have been paid and nothing local can establish that it was not,
      // so a second POST is the one mistake that cannot be undone.
      const decision = evaluatePaidSubmissionGate(
        facts({ attempt: { submissionCertainty: "SUBMISSION_UNKNOWN" } }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "ATTEMPT_NOT_ARMABLE",
        reason: "ATTEMPT_SUBMISSION_UNCERTAIN",
      });
    });

    it("refuses a stale SUBMITTING rather than treating it as a retry", () => {
      // Recovery is a later reconciliation phase. A row that has been sitting
      // in SUBMITTING for a week is not evidence that nothing was sent.
      const decision = evaluatePaidSubmissionGate(
        facts({ attempt: { orchestrationState: "SUBMITTING" } }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "ATTEMPT_NOT_ARMABLE",
        reason: "ATTEMPT_ALREADY_SUBMITTED",
      });
    });

    it.each([
      ["requestModelKey"],
      ["requestNativeGenerationResolution"],
      ["requestTargetOutputResolution"],
      ["requestDurationSeconds"],
      ["pricingContractKey"],
    ] as const)("refuses when %s is absent", (field) => {
      const decision = evaluatePaidSubmissionGate(facts({ attempt: { [field]: null } }));
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "ATTEMPT_NOT_ARMABLE",
        reason: "ATTEMPT_FACTS_INCOMPLETE",
      });
    });
  });

  describe("reservation", () => {
    it("refuses when no reservation exists", () => {
      const decision = evaluatePaidSubmissionGate(facts({ reservation: null }));
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "RESERVATION_INVALID",
        reason: "RESERVATION_MISSING",
      });
    });

    const nonReserved = GENERATION_RESERVATION_STATES.filter((s) => s !== "RESERVED");

    it.each(nonReserved.map((s) => [s] as const))("refuses a %s reservation", (state) => {
      const decision = evaluatePaidSubmissionGate(facts({ reservation: { state } }));
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome.kind).toBe("RESERVATION_INVALID");
    });

    it("names RECONCILIATION_HOLD specifically", () => {
      // A hold exists because an earlier submission's fate is unresolved.
      // Spending against it now would commit units that may already be owed.
      const decision = evaluatePaidSubmissionGate(
        facts({ reservation: { state: "RECONCILIATION_HOLD" } }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "RESERVATION_INVALID",
        reason: "RESERVATION_ON_RECONCILIATION_HOLD",
      });
    });

    it("refuses a reservation belonging to another job", () => {
      const decision = evaluatePaidSubmissionGate(
        facts({ reservation: { generationJobId: "genjob_someone_else" } }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "RESERVATION_INVALID",
        reason: "RESERVATION_JOB_MISMATCH",
      });
    });

    it("refuses an under-reserved job", () => {
      const decision = evaluatePaidSubmissionGate(
        facts({ job: { requiredVideoUnits: 3 }, reservation: { reservedTotalVideoUnits: 1 } }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "RESERVATION_INVALID",
        reason: "RESERVATION_UNDER_RESERVED",
      });
    });

    it("requires the high-quality figure to match in both directions", () => {
      // High quality marks units already reserved; it never adds any. A hold
      // claiming more or fewer than the job requires is incoherent either way.
      const tooMany = evaluatePaidSubmissionGate(
        facts({ reservation: { reservedHighQualityUnits: 1 } }),
      );
      if (tooMany.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(tooMany.outcome).toEqual({
        kind: "RESERVATION_INVALID",
        reason: "RESERVATION_HIGH_QUALITY_MISMATCH",
      });

      const tooFew = evaluatePaidSubmissionGate(
        facts({
          job: { qualityTier: "HIGH_QUALITY", requiredHighQualityUnits: 1 },
          reservation: { reservedHighQualityUnits: 0 },
        }),
      );
      if (tooFew.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(tooFew.outcome).toEqual({
        kind: "RESERVATION_INVALID",
        reason: "RESERVATION_HIGH_QUALITY_MISMATCH",
      });
    });
  });

  describe("pricing", () => {
    it("refuses a snapshot bound to a different attempt", () => {
      const decision = evaluatePaidSubmissionGate(
        facts({ pricing: { snapshotBoundToAttempt: false } }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_SNAPSHOT_NOT_FOR_ATTEMPT",
      });
    });

    it("refuses a snapshot whose binding no longer holds", () => {
      // Defence in depth. Admission checked this and so does the boundary; a
      // row corrupted between them must not buy a provider call.
      const decision = evaluatePaidSubmissionGate(facts({ pricing: { bindingValid: false } }));
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_SNAPSHOT_BINDING_INVALID",
      });
    });

    it("refuses a missing contract", () => {
      const decision = evaluatePaidSubmissionGate(facts({ pricing: { contract: null } }));
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_CONTRACT_MISSING",
      });
    });

    it("refuses a promotion-only contract", () => {
      // When the discount ends there is no verified price to fall back to, so
      // the platform would have committed to work it cannot cost afterwards.
      const promotionalOnly = { ...H3_MAX, stable: { ...H3_MAX.stable, rule: null } };
      const decision = evaluatePaidSubmissionGate(
        facts({ pricing: { contract: promotionalOnly } }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_CONTRACT_PROMOTIONAL_ONLY",
      });
    });

    it("refuses an expired stable verification", () => {
      const expired = {
        ...H3_MAX,
        stable: { ...H3_MAX.stable, verification: "EXPIRED" as const },
      };
      const decision = evaluatePaidSubmissionGate(facts({ pricing: { contract: expired } }));
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_CONTRACT_EXPIRED",
      });
    });

    it("refuses an unverified contract", () => {
      const unverified = {
        ...H3_MAX,
        stable: { ...H3_MAX.stable, verification: "UNVERIFIED" as const },
      };
      const decision = evaluatePaidSubmissionGate(facts({ pricing: { contract: unverified } }));
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_CONTRACT_UNVERIFIED",
      });
    });

    it("stays eligible when a verified promotion sits beside the stable rule", () => {
      // A live promotion does not make a contract ineligible, and it does not
      // become the planning basis either — the cost carried here is the one
      // derived from the stable rule, and this proves the promotion changed
      // nothing about the decision.
      const withPromotion = {
        ...H3_MAX,
        promotion: {
          verification: "VERIFIED_STABLE" as const,
          rule: { kind: "PER_SECOND" as const, unitPriceMicroUsdPerSecond: 20_000 as never },
          effectiveFrom: epochMillisFromDate(new Date("2026-09-01T00:00:00.000Z")),
          effectiveUntil: null,
        },
      };
      const decision = evaluatePaidSubmissionGate(
        facts({ pricing: { contract: withPromotion as never } }),
      );
      expect(decision.kind).toBe("PERMITTED");
    });

    it.each([
      ["MISSING", "PRICING_FX_SNAPSHOT_MISSING"],
      ["INVALID", "PRICING_FX_SNAPSHOT_INVALID"],
    ] as const)("fails closed when the FX snapshot is %s", (fxFailure, reason) => {
      const decision = evaluatePaidSubmissionGate(
        facts({ pricing: { fxFailure, plannedCostYen: null } }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({ kind: "PRICING_INELIGIBLE", reason });
    });
  });

  describe("profitability", () => {
    it("refuses negative worst-case unit economics", () => {
      // Three paid attempts at ¥2,000 against ¥3,320 of scene revenue loses
      // money for any customer who uses what they were sold.
      const decision = evaluatePaidSubmissionGate(
        facts({
          pricing: { plannedCostYen: yen(2_000) },
          commercial: {
            sceneRevenueYen: yen(3_320),
            exposure: {
              knownActualCostYen: yen(0),
              uncertainCostYen: yen(0),
              inFlightCostYen: yen(0),
              nextProjectedCostYen: yen(2_000),
            },
          },
        }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "PROFITABILITY_REJECTED",
        reason: "NEGATIVE_WORST_CASE_UNIT_ECONOMICS",
      });
    });

    it("permits a thin but positive margin", () => {
      // 3 × ¥1,000 against ¥3,320 is a 9.6% contribution margin — far below the
      // 70% internal floor and 75% target, and explicitly NOT a reason to deny
      // a customer work they already bought. The margin target is a pricing
      // review, never a generation block.
      const decision = evaluatePaidSubmissionGate(
        facts({
          pricing: { plannedCostYen: yen(1_000) },
          commercial: {
            sceneRevenueYen: yen(3_320),
            exposure: {
              knownActualCostYen: yen(0),
              uncertainCostYen: yen(0),
              inFlightCostYen: yen(0),
              nextProjectedCostYen: yen(1_000),
            },
          },
        }),
      );
      expect(decision.kind).toBe("PERMITTED");
    });

    it("permits exact break-even", () => {
      // Break-even is not a loss. Refusing it would be a different rule than the
      // one that was frozen, and the boundary is where a mutation would hide.
      const decision = evaluatePaidSubmissionGate(
        facts({
          pricing: { plannedCostYen: yen(1_000) },
          commercial: {
            sceneRevenueYen: yen(3_000),
            exposure: {
              knownActualCostYen: yen(0),
              uncertainCostYen: yen(0),
              inFlightCostYen: yen(0),
              nextProjectedCostYen: yen(1_000),
            },
          },
        }),
      );
      expect(decision.kind).toBe("PERMITTED");
    });

    it("prices the worst case at three paid attempts, not one", () => {
      // A single attempt at ¥1,500 is comfortably profitable against ¥3,320;
      // the three the entitlement sells are not. Planning against one is how a
      // product looks profitable while every customer who uses their rights
      // loses money.
      const decision = evaluatePaidSubmissionGate(
        facts({
          pricing: { plannedCostYen: yen(1_500) },
          commercial: {
            sceneRevenueYen: yen(3_320),
            exposure: {
              knownActualCostYen: yen(0),
              uncertainCostYen: yen(0),
              inFlightCostYen: yen(0),
              nextProjectedCostYen: yen(1_500),
            },
          },
        }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome.kind).toBe("PROFITABILITY_REJECTED");
    });
  });

  describe("safety guard", () => {
    /** Exposure that leaves the cycle at exactly `profit`. */
    function atProfit(revenue: Yen, profit: Yen, candidate: Yen) {
      const others = revenue - profit - candidate;
      return {
        billingCycleRevenueYen: revenue,
        exposure: {
          knownActualCostYen: yen(0),
          uncertainCostYen: yen(0),
          inFlightCostYen: yen(others),
          nextProjectedCostYen: candidate,
        },
      };
    }

    const STANDARD = yen(49_800);
    const thresholds = safetyGuardThresholds(STANDARD);

    it("derives the Standard plan's published thresholds from the formula", () => {
      // ¥20,000 and ¥15,000 are consequences of max(absolute, revenue × share),
      // not a hard-coded table: 25% and 20% of ¥49,800 are both lower.
      expect(thresholds.warningFloorYen).toBe(20_000);
      expect(thresholds.hardPauseFloorYen).toBe(15_000);
    });

    it("permits comfortably above the warning floor", () => {
      const decision = evaluatePaidSubmissionGate(
        facts({ commercial: atProfit(STANDARD, yen(40_000), yen(100)) }),
      );
      if (decision.kind !== "PERMITTED") throw new Error("expected PERMITTED");
      expect(decision.safetyGuardWarning).toBeNull();
    });

    it("permits at exactly the warning floor", () => {
      // Strictly below, never at-or-below. The floor is the last acceptable
      // value, not the first unacceptable one — one character of source and a
      // whole customer's service in effect.
      const decision = evaluatePaidSubmissionGate(
        facts({ commercial: atProfit(STANDARD, yen(20_000), yen(100)) }),
      );
      if (decision.kind !== "PERMITTED") throw new Error("expected PERMITTED");
      expect(decision.safetyGuardWarning).toBeNull();
    });

    it("permits inside the warning band and surfaces the decision", () => {
      // WARNING is not a customer-generation block, and it is not swallowed
      // either: authorization continues carrying the decision out with it.
      const decision = evaluatePaidSubmissionGate(
        facts({ commercial: atProfit(STANDARD, yen(19_999), yen(100)) }),
      );
      if (decision.kind !== "PERMITTED") throw new Error("expected PERMITTED");
      expect(decision.safetyGuardWarning?.state).toBe("WARNING");
    });

    it("permits at exactly the hard-pause floor", () => {
      const decision = evaluatePaidSubmissionGate(
        facts({ commercial: atProfit(STANDARD, yen(15_000), yen(100)) }),
      );
      if (decision.kind !== "PERMITTED") throw new Error("expected PERMITTED");
      expect(decision.safetyGuardWarning?.state).toBe("WARNING");
    });

    it("refuses one yen below the hard-pause floor", () => {
      const decision = evaluatePaidSubmissionGate(
        facts({ commercial: atProfit(STANDARD, yen(14_999), yen(100)) }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toMatchObject({
        kind: "SAFETY_GUARD_HARD_PAUSE",
        reason: "HARD_PAUSE_PROJECTED_PROFIT_BELOW_FLOOR",
      });
    });

    it("counts the candidate's own projected cost", () => {
      // Excluding the attempt being authorized is exactly how two concurrent
      // decisions each look affordable and jointly are not.
      const withoutCandidate = evaluatePaidSubmissionGate(
        facts({ commercial: atProfit(STANDARD, yen(15_100), yen(0)) }),
      );
      expect(withoutCandidate.kind).toBe("PERMITTED");

      const withCandidate = evaluatePaidSubmissionGate(
        facts({
          commercial: {
            billingCycleRevenueYen: STANDARD,
            exposure: {
              knownActualCostYen: yen(0),
              uncertainCostYen: yen(0),
              inFlightCostYen: yen(34_700),
              nextProjectedCostYen: yen(200),
            },
          },
        }),
      );
      if (withCandidate.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(withCandidate.outcome.kind).toBe("SAFETY_GUARD_HARD_PAUSE");
    });

    it("counts uncertain exposure", () => {
      // An attempt whose acceptance is unresolved may already have been billed.
      // Treating it as zero because nobody confirmed it is the expensive
      // direction to be wrong in.
      const decision = evaluatePaidSubmissionGate(
        facts({
          commercial: {
            billingCycleRevenueYen: STANDARD,
            exposure: {
              knownActualCostYen: yen(0),
              uncertainCostYen: yen(34_800),
              inFlightCostYen: yen(0),
              nextProjectedCostYen: yen(100),
            },
          },
        }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome.kind).toBe("SAFETY_GUARD_HARD_PAUSE");
    });

    it("counts in-flight exposure", () => {
      const decision = evaluatePaidSubmissionGate(
        facts({
          commercial: {
            billingCycleRevenueYen: STANDARD,
            exposure: {
              knownActualCostYen: yen(0),
              uncertainCostYen: yen(0),
              inFlightCostYen: yen(34_800),
              nextProjectedCostYen: yen(100),
            },
          },
        }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome.kind).toBe("SAFETY_GUARD_HARD_PAUSE");
    });

    it("refuses when no authoritative billing-cycle revenue exists", () => {
      // Zero revenue would make every threshold the absolute floor and quietly
      // authorize against a number nobody published.
      const decision = evaluatePaidSubmissionGate(
        facts({ commercial: { billingCycleRevenueYen: null } }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toMatchObject({
        kind: "SAFETY_GUARD_HARD_PAUSE",
        reason: "BILLING_CYCLE_REVENUE_UNAVAILABLE",
      });
    });

    it("scales thresholds with plan revenue rather than reading a table", () => {
      // Premium's ¥29,950 / ¥23,960 are 25% and 20% of ¥119,800.
      const premium = safetyGuardThresholds(yen(119_800));
      expect(premium.warningFloorYen).toBe(29_950);
      expect(premium.hardPauseFloorYen).toBe(23_960);
      const enterprise = safetyGuardThresholds(yen(298_000));
      expect(enterprise.warningFloorYen).toBe(74_500);
      expect(enterprise.hardPauseFloorYen).toBe(59_600);
    });
  });

  describe("routing", () => {
    it("refuses a provider the route does not authorize", () => {
      const decision = evaluatePaidSubmissionGate(
        facts({ attempt: { providerName: "openai" } }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "ROUTING_NOT_AUTHORIZED",
        reason: "PROVIDER_NOT_AUTHORIZED",
      });
    });

    it("refuses a provider model id the route does not authorize", () => {
      const decision = evaluatePaidSubmissionGate(
        facts({ attempt: { providerModelId: "minimax/h3/image-to-video" } }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "ROUTING_NOT_AUTHORIZED",
        reason: "PROVIDER_MODEL_ID_NOT_AUTHORIZED",
      });
    });

    it("refuses a model key the route does not authorize", () => {
      const decision = evaluatePaidSubmissionGate(
        facts({ attempt: { requestModelKey: "minimax-h3" } }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "ROUTING_NOT_AUTHORIZED",
        reason: "MODEL_KEY_NOT_AUTHORIZED",
      });
    });

    it("refuses a native tier the route does not generate at", () => {
      const decision = evaluatePaidSubmissionGate(
        facts({ attempt: { requestNativeGenerationResolution: "1080p" } }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "ROUTING_NOT_AUTHORIZED",
        reason: "NATIVE_TIER_NOT_AUTHORIZED",
      });
    });

    it("refuses an unauthorized generation mode", () => {
      const decision = evaluatePaidSubmissionGate(
        facts({ pricing: { identityGenerationMode: "text-to-video" } }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "ROUTING_NOT_AUTHORIZED",
        reason: "GENERATION_MODE_NOT_AUTHORIZED",
      });
    });

    it("refuses an audio-enabled identity", () => {
      const decision = evaluatePaidSubmissionGate(
        facts({ pricing: { identityAudioMode: "on" } }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "ROUTING_NOT_AUTHORIZED",
        reason: "AUDIO_MODE_NOT_AUTHORIZED",
      });
    });

    it("refuses HIGH_QUALITY: no route is authorized for it", () => {
      // Veo 3.1 Fast is benchmark-gated and has no adapter. Authorizing the
      // route would send an attempt to a boundary with nothing behind it.
      const decision = evaluatePaidSubmissionGate(
        facts({
          job: { qualityTier: "HIGH_QUALITY", requiredHighQualityUnits: 1 },
          reservation: { reservedHighQualityUnits: 1 },
        }),
      );
      if (decision.kind !== "REFUSED") throw new Error("expected REFUSED");
      expect(decision.outcome).toEqual({
        kind: "ROUTING_NOT_AUTHORIZED",
        reason: "QUALITY_TIER_ROUTE_NOT_AUTHORIZED",
      });
    });

    it("authorizes 1080p on the H3 Max route, still generated at 768P", () => {
      // Target resolution and native generation resolution are independent.
      // 1080p is served by upscaling the same 768P generation, and the route
      // says so rather than claiming a native 1080p H3 Max does not have.
      const decision = evaluatePaidSubmissionGate(
        facts({ attempt: { requestTargetOutputResolution: "1080p" } }),
      );
      expect(decision.kind).toBe("PERMITTED");
    });
  });
});
