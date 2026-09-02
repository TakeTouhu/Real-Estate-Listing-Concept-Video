import { describe, expect, it, vi } from "vitest";
import { WAVESPEED_OPEN_VIDEO_MODEL_ID } from "@app/shared";
import type { HttpClient, HttpRequest, HttpResponse } from "../http";
import type { ProviderGenerationInput } from "../types";
import type { WaveSpeedConfig } from "./config";
import { WaveSpeedVideoProvider } from "./wavespeed-provider";

/**
 * WaveSpeed submission certainty, exhaustively.
 *
 * Every case here answers one question: *after this response, may the request
 * be sent again?* The suite is deliberately status-by-status rather than
 * grouped, because the interesting failures are the ones where a plausible
 * reading of a status gives the wrong answer — 422 looks like a rejection, a
 * 429 looks retryable, and a malformed 2xx looks like a failure. Each of those
 * would authorize a duplicate charge.
 *
 * Every case also asserts the request count. "Exactly one POST" is the property
 * that actually protects the customer's money; a classifier that were perfect
 * but looped would be worse than one that were coarse and did not.
 *
 * No network: the transport is a stub that records what it was asked to do.
 */

const config: WaveSpeedConfig = {
  apiKey: "super-secret-key",
  baseUrl: "https://api.wavespeed.ai/api/v3",
  poll: { initialMs: 1000, maxMs: 10000, timeoutMs: 60000 },
  pricing: { currency: "USD", costPerSecondMinor: 10 },
};

const input: ProviderGenerationInput = {
  modelId: WAVESPEED_OPEN_VIDEO_MODEL_ID,
  sourceImageUrl: "https://storage.internal/o/org/img?token=SIGNED",
  prompt: "bright natural interior",
  durationSeconds: 5,
  aspectRatio: "16:9",
  nativeGenerationResolution: "1080p",
  requestHash: "sha256:v2:internal-only",
};

const now = () => new Date("2026-01-01T00:00:00.000Z");

function respondWith(response: HttpResponse) {
  const calls: HttpRequest[] = [];
  const http: HttpClient = {
    request(req) {
      calls.push(req);
      return Promise.resolve(response);
    },
  };
  return { http, calls };
}

function submit(http: HttpClient) {
  return new WaveSpeedVideoProvider(config, { http, now }).createGeneration(input);
}

describe("WaveSpeed submission — accepted", () => {
  it("returns ACCEPTED for a 2xx carrying a prediction id, after one POST", async () => {
    const { http, calls } = respondWith({
      status: 200,
      body: JSON.stringify({ data: { id: "pred_ok" } }),
    });

    const outcome = await submit(http);

    expect(outcome.kind).toBe("ACCEPTED");
    expect(calls).toHaveLength(1);
  });
});

describe("WaveSpeed submission — definitively rejected", () => {
  /**
   * The allowlist is restated here as literals, deliberately.
   *
   * Enumerating it from the module would make this test agree with whatever the
   * module says — including after a change that widened it. A financial
   * allowlist wants an independent second statement, so that changing the rule
   * requires changing it in two places by hand.
   */
  it.each([400, 401, 403])("treats %i as DEFINITIVELY_REJECTED, after one POST", async (status) => {
    const { http, calls } = respondWith({ status, body: "rejected" });

    const outcome = await submit(http);

    expect(outcome.kind).toBe("DEFINITIVELY_REJECTED");
    expect(calls).toHaveLength(1);
  });

  it("admits nothing else across the whole status range", async () => {
    // Exhaustive rather than sampled: every status a server can send is checked
    // against the independent expectation that only three are definitive.
    const definitive: number[] = [];
    for (let status = 100; status <= 599; status += 1) {
      const { http } = respondWith({ status, body: "x" });
      const outcome = await submit(http);
      if (outcome.kind === "DEFINITIVELY_REJECTED") definitive.push(status);
    }
    expect(definitive).toEqual([400, 401, 403]);
  });
});

describe("WaveSpeed submission — unknown", () => {
  it.each([
    // The one that changed. 422 was previously definitive; on a generation API
    // it can mean a moderation or model-level refusal reached *after* the
    // request was accepted, so it is no longer proof that nothing happened.
    [422, "an unprocessable entity that may already have consumed work"],
    [429, "a rate limit, which describes the transport and not the decision"],
    [500, "a server error"],
    [503, "an unavailable upstream"],
    [301, "a redirect that was not followed"],
    [302, "a redirect that was not followed"],
    [418, "an unlisted 4xx"],
  ])("treats %i as SUBMISSION_UNKNOWN — %s", async (status) => {
    const { http, calls } = respondWith({ status, body: "whatever" });

    const outcome = await submit(http);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    expect(calls).toHaveLength(1);
  });

  it("keeps a 429 UNKNOWN even though its error is retryable", async () => {
    // The single most load-bearing assertion in this file. `retryable: true`
    // is about the transport; it is not permission to POST again.
    const { http } = respondWith({ status: 429, body: "slow down" });

    const outcome = await submit(http);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    if (outcome.kind === "ACCEPTED") throw new Error("expected a failure outcome");
    expect(outcome.error.retryable).toBe(true);
  });

  it("treats a 2xx with unparseable JSON as UNKNOWN, not rejection", async () => {
    // The provider said yes. This process simply cannot read the answer, so the
    // request may be running and billing right now.
    const { http, calls } = respondWith({ status: 200, body: "<html>not json</html>" });

    const outcome = await submit(http);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    expect(calls).toHaveLength(1);
  });

  /**
   * Malformed 2xx bodies, exhaustively over the shapes `JSON.parse` can return.
   *
   * `null` is the one that mattered. The parser used to assert its argument
   * into an envelope type and then read `.data` off it, so a body of exactly
   * `null` raised a `TypeError` — a programmer defect escaping from the one
   * method whose failures must all be classified outcomes. A type assertion is
   * a compile-time claim and validates nothing at runtime.
   */
  it.each([
    ["JSON null", "null"],
    ["a bare number", "42"],
    ["an array", "[]"],
    ["a JSON string", '"pred_1"'],
    ["a null data envelope", JSON.stringify({ data: null })],
    ["missing", JSON.stringify({ data: {} })],
    ["empty", JSON.stringify({ data: { id: "" } })],
    ["whitespace-only", JSON.stringify({ data: { id: "   \t\n " } })],
    ["non-string", JSON.stringify({ data: { id: 12345 } })],
    ["null", JSON.stringify({ data: { id: null } })],
  ])("treats a 2xx whose prediction id is %s as UNKNOWN", async (_label, body) => {
    const { http, calls } = respondWith({ status: 200, body });

    const outcome = await submit(http);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    if (outcome.kind === "ACCEPTED") throw new Error("expected a failure outcome");
    expect(outcome.error.code).toBe("WAVESPEED_SUBMISSION_RESPONSE_INVALID");
    expect(calls).toHaveLength(1);
  });

  it("never says a malformed success was accepted", async () => {
    // The diagnostic must not assert the one fact this outcome exists because
    // nobody can establish. WaveSpeed may hold the request; that is not the
    // same as knowing it accepted it.
    const { http } = respondWith({ status: 200, body: "null" });

    const outcome = await submit(http);

    if (outcome.kind === "ACCEPTED") throw new Error("expected a failure outcome");
    expect(outcome.error.messageSanitized).toBe(
      "WaveSpeedAI submission response did not contain a usable prediction id",
    );
    expect(outcome.error.messageSanitized).not.toContain("accepted");
  });

  it("accepts an identifier that only needed trimming", async () => {
    const { http } = respondWith({
      status: 200,
      body: JSON.stringify({ data: { id: "  pred_ok\n" } }),
    });

    const outcome = await submit(http);

    if (outcome.kind !== "ACCEPTED") throw new Error("expected ACCEPTED");
    expect(outcome.ref.predictionId).toBe("pred_ok");
  });

  it("treats a transport failure as UNKNOWN and does not retry", async () => {
    const request = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    const outcome = await submit({ request });

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("treats a timeout as UNKNOWN and does not retry", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const request = vi.fn().mockRejectedValue(abort);

    const outcome = await submit({ request });

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    if (outcome.kind === "ACCEPTED") throw new Error("expected a failure outcome");
    expect(outcome.error.kind).toBe("TIMEOUT");
    // A second POST here is the exact duplicate charge this contract prevents:
    // the request may have arrived and be executing.
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("WaveSpeed submission — no outcome leaks provider bytes", () => {
  it.each([400, 422, 500])(
    "keeps the response body and the API key out of a %i outcome",
    async (status) => {
      const { http } = respondWith({
        status,
        body: JSON.stringify({
          detail: "image=https://storage.internal/o/org/img?token=SIGNED",
          key: "super-secret-key",
        }),
      });

      const outcome = await submit(http);
      const serialized = JSON.stringify(outcome);

      expect(serialized).not.toContain("super-secret-key");
      expect(serialized).not.toContain("SIGNED");
      expect(serialized).not.toContain("storage.internal");
      expect(serialized).not.toContain("bright natural interior");
    },
  );
});
