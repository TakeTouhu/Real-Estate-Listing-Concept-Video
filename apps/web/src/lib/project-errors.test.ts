import { describe, expect, it } from "vitest";
import {
  COMPOSE_ERRORS,
  PROJECT_ERRORS,
  mapComposeError,
  mapProjectError,
} from "./project-errors";

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

describe("mapComposeError", () => {
  it("maps transport-level outcomes by status, with compose wording", () => {
    expect(mapComposeError(401, "anything")).toBe(COMPOSE_ERRORS.signIn);
    expect(mapComposeError(403, "anything")).toBe(COMPOSE_ERRORS.permission);
    expect(mapComposeError(404, "anything")).toBe(COMPOSE_ERRORS.reload);
    // Distinct from the create wording — the two actions fail for different
    // reasons and a customer should be told which one failed.
    expect(COMPOSE_ERRORS.permission).not.toBe(PROJECT_ERRORS.permission);
  });

  it("renders the API's own message for every 422 the domain can raise", () => {
    const refusals = [
      "A storyboard needs at least 3 approved photos; 2 are available",
      "3 scenes can run between 6 and 30 seconds; 45 was requested",
      "The prompt was rejected by content review",
    ];
    for (const refusal of refusals) {
      expect(mapComposeError(422, refusal)).toBe(refusal);
    }
  });

  it("falls back when a 422 carries no message, and on any other outcome", () => {
    expect(mapComposeError(422, null)).toBe(COMPOSE_ERRORS.generic);
    expect(mapComposeError(500, "Internal error")).toBe(COMPOSE_ERRORS.generic);
    expect(mapComposeError(429, null)).toBe(COMPOSE_ERRORS.generic);
    expect(mapComposeError(null, null)).toBe(COMPOSE_ERRORS.generic);
  });
});
