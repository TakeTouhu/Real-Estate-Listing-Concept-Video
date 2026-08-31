import { describe, expect, it, vi } from "vitest";
import { WaveSpeedVideoProvider } from "./wavespeed-provider";
import type { WaveSpeedConfig } from "./config";
import type { HttpClient, HttpRequest, HttpResponse } from "./http";
import { WAVESPEED_OPEN_VIDEO_MODEL_ID } from "@app/shared";
import type { ProviderGenerationInput, ProviderGenerationRef } from "../types";

const config: WaveSpeedConfig = {
  apiKey: "super-secret-key",
  baseUrl: "https://api.wavespeed.ai/api/v3",
  poll: { initialMs: 1000, maxMs: 10000, timeoutMs: 60000 },
  pricing: { currency: "USD", costPerSecondMinor: 10 },
};

const input: ProviderGenerationInput = {
  modelId: WAVESPEED_OPEN_VIDEO_MODEL_ID,
  sourceImageUrl: "https://storage.internal/o/org/img?token=x",
  prompt: "bright natural interior",
  durationSeconds: 5,
  aspectRatio: "16:9",
  resolution: "1080p",
  requestHash: "hash1",
};

function stubClient(responses: HttpResponse[]): { http: HttpClient; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  let i = 0;
  return {
    calls,
    http: {
      request(req: HttpRequest): Promise<HttpResponse> {
        calls.push(req);
        const res = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return Promise.resolve(res!);
      },
    },
  };
}

const now = () => new Date("2026-01-01T00:00:00.000Z");

describe("WaveSpeedVideoProvider (injected http, no network)", () => {
  it("submits with Bearer auth and returns an internal ref", async () => {
    const { http, calls } = stubClient([
      { status: 200, body: JSON.stringify({ data: { id: "pred_9" } }) },
    ]);
    const provider = new WaveSpeedVideoProvider(config, { http, now });
    const outcome = await provider.createGeneration(input);

    expect(outcome.kind).toBe("ACCEPTED");
    if (outcome.kind !== "ACCEPTED") throw new Error("unreachable");
    expect(outcome.ref.predictionId).toBe("pred_9");
    expect(outcome.ref.provider).toBe("wavespeed");
    expect(outcome.ref.submittedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(calls[0]?.headers.Authorization).toBe("Bearer super-secret-key");
    expect(calls[0]?.url).toContain("/wavespeed-ai/open-video/image-to-video");
  });

  /**
   * 401 no longer throws: an auth failure is a *definitive rejection*, and the
   * caller must be able to tell it apart from an ambiguous one without a
   * `catch` (ADR-0032). The diagnostic itself is unchanged.
   */
  it("returns DEFINITIVELY_REJECTED for an auth failure, with a safe error", async () => {
    const { http } = stubClient([{ status: 401, body: "unauthorized" }]);
    const provider = new WaveSpeedVideoProvider(config, { http, now });
    const outcome = await provider.createGeneration(input);

    expect(outcome.kind).toBe("DEFINITIVELY_REJECTED");
    if (outcome.kind === "ACCEPTED") throw new Error("unreachable");
    expect(outcome.error.kind).toBe("AUTH");
    expect(outcome.error.retryable).toBe(false);
    // Secret safety: the API key must never leak into the error surface.
    expect(JSON.stringify(outcome.error)).not.toContain("super-secret-key");
  });

  it("maps provider status into normalized state and output url", async () => {
    const { http } = stubClient([
      {
        status: 200,
        body: JSON.stringify({ data: { status: "completed", outputs: ["https://x/out.mp4"] } }),
      },
    ]);
    const provider = new WaveSpeedVideoProvider(config, { http, now });
    const ref: ProviderGenerationRef = {
      provider: "wavespeed",
      modelId: WAVESPEED_OPEN_VIDEO_MODEL_ID,
      predictionId: "pred_9",
      submittedAt: now().toISOString(),
    };
    const status = await provider.getStatus(ref);
    expect(status.state).toBe("SUCCEEDED");
    expect(status.temporaryOutputUrl).toBe("https://x/out.mp4");
  });

  /**
   * A network throw is the case the whole milestone exists for. It keeps its
   * NETWORK diagnostic, but the submission outcome is UNKNOWN, not a failure —
   * the request may already have created a billed prediction.
   */
  it("returns SUBMISSION_UNKNOWN for a network throw, keeping the NETWORK diagnostic", async () => {
    const http: HttpClient = { request: vi.fn().mockRejectedValue(new Error("econn")) };
    const provider = new WaveSpeedVideoProvider(config, { http, now });
    const outcome = await provider.createGeneration(input);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    if (outcome.kind === "ACCEPTED") throw new Error("unreachable");
    expect(outcome.error).toMatchObject({ kind: "NETWORK", retryable: true });
  });

  it("estimates cost without any network call", async () => {
    const { http, calls } = stubClient([{ status: 200, body: "{}" }]);
    const provider = new WaveSpeedVideoProvider(config, { http, now });
    const cost = await provider.estimateCost(input);
    expect(cost).toEqual({ amountMinor: 50, currency: "USD" });
    expect(calls).toHaveLength(0);
  });
});
