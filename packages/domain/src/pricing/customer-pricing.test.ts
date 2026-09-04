import { describe, expect, it } from "vitest";
import {
  ADDITIONAL_USER_PRICE_YEN_EX_TAX_PER_MONTH,
  createCustomerPlanCatalog,
  type CustomerPlan,
  type CustomerPlanKey,
} from "./customer-plan-catalog";
import {
  addOnPackagePrice,
  additionalUserMonthlyPriceYenExTax,
  annualContractRawPricing,
  annualPrepaymentFinalPrice,
  finalizeCustomerPrice,
  consumptionForScene,
  videoUnitsForSeconds,
} from "./customer-pricing";
import { yen } from "./units";

/**
 * An explicit "no floor" for cases that assert the formula rather than the
 * safety rule. Written out at every call site on purpose: the floor is a
 * required argument now, so a test cannot silently skip validation either.
 */
const NO_FLOOR = yen(0);

/**
 * Customer pricing, asserted against the frozen commercial contract.
 *
 * Every expected figure is written as a literal here rather than derived from
 * the implementation. A test that recomputes the production formula agrees with
 * whatever the formula says, including after it changes — which is not a test.
 */

const catalog = createCustomerPlanCatalog();

function plan(key: CustomerPlanKey): CustomerPlan {
  const found = catalog.find(key);
  if (found === undefined) throw new Error(`missing plan: ${key}`);
  return found;
}

describe("the customer plan catalog carries the frozen commercial contract", () => {
  it.each([
    ["standard", 49_800, 3, 15, 1],
    ["premium", 119_800, 10, 40, 5],
    ["enterprise", 298_000, 30, 100, 10],
  ] as const)("%s: ¥%i ex tax, %i users, %i units, %i high-quality", (key, price, users, units, hq) => {
    const entry = plan(key);
    expect(entry.monthlyPriceYenExTax).toBe(price);
    expect(entry.includedUsers).toBe(users);
    expect(entry.includedVideoUnits).toBe(units);
    expect(entry.includedHighQualityUnits).toBe(hq);
  });

  it("keeps high-quality units inside the total entitlement, not beside it", () => {
    // Premium is 40 units of which at most 5 may be high quality — never 45.
    const premium = plan("premium");
    expect(premium.includedHighQualityUnits).toBeLessThan(premium.includedVideoUnits);
  });

  it("is deeply immutable", () => {
    const entry = plan("standard");
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(catalog.all())).toBe(true);
    expect(() => {
      (entry as { monthlyPriceYenExTax: number }).monthlyPriceYenExTax = 1;
    }).toThrow();
    expect(plan("standard").monthlyPriceYenExTax).toBe(49_800);
  });
});

describe("seats are priced apart from generation entitlement", () => {
  it("charges ¥3,000 per additional seat per month, on every plan", () => {
    expect(ADDITIONAL_USER_PRICE_YEN_EX_TAX_PER_MONTH).toBe(3_000);
    const three = additionalUserMonthlyPriceYenExTax(3);
    if (!three.ok) throw new Error("expected a price");
    expect(three.value).toBe(9_000);
  });

  it("never lets a seat change generation entitlement", () => {
    // The seat price function cannot return entitlement, and the plan is frozen,
    // so the two concepts have no path between them (§8).
    const before = plan("standard");
    const priced = additionalUserMonthlyPriceYenExTax(5);
    if (!priced.ok) throw new Error("expected a price");
    const after = plan("standard");
    expect(after.includedVideoUnits).toBe(before.includedVideoUnits);
    expect(after.includedHighQualityUnits).toBe(before.includedHighQualityUnits);
    expect(Object.keys(priced)).toEqual(["ok", "value"]);
  });

  it("refuses a non-positive or non-integer seat count", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = additionalUserMonthlyPriceYenExTax(bad);
      expect(result.ok).toBe(false);
    }
  });
});

describe("annual prepayment discounts exactly 5%", () => {
  it.each([
    ["standard", 597_600, 567_720, 567_700],
    ["premium", 1_437_600, 1_365_720, 1_365_700],
    ["enterprise", 3_576_000, 3_397_200, 3_397_200],
  ] as const)("%s: gross ¥%i, raw ¥%i, final ¥%i", (key, gross, raw, final) => {
    const pricing = annualContractRawPricing(plan(key));
    expect(pricing.grossAnnualYenExTax).toBe(gross);
    expect(pricing.prepaymentRawYenExTax).toBe(raw);

    const finalized = annualPrepaymentFinalPrice(plan(key), NO_FLOOR);
    if (!finalized.ok) throw new Error("expected a price");
    expect(finalized.value.finalYenExTax).toBe(final);
  });

  it("derives the gross annual figure from the monthly contract", () => {
    // Not a stored total: a monthly price and an annual price that disagree is
    // the failure this derivation prevents.
    const premium = plan("premium");
    expect(annualContractRawPricing(premium).grossAnnualYenExTax).toBe(
      premium.monthlyPriceYenExTax * 12,
    );
  });
});

describe("add-on packages are priced from the plan fraction, once", () => {
  it("applies exactly 1.20 to a normal add-on", () => {
    // Standard base is ¥49,800 / 15 = ¥3,320; ×1.20 = ¥3,984; ×5 = ¥19,920.
    const priced = addOnPackagePrice(plan("standard"), "NORMAL", 5, NO_FLOOR);
    if (!priced.ok) throw new Error("expected a price");
    expect(priced.value.rawYenExTax).toBe(19_920);
    expect(priced.value.finalYenExTax).toBe(19_900);
  });

  it("applies exactly 1.50 to a high-quality add-on", () => {
    // Enterprise base is ¥298,000 / 100 = ¥2,980; ×1.50 = ¥4,470; ×5 = ¥22,350.
    const priced = addOnPackagePrice(plan("enterprise"), "HIGH_QUALITY", 5, NO_FLOOR);
    if (!priced.ok) throw new Error("expected a price");
    expect(priced.value.rawYenExTax).toBe(22_350);
  });

  /**
   * The case that distinguishes "price the package" from "price a unit and
   * multiply". Premium's high-quality unit is ¥4,492.5 exactly: rounding it to
   * ¥4,493 and doubling gives ¥8,986, flooring to ¥4,492 gives ¥8,984, and the
   * true package price is ¥8,985.
   */
  it("does not round an intermediate per-unit price", () => {
    const priced = addOnPackagePrice(plan("premium"), "HIGH_QUALITY", 2, NO_FLOOR);
    if (!priced.ok) throw new Error("expected a price");
    expect(priced.value.rawYenExTax).toBe(8_985);
    expect(priced.value.rawYenExTax).not.toBe(8_986);
    expect(priced.value.rawYenExTax).not.toBe(8_984);
  });

  it("rounds the final customer price to the nearest ¥100, not downward", () => {
    // ¥8,985 is nearer ¥9,000 than ¥8,900. A floor rule would say ¥8,900.
    const priced = addOnPackagePrice(plan("premium"), "HIGH_QUALITY", 2, NO_FLOOR);
    if (!priced.ok) throw new Error("expected a price");
    expect(priced.value.finalYenExTax).toBe(9_000);
    expect(priced.value.finalYenExTax).not.toBe(8_900);
    expect(priced.value.roundedAwayFromNearestForSafety).toBe(false);
  });

  it("refuses to round down through the profitability floor", () => {
    // Raw ¥19,920 with a floor of ¥19,910: nearest-¥100 is ¥19,900, which is
    // below the floor, so the next ¥100 up is used instead of quoting a loss.
    const priced = addOnPackagePrice(plan("standard"), "NORMAL", 5, yen(19_910));
    if (!priced.ok) throw new Error("expected a price");
    expect(priced.value.finalYenExTax).toBe(20_000);
    expect(priced.value.roundedAwayFromNearestForSafety).toBe(true);
  });

  it("refuses the package outright when even the raw price is unprofitable", () => {
    const priced = addOnPackagePrice(plan("standard"), "NORMAL", 5, yen(25_000));
    expect(priced.ok).toBe(false);
    if (priced.ok) throw new Error("expected a refusal");
    expect(priced.error.reason).toBe("ROUNDED_PRICE_WOULD_BE_UNPROFITABLE");
  });

  it("forbids a high-quality add-on on Standard, and allows it above", () => {
    const standard = addOnPackagePrice(plan("standard"), "HIGH_QUALITY", 2, NO_FLOOR);
    expect(standard.ok).toBe(false);
    if (standard.ok) throw new Error("expected a refusal");
    expect(standard.error.reason).toBe("HIGH_QUALITY_ADD_ON_NOT_AVAILABLE_ON_PLAN");

    expect(addOnPackagePrice(plan("premium"), "HIGH_QUALITY", 2, NO_FLOOR).ok).toBe(true);
    expect(addOnPackagePrice(plan("enterprise"), "HIGH_QUALITY", 2, NO_FLOOR).ok).toBe(true);
  });

  it("still allows Standard a normal add-on", () => {
    expect(addOnPackagePrice(plan("standard"), "NORMAL", 5, NO_FLOOR).ok).toBe(true);
  });

  it("refuses a non-positive or non-integer quantity", () => {
    for (const bad of [0, -3, 2.5, Number.NaN]) {
      expect(addOnPackagePrice(plan("premium"), "NORMAL", bad, NO_FLOOR).ok).toBe(false);
    }
  });
});

describe("a final customer price cannot be produced without safety validation", () => {
  /**
   * The floor is a required argument on every path that produces a quotable
   * price. There is no overload, no default and no second entry point that
   * skips it — a safety rule a caller can omit is not a safety rule.
   */
  it("requires a floor to finalize any price", () => {
    // Both quotable-price functions take the floor positionally, so omitting it
    // is a compile error rather than a silent zero. This asserts the runtime
    // half: the same raw figure yields different answers as the floor moves.
    const raw = yen(19_920);
    const permissive = finalizeCustomerPrice(raw, NO_FLOOR);
    const strict = finalizeCustomerPrice(raw, yen(19_910));
    if (!permissive.ok || !strict.ok) throw new Error("expected prices");
    expect(permissive.value.finalYenExTax).toBe(19_900);
    expect(strict.value.finalYenExTax).toBe(20_000);
  });

  it("rejects downward rounding that crosses the floor, and rounds up instead", () => {
    const finalized = finalizeCustomerPrice(yen(19_920), yen(19_910));
    if (!finalized.ok) throw new Error("expected a price");
    expect(finalized.value.finalYenExTax).toBe(20_000);
    expect(finalized.value.roundedAwayFromNearestForSafety).toBe(true);
  });

  it("refuses outright when even the raw price is below the floor", () => {
    const finalized = finalizeCustomerPrice(yen(19_920), yen(25_000));
    expect(finalized.ok).toBe(false);
    if (finalized.ok) throw new Error("expected a refusal");
    expect(finalized.error.reason).toBe("ROUNDED_PRICE_WOULD_BE_UNPROFITABLE");
  });

  it("keeps annual prepayment on the same safety path", () => {
    // Standard's raw prepayment is ¥567,720; nearest-¥100 is ¥567,700, which a
    // floor of ¥567,710 forbids — so it rounds up rather than quoting a loss.
    const finalized = annualPrepaymentFinalPrice(plan("standard"), yen(567_710));
    if (!finalized.ok) throw new Error("expected a price");
    expect(finalized.value.finalYenExTax).toBe(567_800);
    expect(finalized.value.roundedAwayFromNearestForSafety).toBe(true);
  });

  it("refuses an annual prepayment that cannot clear its floor", () => {
    const finalized = annualPrepaymentFinalPrice(plan("standard"), yen(600_000));
    expect(finalized.ok).toBe(false);
  });

  /**
   * The floor's *requiredness* is a compile-time property, and only a
   * compile-time assertion can hold it. Every runtime test passes a floor, so
   * re-adding a default would leave all of them green — an optional parameter
   * is invisible to a caller that always supplies it. `Parameters<f>["length"]`
   * widens to a union the moment a parameter becomes optional, so pinning it to
   * an exact arity fails to compile if a default returns.
   */
  it("makes the floor a required parameter, not a defaulted one", () => {
    type Assert<T extends true> = T;
    type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

    const addOnArity: Assert<
      IsExactly<Parameters<typeof addOnPackagePrice>["length"], 4>
    > = true;
    const finalizeArity: Assert<
      IsExactly<Parameters<typeof finalizeCustomerPrice>["length"], 2>
    > = true;
    const annualArity: Assert<
      IsExactly<Parameters<typeof annualPrepaymentFinalPrice>["length"], 2>
    > = true;

    expect([addOnArity, finalizeArity, annualArity]).toEqual([true, true, true]);
  });

  it("exposes no raw-pricing path that also rounds", () => {
    // `annualContractRawPricing` returns exact figures only. If it grew a
    // final price, rounding would have a second home and the two could
    // disagree about safety.
    const raw = annualContractRawPricing(plan("standard"));
    expect(Object.keys(raw).sort()).toEqual(["grossAnnualYenExTax", "prepaymentRawYenExTax"]);
  });
});

describe("scene duration converts to customer video units", () => {
  it.each([
    [1, 1],
    [15, 1],
    [30, 1],
    [31, 2],
    [60, 2],
    [61, 3],
    [90, 3],
  ])("%i seconds is %i unit(s)", (seconds, units) => {
    const result = videoUnitsForSeconds(seconds);
    if (!result.ok) throw new Error("expected units");
    expect(result.value).toBe(units);
  });

  it("refuses 91 seconds as beyond product policy", () => {
    const result = videoUnitsForSeconds(91);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.reason).toBe("DURATION_EXCEEDS_PRODUCT_POLICY");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %s as a duration",
    (bad) => {
      const result = videoUnitsForSeconds(bad);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.error.reason).toBe("DURATION_NOT_A_POSITIVE_INTEGER");
    },
  );
});

describe("high-quality usage draws from the same entitlement", () => {
  it("consumes total units and high-quality units together", () => {
    const sixty = consumptionForScene(60, true);
    if (!sixty.ok) throw new Error("expected consumption");
    expect(sixty.value).toEqual({ totalVideoUnits: 2, highQualityUnits: 2 });

    const ninety = consumptionForScene(90, true);
    if (!ninety.ok) throw new Error("expected consumption");
    expect(ninety.value).toEqual({ totalVideoUnits: 3, highQualityUnits: 3 });
  });

  it("consumes only total units for normal usage", () => {
    const normal = consumptionForScene(60, false);
    if (!normal.ok) throw new Error("expected consumption");
    expect(normal.value).toEqual({ totalVideoUnits: 2, highQualityUnits: 0 });
  });
});
