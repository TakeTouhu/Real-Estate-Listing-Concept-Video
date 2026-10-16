import { describe, expect, it } from "vitest";
import { CHANNEL_NAMES, PLAN_NAMES, QUALITY_NAMES, formatJst, formatYenExTax } from "./units-view";

/** How the Units page words its facts (ADR-0066 Decision 3). */
describe("the Units page's wording", () => {
  it("writes an instant in Japan time, whatever the server's zone", () => {
    expect(formatJst(new Date("2026-10-16T00:00:00.000Z"))).toBe("16 Oct 2026, 09:00 JST");
    expect(formatJst(new Date("2026-12-31T15:00:00.000Z"))).toBe("1 Jan 2027, 00:00 JST");
  });

  it("labels every price as excluding tax", () => {
    expect(formatYenExTax(49_800)).toBe("¥49,800 excluding tax");
    expect(formatYenExTax(298_000)).toBe("¥298,000 excluding tax");
  });

  it("names plans, qualities and channels without any model or provider", () => {
    expect(PLAN_NAMES).toEqual({ standard: "Standard", premium: "Premium", enterprise: "Enterprise" });
    expect(QUALITY_NAMES).toEqual({ NORMAL: "Normal", HIGH_QUALITY: "HQ" });
    expect(CHANNEL_NAMES).toEqual({ SALES_ASSISTED: "Paid by invoice", SELF_SERVICE: "Paid by card" });
  });
});
