import { describe, expect, it } from "vitest";
import { createPricingSnapshot } from "../pricing/pricing-snapshot";
import { createProviderPricingCatalog } from "../pricing/provider-pricing-catalog";
import type { ProviderPricingContract } from "../pricing/provider-pricing-contract";
import { bps, epochMillisFromDate, microUsd } from "../pricing/units";
import { persistedIntegerToNumber, persistedMicroUsd } from "./persisted-money";
import {
  verifyPersistedPricingSnapshot,
  type PersistedPricingSnapshotFacts,
} from "./pricing-integrity";

/**
 * Whether a persisted cost decision is still the decision it claims to be.
 *
 * The failure this guards against is narrow and expensive: every binding field
 * — provider, model key, contract key, risk profile — agrees perfectly, and the
 * stored amount is a fabrication. Nothing that checks bindings can see that, so
 * these tests corrupt one column at a time and assert that each is caught.
 */

const AT = epochMillisFromDate(new Date("2026-09-05T00:00:00.000Z"));

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

const OPEN_VIDEO_LOOKUP = createProviderPricingCatalog().findByIdentity({
  provider: "wavespeed",
  pricingModelKey: "wavespeed-open-video",
  generationMode: "image-to-video",
  nativeTier: "1080p",
  audioMode: "none",
  durationBillingRuleId: "per-second",
  pricingVersion: "2026-09-02.1",
});
if (OPEN_VIDEO_LOOKUP === undefined) throw new Error("expected the OpenVideo contract");
const OPEN_VIDEO: ProviderPricingContract = OPEN_VIDEO_LOOKUP;

/** The row exactly as admission would have written it. */
function persistedRow(
  overrides: Partial<PersistedPricingSnapshotFacts> = {},
): PersistedPricingSnapshotFacts {
  const derived = createPricingSnapshot({
    contract: H3_MAX,
    riskProfileKey: "NORMAL_AI",
    requestedSeconds: 5,
    pricingEffectiveAt: AT,
    fx: null,
  });
  if (!derived.ok) throw new Error("fixture snapshot must derive");
  const snapshot = derived.value;
  return {
    sceneGenerationId: "sgen_integrity",
    pricingVersion: snapshot.pricingVersion,
    provider: snapshot.provider,
    contractKey: snapshot.contractKey,
    contractFingerprint: snapshot.contractFingerprint,
    identityJson: JSON.parse(JSON.stringify(snapshot.identity)) as unknown,
    stablePriceReferenceJson: JSON.parse(
      JSON.stringify(snapshot.stablePriceReference),
    ) as unknown,
    riskProfileKey: snapshot.riskProfileKey,
    riskBufferBps: snapshot.riskBufferBps,
    requestedSeconds: snapshot.requestedSeconds,
    billableSeconds: snapshot.billableSeconds,
    estimatedStableCostMicroUsd: BigInt(snapshot.estimatedStableCostMicroUsd),
    estimatedPlanningCostMicroUsd: BigInt(snapshot.estimatedPlanningCostMicroUsd),
    pricingEffectiveAtEpochMs: BigInt(snapshot.pricingEffectiveAt),
    fxSnapshotId: null,
    ...overrides,
  };
}

function verify(persisted: PersistedPricingSnapshotFacts, contract = H3_MAX) {
  return verifyPersistedPricingSnapshot({ persisted, contract, fx: null });
}

describe("persisted pricing snapshot integrity", () => {
  it("reproduces an untampered row exactly", () => {
    const result = verify(persistedRow());
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(BigInt(result.snapshot.estimatedPlanningCostMicroUsd)).toBe(
      persistedRow().estimatedPlanningCostMicroUsd,
    );
  });

  it("refuses a tampered planning cost while every binding field still agrees", () => {
    // The whole point. Provider, model, contract key and risk profile are
    // untouched, so nothing that checks bindings notices — and the number that
    // decides how much Safety Guard headroom this attempt consumes is a lie.
    const result = verify(persistedRow({ estimatedPlanningCostMicroUsd: 1n }));
    expect(result).toEqual({ ok: false, reason: "PRICING_SNAPSHOT_NOT_REPRODUCIBLE" });
  });

  it("refuses a tampered stable cost", () => {
    const result = verify(persistedRow({ estimatedStableCostMicroUsd: 999_999n }));
    expect(result).toEqual({ ok: false, reason: "PRICING_SNAPSHOT_NOT_REPRODUCIBLE" });
  });

  it("refuses tampered billable seconds", () => {
    // Duration is what the cost is computed from; a billable figure that no
    // longer follows from the requested one describes a different bill.
    const result = verify(persistedRow({ billableSeconds: 99 }));
    expect(result).toEqual({ ok: false, reason: "PRICING_SNAPSHOT_NOT_REPRODUCIBLE" });
  });

  it("refuses a tampered risk buffer", () => {
    const result = verify(persistedRow({ riskBufferBps: bps(1) }));
    expect(result).toEqual({ ok: false, reason: "PRICING_SNAPSHOT_NOT_REPRODUCIBLE" });
  });

  it("refuses a moved pricing instant", () => {
    // The effective instant is an input to the derivation and a fact about when
    // this decision applied. Moving it silently re-dates the record.
    const result = verify(
      persistedRow({
        pricingEffectiveAtEpochMs: BigInt(
          epochMillisFromDate(new Date("2020-01-01T00:00:00.000Z")),
        ),
      }),
    );
    expect(result).toEqual({ ok: false, reason: "PRICING_SNAPSHOT_NOT_REPRODUCIBLE" });
  });

  it("refuses a tampered stable price reference", () => {
    const result = verify(
      persistedRow({
        stablePriceReferenceJson: { kind: "PER_SECOND", unitPriceMicroUsdPerSecond: 1 },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "PRICING_SNAPSHOT_NOT_REPRODUCIBLE" });
  });

  it("refuses a fingerprint that does not belong to the resolved contract", () => {
    // The case the fingerprint exists for: an identity can be stable while
    // price, verification, duration policy, promotion or effective window
    // changes underneath it. Identity resolution alone would call these the
    // same contract.
    const result = verify(persistedRow({ contractFingerprint: "not-this-contract" }));
    expect(result).toEqual({ ok: false, reason: "PRICING_CONTRACT_FINGERPRINT_MISMATCH" });
  });

  it("refuses when a different contract is resolved for the same row", () => {
    const result = verify(persistedRow(), OPEN_VIDEO);
    expect(result).toEqual({ ok: false, reason: "PRICING_CONTRACT_FINGERPRINT_MISMATCH" });
  });

  it("refuses when no contract resolves at all", () => {
    const result = verifyPersistedPricingSnapshot({
      persisted: persistedRow(),
      contract: null,
      fx: null,
    });
    expect(result).toEqual({ ok: false, reason: "PRICING_CONTRACT_MISSING" });
  });

  it("refuses a risk profile key outside the closed vocabulary", () => {
    const result = verify(persistedRow({ riskProfileKey: "SOMETHING_ELSE" }));
    expect(result).toEqual({ ok: false, reason: "PRICING_SNAPSHOT_NOT_REPRODUCIBLE" });
  });

  it("refuses an unrepresentable persisted amount rather than throwing", () => {
    // `microUsd(Number(huge))` throws `PricingArithmeticError` — an unhandled
    // defect out of an ordinary authorization, which would skip every audit
    // path a refusal takes. This is the check that keeps it a refusal.
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const result = verify(persistedRow({ estimatedPlanningCostMicroUsd: huge }));
    expect(result).toEqual({ ok: false, reason: "PRICING_AMOUNT_UNREPRESENTABLE" });
  });

  it("refuses a tampered identity", () => {
    const result = verify(
      persistedRow({ identityJson: { provider: "fal", pricingModelKey: "something-else" } }),
    );
    expect(result).toEqual({ ok: false, reason: "PRICING_SNAPSHOT_NOT_REPRODUCIBLE" });
  });
});

describe("the persistence-boundary money conversion", () => {
  it("accepts an ordinary amount", () => {
    expect(persistedMicroUsd(80_000n)).toBe(microUsd(80_000));
  });

  it("refuses beyond the safe-integer range in both directions", () => {
    expect(persistedMicroUsd(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBeNull();
    expect(persistedMicroUsd(BigInt(Number.MIN_SAFE_INTEGER) - 1n)).toBeNull();
  });

  it("accepts the exact boundary values", () => {
    // The range check is inclusive; refusing a representable value would fail
    // closed on data that is perfectly fine.
    expect(persistedIntegerToNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(persistedIntegerToNumber(BigInt(Number.MIN_SAFE_INTEGER))).toBe(
      Number.MIN_SAFE_INTEGER,
    );
  });

  it("never throws for a value it cannot represent", () => {
    expect(() => persistedIntegerToNumber(10n ** 30n)).not.toThrow();
    expect(persistedIntegerToNumber(10n ** 30n)).toBeNull();
  });
});
