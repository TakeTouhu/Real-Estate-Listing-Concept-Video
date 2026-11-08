import { describe, expect, it } from "vitest";
import { ANALYSIS_ERRORS, envelopeMessage, mapAnalysisError } from "./analysis-errors";

describe("analysis error mapping", () => {
  it("maps each transport-level status to its own message, whatever the body says", () => {
    expect(mapAnalysisError(401, "detail")).toBe(ANALYSIS_ERRORS.signIn);
    expect(mapAnalysisError(403, "detail")).toBe(ANALYSIS_ERRORS.permission);
    expect(mapAnalysisError(404, "detail")).toBe(ANALYSIS_ERRORS.reload);
  });

  it("shows a 422's own message as it is", () => {
    const message = "Only READY assets can be analyzed (asset is PROCESSING)";
    expect(mapAnalysisError(422, message)).toBe(message);
  });

  it("falls back for a 422 with no message, any other status, or no response", () => {
    expect(mapAnalysisError(422, null)).toBe(ANALYSIS_ERRORS.generic);
    expect(mapAnalysisError(500, "boom")).toBe(ANALYSIS_ERRORS.generic);
    expect(mapAnalysisError(null, null)).toBe(ANALYSIS_ERRORS.generic);
  });

  it("words each message for the page", () => {
    expect(ANALYSIS_ERRORS).toEqual({
      signIn: "Your session has ended. Sign in again to analyze photos.",
      permission: "Your role cannot analyze photos.",
      reload: "This photo is no longer available here. Reload the page.",
      generic: "The photo could not be analyzed. Try again.",
    });
  });
});

describe("the envelope's message", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 422 });

  it("reads error.message, and nothing else", async () => {
    expect(await envelopeMessage(json({ error: { code: "X", message: "Not ready" } }))).toBe("Not ready");
    expect(await envelopeMessage(json({ error: { message: "" } }))).toBeNull();
    expect(await envelopeMessage(json({ error: { message: 7 } }))).toBeNull();
    expect(await envelopeMessage(json({ message: "top level" }))).toBeNull();
    expect(await envelopeMessage(new Response("not json", { status: 500 }))).toBeNull();
  });
});
