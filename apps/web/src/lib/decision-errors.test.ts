import { describe, expect, it } from "vitest";
import { DECISION_ERRORS, mapDecisionError } from "./decision-errors";

describe("decision error mapping", () => {
  it("maps transport-level statuses to their own message", () => {
    expect(mapDecisionError(401, null)).toBe(DECISION_ERRORS.signIn);
    expect(mapDecisionError(403, null)).toBe(DECISION_ERRORS.permission);
    expect(mapDecisionError(404, null)).toBe(DECISION_ERRORS.reload);
  });

  it("ignores any message carried by a transport-level status", () => {
    expect(mapDecisionError(403, "internal detail")).toBe(DECISION_ERRORS.permission);
  });

  it("renders the API message for a 422 unchanged", () => {
    const message = "This analysis revision has already been reviewed";
    // Surfaced as-is: the refusals behind a 422 share one code, and telling them
    // apart would mean parsing this string into an implicit API contract.
    expect(mapDecisionError(422, message)).toBe(message);
  });

  it("falls back generically for a 422 with no message, an unknown status, or no response", () => {
    expect(mapDecisionError(422, null)).toBe(DECISION_ERRORS.generic);
    expect(mapDecisionError(500, "boom")).toBe(DECISION_ERRORS.generic);
    expect(mapDecisionError(null, null)).toBe(DECISION_ERRORS.generic);
  });
});
