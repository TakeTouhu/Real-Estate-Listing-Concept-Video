import { describe, expect, it } from "vitest";
import { PROJECT_ERRORS, mapProjectError } from "./project-errors";

describe("mapProjectError", () => {
  it("maps transport-level outcomes by status", () => {
    expect(mapProjectError(401, "anything")).toBe(PROJECT_ERRORS.signIn);
    expect(mapProjectError(403, "anything")).toBe(PROJECT_ERRORS.permission);
    expect(mapProjectError(404, "anything")).toBe(PROJECT_ERRORS.reload);
  });

  it("renders the API's own message for a 422", () => {
    expect(mapProjectError(422, "A project name is required")).toBe("A project name is required");
    expect(mapProjectError(422, "Requested duration must be a positive whole number of seconds")).toBe(
      "Requested duration must be a positive whole number of seconds",
    );
  });

  it("falls back to the generic message when a 422 carries no message", () => {
    expect(mapProjectError(422, null)).toBe(PROJECT_ERRORS.generic);
  });

  it("falls back for an unexpected status and for no status at all", () => {
    expect(mapProjectError(500, "Internal error")).toBe(PROJECT_ERRORS.generic);
    expect(mapProjectError(429, null)).toBe(PROJECT_ERRORS.generic);
    expect(mapProjectError(null, null)).toBe(PROJECT_ERRORS.generic);
  });

  it("never classifies a failure by matching text inside the message", () => {
    // Two different 422 refusals must pass through unchanged and untouched: the
    // mapper has no branch that reads the message, so a wording change in the
    // API can never silently change what the customer is told.
    const first = "A project name is required";
    const second = "Aspect ratio and resolution are required";
    expect(mapProjectError(422, first)).toBe(first);
    expect(mapProjectError(422, second)).toBe(second);
  });
});
