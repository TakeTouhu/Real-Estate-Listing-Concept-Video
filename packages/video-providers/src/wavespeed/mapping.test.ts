import { describe, expect, it } from "vitest";
import {
  buildSubmitUrl,
  extractOutputUrl,
  mapToWaveSpeedRequest,
  normalizeHttpStatusError,
  normalizeWaveSpeedError,
  normalizeWaveSpeedState,
  parsePredictionId,
} from "./mapping";
import type { ProviderGenerationInput } from "../types";

const input: ProviderGenerationInput = {
  modelId: "wavespeed-ai/open-video/image-to-video",
  sourceImageUrl: "https://storage.internal/o/org/img?token=x",
  prompt: "bright natural interior",
  negativePrompt: "no fake windows",
  cameraMotion: "slow-walkthrough",
  seed: 42,
  durationSeconds: 6,
  aspectRatio: "16:9",
  resolution: "1080p",
  requestHash: "abc123",
};

describe("request mapping", () => {
  it("builds the submit url from base + model id", () => {
    expect(buildSubmitUrl("https://api.wavespeed.ai/api/v3/", "a/b/c")).toBe(
      "https://api.wavespeed.ai/api/v3/a/b/c",
    );
  });

  it("maps normalized input to the candidate request body", () => {
    const req = mapToWaveSpeedRequest(input, "https://api.wavespeed.ai/api/v3");
    expect(req.url).toBe(
      "https://api.wavespeed.ai/api/v3/wavespeed-ai/open-video/image-to-video",
    );
    expect(req.body).toMatchObject({
      image: input.sourceImageUrl,
      prompt: input.prompt,
      negative_prompt: input.negativePrompt,
      camera_motion: input.cameraMotion,
      seed: 42,
      duration: 6,
      aspect_ratio: "16:9",
      resolution: "1080p",
    });
  });

  it("omits optional fields when absent", () => {
    const req = mapToWaveSpeedRequest(
      { ...input, negativePrompt: undefined, cameraMotion: undefined, seed: undefined },
      "https://api.wavespeed.ai/api/v3",
    );
    expect(req.body).not.toHaveProperty("negative_prompt");
    expect(req.body).not.toHaveProperty("camera_motion");
    expect(req.body).not.toHaveProperty("seed");
  });
});

describe("parsePredictionId", () => {
  it("reads data.id and top-level id", () => {
    expect(parsePredictionId({ data: { id: "pred_1" } })).toBe("pred_1");
    expect(parsePredictionId({ id: "pred_2" })).toBe("pred_2");
  });

  it("throws a normalized provider error when missing", () => {
    expect(() => parsePredictionId({})).toThrowError(/WaveSpeedAI response/);
  });
});

describe("normalizeWaveSpeedState", () => {
  it.each([
    ["created", "QUEUED"],
    ["processing", "PROCESSING"],
    ["completed", "SUCCEEDED"],
    ["failed", "FAILED_TERMINAL"],
    ["cancelled", "CANCELLED"],
    ["timeout", "TIMED_OUT"],
  ])("maps %s -> %s", (raw, expected) => {
    expect(normalizeWaveSpeedState(raw)).toBe(expected);
  });

  it("treats unknown/undefined states as non-terminal PROCESSING", () => {
    expect(normalizeWaveSpeedState("weird")).toBe("PROCESSING");
    expect(normalizeWaveSpeedState(undefined)).toBe("PROCESSING");
  });
});

describe("extractOutputUrl", () => {
  it("reads array and string outputs", () => {
    expect(extractOutputUrl({ data: { outputs: ["https://x/out.mp4"] } })).toBe(
      "https://x/out.mp4",
    );
    expect(extractOutputUrl({ data: { outputs: "https://x/out.mp4" } })).toBe(
      "https://x/out.mp4",
    );
    expect(extractOutputUrl({ data: {} })).toBeUndefined();
  });
});

describe("error normalization", () => {
  it("maps http status codes to kinds and retryability", () => {
    expect(normalizeHttpStatusError(401, "").kind).toBe("AUTH");
    expect(normalizeHttpStatusError(422, "").kind).toBe("INVALID_INPUT");
    expect(normalizeHttpStatusError(429, "").retryable).toBe(true);
    expect(normalizeHttpStatusError(503, "").retryable).toBe(true);
    expect(normalizeHttpStatusError(418, "teapot").retryable).toBe(false);
  });

  it("classifies abort as timeout and other throwables as network", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(normalizeWaveSpeedError(abort).kind).toBe("TIMEOUT");
    expect(normalizeWaveSpeedError(new Error("boom")).kind).toBe("NETWORK");
  });

  it("passes through already-normalized provider errors", () => {
    const normalized = normalizeHttpStatusError(429, "");
    expect(normalizeWaveSpeedError(normalized)).toBe(normalized);
  });
});
