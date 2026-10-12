import { describe, expect, it } from "vitest";
import type { GenerationQualityTier, GenerationReservationState } from "../orchestration/types";
import {
  allocationSettlement,
  EntitlementLedgerDefect,
  frozenFundingCoversReservation,
  occupiesEntitlement,
  periodEntitlementBalance,
  planUnitAllocation,
  type AddOnBlockGrant,
  type ExistingAllocation,
  type PeriodEntitlementBalance,
} from "./allocation";
import { entitlementSnapshotForPlan } from "./plan-entitlement";

/**
 * The Unit ledger's arithmetic, against the approved contract (ADR-0053
 * Decisions 1–3 and the CTO's multi-Unit funding decision).
 *
 * Every expected allocation is written out literally. A test that recomputed it
 * with the production rule would agree with whatever the rule says, including
 * after it changes.
 */

const T0 = Date.UTC(2026, 9, 1);
const day = (n: number) => T0 + n * 86_400_000;

function block(
  id: string,
  quality: GenerationQualityTier,
  quantity: number,
  purchasedAtEpochMs: number,
): AddOnBlockGrant {
  return { id, quality, quantity, purchasedAtEpochMs };
}

function used(
  quantity: number,
  options: {
    quality?: GenerationQualityTier;
    block?: string;
    state?: GenerationReservationState;
  } = {},
): ExistingAllocation {
  return {
    sourceType: options.block === undefined ? "BASE" : "ADD_ON_BLOCK",
    addOnBlockId: options.block ?? null,
    quality: options.quality ?? "NORMAL",
    quantity,
    reservationState: options.state ?? "RESERVED",
  };
}

function balanceOf(
  planKey: "standard" | "premium" | "enterprise",
  blocks: readonly AddOnBlockGrant[] = [],
  allocations: readonly ExistingAllocation[] = [],
): PeriodEntitlementBalance {
  const snapshot = entitlementSnapshotForPlan(planKey);
  return periodEntitlementBalance({
    plan: {
      baseUnits: snapshot.baseUnits,
      includedHighQualityUnits: snapshot.includedHighQualityUnits,
    },
    blocks,
    allocations,
  });
}

function plan(quality: GenerationQualityTier, units: number, balance: PeriodEntitlementBalance) {
  return planUnitAllocation({ quality, units, balance });
}

function allocationsOf(result: ReturnType<typeof plan>) {
  if (!result.ok) throw new Error(`expected an allocation, got ${result.reason}`);
  return result.allocations.map((a) => [a.sourceType, a.addOnBlockId, a.quality, a.quantity]);
}

describe("base entitlement per plan", () => {
  it.each([
    ["standard", 15, 1, false],
    ["premium", 40, 5, true],
    ["enterprise", 100, 10, true],
  ] as const)("%s: %i Base Units, HQ ceiling %i inside them", (key, base, hq, hqAddOn) => {
    const snapshot = entitlementSnapshotForPlan(key);
    expect(snapshot.baseUnits).toBe(base);
    expect(snapshot.includedHighQualityUnits).toBe(hq);
    expect(snapshot.highQualityAddOnAvailable).toBe(hqAddOn);

    const fresh = balanceOf(key);
    expect(fresh.baseRemainingUnits).toBe(base);
    // The ceiling is a limit inside the pool, not Units beside it.
    expect(fresh.includedHighQualityRemainingUnits).toBe(hq);
  });

  it("a whole period's Base Units can be drawn and no more", () => {
    const full = balanceOf("standard", [], [used(15)]);
    expect(full.baseRemainingUnits).toBe(0);
    const refused = plan("NORMAL", 1, full);
    expect(refused).toEqual({ ok: false, reason: "INSUFFICIENT_ENTITLEMENT", eligibleUnits: 0 });
  });
});

describe("the included HQ ceiling sits inside the Base pool", () => {
  it.each([
    ["standard", 1],
    ["premium", 5],
    ["enterprise", 10],
  ] as const)("%s funds exactly %i HQ Units from Base", (key, ceiling) => {
    const exactly = plan("HIGH_QUALITY", ceiling, balanceOf(key));
    expect(allocationsOf(exactly)).toEqual([["BASE", null, "HIGH_QUALITY", ceiling]]);
    const over = plan("HIGH_QUALITY", ceiling + 1, balanceOf(key));
    expect(over).toEqual({ ok: false, reason: "INSUFFICIENT_ENTITLEMENT", eligibleUnits: ceiling });
  });

  it("counts an HQ Base draw against both the pool and the ceiling", () => {
    const after = balanceOf("premium", [], [used(5, { quality: "HIGH_QUALITY" })]);
    expect(after.baseRemainingUnits).toBe(35);
    expect(after.includedHighQualityRemainingUnits).toBe(0);
  });

  it("does not count a Normal Base draw against the ceiling", () => {
    const after = balanceOf("premium", [], [used(10)]);
    expect(after.baseRemainingUnits).toBe(30);
    expect(after.includedHighQualityRemainingUnits).toBe(5);
  });

  it("leaves remaining Base Units for Normal work once the ceiling is spent", () => {
    // Premium, all 5 HQ Base Units used: 35 Base Units remain, all Normal-only.
    const after = balanceOf("premium", [], [used(5, { quality: "HIGH_QUALITY" })]);
    expect(plan("HIGH_QUALITY", 1, after)).toEqual({
      ok: false,
      reason: "INSUFFICIENT_ENTITLEMENT",
      eligibleUnits: 0,
    });
    expect(allocationsOf(plan("NORMAL", 3, after))).toEqual([["BASE", null, "NORMAL", 3]]);
  });

  it("limits HQ by the Base Units left when they are fewer than the ceiling", () => {
    // 38 Normal Units spent leaves 2 Base Units; the ceiling of 5 cannot raise that.
    const after = balanceOf("premium", [], [used(38)]);
    expect(after.includedHighQualityRemainingUnits).toBe(5);
    expect(plan("HIGH_QUALITY", 3, after)).toEqual({
      ok: false,
      reason: "INSUFFICIENT_ENTITLEMENT",
      eligibleUnits: 2,
    });
  });
});

describe("eligibility-first allocation across a multi-Unit job", () => {
  it("funds 3 Normal Units as Base 2 + Normal add-on 1", () => {
    const balance = balanceOf("premium", [block("blk_n", "NORMAL", 10, day(1))], [used(38)]);
    expect(allocationsOf(plan("NORMAL", 3, balance))).toEqual([
      ["BASE", null, "NORMAL", 2],
      ["ADD_ON_BLOCK", "blk_n", "NORMAL", 1],
    ]);
  });

  it("uses partial Base capacity before any add-on, never skipping it", () => {
    // One Base Unit left and a block that could cover everything: Base still goes first.
    const balance = balanceOf("premium", [block("blk_n", "NORMAL", 10, day(1))], [used(39)]);
    expect(allocationsOf(plan("NORMAL", 3, balance))).toEqual([
      ["BASE", null, "NORMAL", 1],
      ["ADD_ON_BLOCK", "blk_n", "NORMAL", 2],
    ]);
  });

  it("spans several Normal blocks, oldest first, once Base is exhausted", () => {
    const balance = balanceOf(
      "premium",
      [
        block("blk_newest", "NORMAL", 10, day(3)),
        block("blk_oldest", "NORMAL", 1, day(1)),
        block("blk_middle", "NORMAL", 1, day(2)),
      ],
      [used(40)],
    );
    expect(allocationsOf(plan("NORMAL", 3, balance))).toEqual([
      ["ADD_ON_BLOCK", "blk_oldest", "NORMAL", 1],
      ["ADD_ON_BLOCK", "blk_middle", "NORMAL", 1],
      ["ADD_ON_BLOCK", "blk_newest", "NORMAL", 1],
    ]);
  });

  it("funds 2 HQ Units as remaining Base HQ 1 + HQ add-on 1", () => {
    // Premium with 1 Base HQ left inside the ceiling and a +2 HQ block.
    const balance = balanceOf(
      "premium",
      [block("blk_hq", "HIGH_QUALITY", 2, day(1))],
      [used(4, { quality: "HIGH_QUALITY" }), used(35)],
    );
    expect(balance.baseRemainingUnits).toBe(1);
    expect(balance.includedHighQualityRemainingUnits).toBe(1);
    expect(allocationsOf(plan("HIGH_QUALITY", 2, balance))).toEqual([
      ["BASE", null, "HIGH_QUALITY", 1],
      ["ADD_ON_BLOCK", "blk_hq", "HIGH_QUALITY", 1],
    ]);
  });

  it("spans several HQ blocks, oldest first, once the ceiling is spent", () => {
    const balance = balanceOf(
      "enterprise",
      [block("blk_hq2", "HIGH_QUALITY", 5, day(2)), block("blk_hq1", "HIGH_QUALITY", 1, day(1))],
      [used(10, { quality: "HIGH_QUALITY" })],
    );
    expect(allocationsOf(plan("HIGH_QUALITY", 3, balance))).toEqual([
      ["ADD_ON_BLOCK", "blk_hq1", "HIGH_QUALITY", 1],
      ["ADD_ON_BLOCK", "blk_hq2", "HIGH_QUALITY", 2],
    ]);
  });

  it("skips an older HQ block for a Normal request", () => {
    // ADR-0053 Decision 3, case 2: older HQ block, newer Normal block, Normal request.
    const balance = balanceOf(
      "premium",
      [block("blk_hq_old", "HIGH_QUALITY", 2, day(1)), block("blk_n_new", "NORMAL", 10, day(2))],
      [used(40)],
    );
    expect(allocationsOf(plan("NORMAL", 2, balance))).toEqual([
      ["ADD_ON_BLOCK", "blk_n_new", "NORMAL", 2],
    ]);
  });

  it("skips an older Normal block for an HQ request", () => {
    // ADR-0053 Decision 3, case 1: older Normal block, newer HQ block, HQ request.
    const balance = balanceOf(
      "premium",
      [block("blk_n_old", "NORMAL", 10, day(1)), block("blk_hq_new", "HIGH_QUALITY", 2, day(2))],
      [used(5, { quality: "HIGH_QUALITY" })],
    );
    expect(allocationsOf(plan("HIGH_QUALITY", 2, balance))).toEqual([
      ["ADD_ON_BLOCK", "blk_hq_new", "HIGH_QUALITY", 2],
    ]);
  });

  it("never reinterprets Normal add-ons as generic Units for HQ", () => {
    // ADR-0053 Decision 3, case 3: Standard, HQ ceiling spent, Normal add-ons left.
    const balance = balanceOf(
      "standard",
      [block("blk_n", "NORMAL", 5, day(1))],
      [used(1, { quality: "HIGH_QUALITY" })],
    );
    expect(plan("HIGH_QUALITY", 1, balance)).toEqual({
      ok: false,
      reason: "INSUFFICIENT_ENTITLEMENT",
      eligibleUnits: 0,
    });
  });

  it("never spends an HQ block on a Normal request, even with nothing else left", () => {
    const balance = balanceOf("premium", [block("blk_hq", "HIGH_QUALITY", 2, day(1))], [used(40)]);
    expect(plan("NORMAL", 1, balance)).toEqual({
      ok: false,
      reason: "INSUFFICIENT_ENTITLEMENT",
      eligibleUnits: 0,
    });
  });

  it("orders blocks bought at the same instant by id, deterministically", () => {
    const balance = balanceOf(
      "premium",
      [block("blk_b", "NORMAL", 1, day(1)), block("blk_a", "NORMAL", 1, day(1))],
      [used(40)],
    );
    expect(allocationsOf(plan("NORMAL", 1, balance))).toEqual([
      ["ADD_ON_BLOCK", "blk_a", "NORMAL", 1],
    ]);
  });

  it("passes over a spent older block to the next eligible one", () => {
    const balance = balanceOf(
      "premium",
      [block("blk_old", "NORMAL", 2, day(1)), block("blk_new", "NORMAL", 10, day(2))],
      [used(40), used(2, { block: "blk_old" })],
    );
    expect(allocationsOf(plan("NORMAL", 2, balance))).toEqual([
      ["ADD_ON_BLOCK", "blk_new", "NORMAL", 2],
    ]);
  });
});

describe("Standard HQ beyond its single included Unit", () => {
  it.each([2, 3])("cannot fund a %i-Unit HQ job, with no Normal fallback", (units) => {
    const balance = balanceOf("standard", [block("blk_n", "NORMAL", 5, day(1))]);
    expect(plan("HIGH_QUALITY", units, balance)).toEqual({
      ok: false,
      reason: "INSUFFICIENT_ENTITLEMENT",
      eligibleUnits: 1,
    });
  });
});

describe("all or nothing", () => {
  it("plans nothing when the eligible total is short, and says how short", () => {
    const balance = balanceOf("premium", [block("blk_n", "NORMAL", 1, day(1))], [used(39)]);
    // 1 Base + 1 block = 2 eligible, 3 required.
    expect(plan("NORMAL", 3, balance)).toEqual({
      ok: false,
      reason: "INSUFFICIENT_ENTITLEMENT",
      eligibleUnits: 2,
    });
  });

  it("succeeds at exactly the eligible total", () => {
    const balance = balanceOf("premium", [block("blk_n", "NORMAL", 1, day(1))], [used(38)]);
    expect(allocationsOf(plan("NORMAL", 3, balance))).toEqual([
      ["BASE", null, "NORMAL", 2],
      ["ADD_ON_BLOCK", "blk_n", "NORMAL", 1],
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses a non-positive or fractional quantity: %s", (units) => {
    expect(() => plan("NORMAL", units, balanceOf("premium"))).toThrow(EntitlementLedgerDefect);
  });
});

describe("settlement is read from the reservation, exactly once", () => {
  it.each([
    ["RESERVING", "HELD", true],
    ["RESERVED", "HELD", true],
    ["RECONCILIATION_HOLD", "HELD", true],
    ["CONSUMED", "CONSUMED", true],
    ["RELEASED", "RELEASED", false],
  ] as const)("%s → %s, occupies entitlement: %s", (state, settlement, occupies) => {
    expect(allocationSettlement(state)).toBe(settlement);
    expect(occupiesEntitlement(state)).toBe(occupies);
  });

  it("returns a released reservation's Units to Base, ceiling and block alike", () => {
    const blocks = [block("blk_hq", "HIGH_QUALITY", 2, day(1))];
    const held = balanceOf("premium", blocks, [
      used(5, { quality: "HIGH_QUALITY" }),
      used(2, { quality: "HIGH_QUALITY", block: "blk_hq" }),
    ]);
    expect([held.baseRemainingUnits, held.includedHighQualityRemainingUnits]).toEqual([35, 0]);
    expect(held.blocks[0]?.remainingUnits).toBe(0);

    const released = balanceOf("premium", blocks, [
      used(5, { quality: "HIGH_QUALITY", state: "RELEASED" }),
      used(2, { quality: "HIGH_QUALITY", block: "blk_hq", state: "RELEASED" }),
    ]);
    expect([released.baseRemainingUnits, released.includedHighQualityRemainingUnits]).toEqual([
      40, 5,
    ]);
    expect(released.blocks[0]?.remainingUnits).toBe(2);
  });

  it("keeps a consumed reservation's Units spent", () => {
    const consumed = balanceOf("standard", [], [used(3, { state: "CONSUMED" })]);
    expect(consumed.baseRemainingUnits).toBe(12);
  });
});

describe("ledger defects fail closed", () => {
  it("refuses an allocation naming a block the period does not hold", () => {
    expect(() => balanceOf("premium", [], [used(1, { block: "blk_elsewhere" })])).toThrow(
      /ALLOCATION_NAMES_UNKNOWN_BLOCK/,
    );
  });

  it("refuses an add-on allocation with no block", () => {
    const orphan: ExistingAllocation = { ...used(1), sourceType: "ADD_ON_BLOCK" };
    expect(() => balanceOf("premium", [], [orphan])).toThrow(/ALLOCATION_NAMES_UNKNOWN_BLOCK/);
  });

  it("refuses a block listed twice", () => {
    const twice = [block("blk", "NORMAL", 1, day(1)), block("blk", "NORMAL", 1, day(1))];
    expect(() => balanceOf("premium", twice)).toThrow(/DUPLICATE_ADD_ON_BLOCK/);
  });
});

describe("Transaction G's frozen-funding check", () => {
  const funded = [
    { quality: "NORMAL" as const, quantity: 2 },
    { quality: "NORMAL" as const, quantity: 1 },
  ];

  it("accepts a set that covers the reservation exactly", () => {
    expect(
      frozenFundingCoversReservation({ quality: "NORMAL", reservedUnits: 3, allocations: funded }),
    ).toBe(true);
  });

  it.each([
    ["short", 4, funded],
    ["long", 2, funded],
    ["empty", 3, []],
  ] as const)("refuses a %s set", (_label, reservedUnits, allocations) => {
    expect(
      frozenFundingCoversReservation({ quality: "NORMAL", reservedUnits, allocations }),
    ).toBe(false);
  });

  it("refuses a set carrying the other quality", () => {
    expect(
      frozenFundingCoversReservation({
        quality: "HIGH_QUALITY",
        reservedUnits: 3,
        allocations: funded,
      }),
    ).toBe(false);
  });

  it("refuses a zero-quantity allocation even when the total matches", () => {
    expect(
      frozenFundingCoversReservation({
        quality: "NORMAL",
        reservedUnits: 3,
        allocations: [...funded, { quality: "NORMAL", quantity: 0 }],
      }),
    ).toBe(false);
  });
});
