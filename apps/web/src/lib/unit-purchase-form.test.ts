import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { NOT_USABLE, failureMessage, readUnitPurchaseForm, refusalMessage } from "./unit-purchase-form";

/** The confirmation form's fields, read back shape-only (ADR-0068 Decision 3). */
const VALID = {
  quality: "HIGH_QUALITY",
  units: "2",
  priceYenExTax: "9000",
  periodEndsAt: "2026-05-15T00:00:00.000Z",
  idempotencyKey: "0d6c9f6e-2a59-4c55-9a4b-6f0f6a1f4b57",
};

function form(fields: Record<string, string | undefined>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) data.set(key, value);
  return data;
}

describe("readUnitPurchaseForm", () => {
  it("reads what the confirmation step showed", () => {
    expect(readUnitPurchaseForm("org_1", form(VALID))).toEqual({
      organizationId: "org_1",
      quality: "HIGH_QUALITY",
      expected: { units: 2, priceYenExTax: 9_000, periodEndsAt: new Date("2026-05-15T00:00:00.000Z") },
      idempotencyKey: VALID.idempotencyKey,
    });
  });

  it("accepts a key of 200 characters", () => {
    expect(readUnitPurchaseForm("org_1", form({ ...VALID, idempotencyKey: "k".repeat(200) }))).not.toBeNull();
  });

  it.each([
    ["no quality", { quality: undefined }],
    ["an unknown quality", { quality: "ULTRA" }],
    ["a quality in lower case", { quality: "normal" }],
    ["no Units", { units: undefined }],
    ["zero Units", { units: "0" }],
    ["fractional Units", { units: "2.5" }],
    ["negative Units", { units: "-2" }],
    ["Units with a leading zero", { units: "02" }],
    ["Units in exponent form", { units: "1e3" }],
    ["a price with a separator", { priceYenExTax: "9,000" }],
    ["a price past nine digits", { priceYenExTax: "1000000000" }],
    ["no period end", { periodEndsAt: undefined }],
    ["a period end that is no instant", { periodEndsAt: "end of May" }],
    ["a period end not written as the step writes it", { periodEndsAt: "2026-05-15" }],
    ["an empty key", { idempotencyKey: "" }],
    ["a key of 201 characters", { idempotencyKey: "k".repeat(201) }],
  ])("refuses %s", (_what, overrides) => {
    expect(readUnitPurchaseForm("org_1", form({ ...VALID, ...overrides }))).toBeNull();
  });
});

describe("the words for a purchase that did not happen", () => {
  it.each([
    "NO_PLAN",
    "NOT_STARTED",
    "THROUGH_SALES",
    "CARD_PAYMENT_NOT_AVAILABLE",
    "NOT_OFFERED",
    "OFFER_CHANGED",
    "PERIOD_CHANGED",
    "IDEMPOTENCY_KEY_REUSED",
  ] as const)("says %s bought nothing", (reason) => {
    expect(refusalMessage(reason)).toContain("Nothing was bought.");
  });

  it.each(["OFFER_CHANGED", "PERIOD_CHANGED", "IDEMPOTENCY_KEY_REUSED"] as const)(
    "asks for a fresh review after %s",
    (reason) => {
      expect(refusalMessage(reason)).toMatch(/Review it again\.$/);
    },
  );

  it("names a refused permission and an unusable request as buying nothing", () => {
    expect(failureMessage(new AppError("FORBIDDEN", "Role ADMIN may not buy Units here"))).toBe(
      "You cannot buy Units for this organization. Nothing was bought.",
    );
    expect(failureMessage(new AppError("VALIDATION_FAILED", "The purchase request is not usable"))).toBe(NOT_USABLE);
  });

  it("never claims nothing was bought for a failure that may have come after the write", () => {
    const message = failureMessage(new AppError("INTERNAL_ERROR", "The current Unit period could not be read"));
    expect(message).toBe("The purchase could not be confirmed. Check the Units page before trying again.");
    expect(message).not.toContain("Nothing was bought");
  });
});
