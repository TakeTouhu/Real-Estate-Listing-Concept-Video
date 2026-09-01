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
  seed: 42,
  durationSeconds: 6,
  aspectRatio: "16:9",
  nativeGenerationResolution: "1080p",
  requestHash: "abc123",
};

describe("request mapping", () => {
  it("builds the submit url from base + model id", () => {
    expect(buildSubmitUrl("https://api.wavespeed.ai/api/v3/", "a/b/c")).toBe(
      "https://api.wavespeed.ai/api/v3/a/b/c",
    );
  });

  it("sends exactly the documented request fields, and nothing else", () => {
    // The load-bearing assertion of Phase 4B-2a. An earlier version of this
    // adapter sent `aspect_ratio`, `negative_prompt` and `camera_motion` — none
    // of which the selected OpenVideo model documents — and the old test froze
    // that shape rather than catching it. An exact key set, not `toMatchObject`,
    // is what makes an undocumented field impossible to reintroduce quietly.
    const req = mapToWaveSpeedRequest(
      { ...input, seed: undefined },
      "https://api.wavespeed.ai/api/v3",
    );
    expect(req.url).toBe(
      "https://api.wavespeed.ai/api/v3/wavespeed-ai/open-video/image-to-video",
    );
    expect(Object.keys(req.body).sort()).toEqual(
      ["duration", "image", "prompt", "resolution"].sort(),
    );
    expect(req.body).toEqual({
      image: input.sourceImageUrl,
      prompt: input.prompt,
      duration: 6,
      resolution: "1080p",
    });
  });

  it("sends the native token, never the product target", () => {
    // The rename is the guard, but the rename alone would be satisfied by an
    // adapter that happened to receive a target-shaped string. This pins the
    // *value*: give the boundary a native token that is not a product target
    // and it must appear on the wire unchanged.
    const native = mapToWaveSpeedRequest(
      { ...input, nativeGenerationResolution: "480p" },
      "https://api.wavespeed.ai/api/v3",
    );
    expect(native.body.resolution).toBe("480p");
  });

  it("performs no translation between a product target and a native token", () => {
    // A regression shape for the model this boundary does not serve yet.
    //
    // MiniMax H3 Max generates at `768P` and nothing else, so an admitted 1080p
    // deliverable carries `target = 1080p, native = 768P`. Only the native token
    // reaches a provider — `ProviderGenerationInput` cannot even express the
    // target, which is what makes "the adapter must not send 1080p" structural
    // rather than a rule someone has to remember.
    //
    // Written against this adapter because it is the only one that exists: there
    // is deliberately no fal adapter (ADR-0033/0034), and nothing here contacts
    // any provider. What it proves is that the *mapping* is a pass-through, so
    // a future fal adapter inherits a boundary with no translation step to get
    // wrong.
    const h3MaxNative = "768P";
    const request = mapToWaveSpeedRequest(
      { ...input, nativeGenerationResolution: h3MaxNative },
      "https://api.wavespeed.ai/api/v3",
    );

    expect(request.body.resolution).toBe(h3MaxNative);
    expect(request.body.resolution).not.toBe("1080p");
    // And no product-target field leaked onto the wire under any name.
    expect(Object.keys(request.body)).not.toContain("targetOutputResolution");
    expect(Object.keys(request.body)).not.toContain("target");
  });

  it("adds seed only when a caller supplies one", () => {
    const withSeed = mapToWaveSpeedRequest({ ...input, seed: 42 }, "https://api.wavespeed.ai/api/v3");
    expect(Object.keys(withSeed.body).sort()).toEqual(
      ["duration", "image", "prompt", "resolution", "seed"].sort(),
    );
    expect(withSeed.body.seed).toBe(42);
  });

  it.each(["aspect_ratio", "negative_prompt", "camera_motion", "preset"])(
    "never sends %s, which this model does not document",
    (field) => {
      // Present on the normalized input, absent from the wire. Aspect ratio is
      // COMPOSITION_OWNED (Phase 5 normalizes the output); the negative prompt
      // is refused at admission; camera motion travels in the prompt; `preset`
      // has an unresolved contract.
      const req = mapToWaveSpeedRequest(
        { ...input, seed: 42 },
        "https://api.wavespeed.ai/api/v3",
      );
      expect(req.body).not.toHaveProperty(field);
    },
  );

  it("builds the submit url from the input model id, not from configuration", () => {
    // What lets an already-admitted generation execute against the model it was
    // admitted under, even after the configured default changes.
    const req = mapToWaveSpeedRequest(
      { ...input, modelId: "some-vendor/frozen-model" },
      "https://api.wavespeed.ai/api/v3",
    );
    expect(req.url).toBe("https://api.wavespeed.ai/api/v3/some-vendor/frozen-model");
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
    expect(normalizeHttpStatusError(401).kind).toBe("AUTH");
    expect(normalizeHttpStatusError(422).kind).toBe("INVALID_INPUT");
    expect(normalizeHttpStatusError(429).retryable).toBe(true);
    expect(normalizeHttpStatusError(503).retryable).toBe(true);
    expect(normalizeHttpStatusError(418).retryable).toBe(false);
  });

  it("classifies abort as timeout and other throwables as network", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(normalizeWaveSpeedError(abort).kind).toBe("TIMEOUT");
    expect(normalizeWaveSpeedError(new Error("boom")).kind).toBe("NETWORK");
  });

  /**
   * There is deliberately **no** pass-through here for a plain object that
   * merely looks normalized — not even one whose every field has the right
   * type. Shape is not provenance. The nominal boundary lives one level up, on
   * `ProviderErrorException`, and is covered in `sanitization.test.ts`.
   */
  it("does not trust a plain object that looks like a normalized error", () => {
    const looksNormalized = normalizeHttpStatusError(429);
    expect(normalizeWaveSpeedError(looksNormalized)).toMatchObject({
      kind: "NETWORK",
      code: "WAVESPEED_NETWORK_ERROR",
    });
  });
});
