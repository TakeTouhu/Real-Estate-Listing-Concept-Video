import { describe, expect, it } from "vitest";
import { CORRECTION_ERRORS, mapCorrectionError } from "./correction-errors";

describe("mapCorrectionError", () => {
  it("maps transport-level outcomes by status", () => {
    expect(mapCorrectionError(401, "anything")).toBe(CORRECTION_ERRORS.signIn);
    expect(mapCorrectionError(403, "anything")).toBe(CORRECTION_ERRORS.permission);
    expect(mapCorrectionError(404, "anything")).toBe(CORRECTION_ERRORS.reload);
  });

  it("renders the API's own message for every 422 the domain can raise", () => {
    const refusals = [
      "Unknown room type",
      "Order priority must be a whole number above zero",
      "A correction must specify a room type or an order priority",
      "This analysis revision has already been reviewed; refresh the analysis to review it again",
    ];
    for (const refusal of refusals) {
      expect(mapCorrectionError(422, refusal)).toBe(refusal);
    }
  });

  it("falls back when a 422 carries no message, and on any other outcome", () => {
    expect(mapCorrectionError(422, null)).toBe(CORRECTION_ERRORS.generic);
    expect(mapCorrectionError(500, "Internal error")).toBe(CORRECTION_ERRORS.generic);
    expect(mapCorrectionError(429, null)).toBe(CORRECTION_ERRORS.generic);
    expect(mapCorrectionError(null, null)).toBe(CORRECTION_ERRORS.generic);
  });

  it("never surfaces raw server detail for an unexpected status", () => {
    const leaky = "PrismaClientKnownRequestError at /srv/app/node_modules/...";
    expect(mapCorrectionError(500, leaky)).toBe(CORRECTION_ERRORS.generic);
    expect(mapCorrectionError(503, leaky)).not.toContain("Prisma");
  });

  it("never classifies a failure by matching text inside the message", () => {
    // Two different 422 refusals pass through unchanged: no branch reads the
    // message, so a wording change in the API cannot silently change what the
    // reviewer is told.
    const first = "Unknown room type";
    const second = "Order priority must be a whole number above zero";
    expect(mapCorrectionError(422, first)).toBe(first);
    expect(mapCorrectionError(422, second)).toBe(second);
  });
});
