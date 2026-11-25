import { describe, expect, it } from "vitest";
import { AppError, toErrorEnvelope, type AppErrorCode } from "./errors";

describe("an application error", () => {
  it("takes its code's status unless one is given", () => {
    const statuses: [AppErrorCode, number][] = [
      ["UNAUTHENTICATED", 401],
      ["FORBIDDEN", 403],
      ["NOT_FOUND", 404],
      ["VALIDATION_FAILED", 422],
      ["RATE_LIMITED", 429],
      ["CONFIGURATION_ERROR", 500],
      ["PROVIDER_ERROR", 500],
      ["INTERNAL_ERROR", 500],
    ];
    for (const [code, status] of statuses) expect(new AppError(code, "m").httpStatus).toBe(status);
    expect(new AppError("RATE_LIMITED", "m", { httpStatus: 503 }).httpStatus).toBe(503);
  });

  it("is enveloped with its code, text, the request's id and its details as given, or none", () => {
    const refused = new AppError("RATE_LIMITED", "Too many uploads.", { details: { retryAfterSeconds: 60 } });
    expect(toErrorEnvelope(refused, "req_1")).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Too many uploads.",
        requestId: "req_1",
        details: { retryAfterSeconds: 60 },
      },
    });
    expect(toErrorEnvelope(new AppError("NOT_FOUND", "Not found"), "req_2").error.details).toEqual({});
  });
});
