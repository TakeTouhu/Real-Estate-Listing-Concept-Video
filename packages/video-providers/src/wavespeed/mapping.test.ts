import { describe, expect, it } from "vitest";
import {
  buildSubmitUrl,
  extractOutputUrl,
  mapToWaveSpeedRequest,
  normalizeHttpStatusError,
  normalizeWaveSpeedError,
  normalizeWaveSpeedState,
  findUsablePredictionId,
} from "./mapping";
import type { ProviderGenerationInput } from "../types";

const input: ProviderGenerationInput = {
  modelId: "wavespeed-ai/open-video/image-to-video",
  sourceImageUrl: "https://storage.internal/o/org/img?token=x",
  prompt: "bright natural interior",
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

  it("adds seed only when a caller supplies one", () => {
    const withSeed = mapToWaveSpeedRequest({ ...input, seed: 42 }, "https://api.wavespeed.ai/api/v3");
    expect(Object.keys(withSeed.body).sort()).toEqual(
      ["duration", "image", "prompt", "resolution", "seed"].sort(),
    );
    expect(withSeed.body.seed).toBe(42);
  });

  it.each(["aspect_ratio", "negative_prompt", "camera_motion", "preset"])(
    "never sends %s",
    (field) => {
      // Present on the normalized input, absent from the wire. Aspect ratio is
      // COMPOSITION_OWNED (Phase 5 normalizes the output); the negative prompt
      // is refused at admission; camera motion travels in the prompt. `preset`
      // is different from the other three: it *is* a documented optional
      // parameter now, and is still withheld because the provider defaults it
      // and nothing here selects one — sending an unchosen value would change
      // paid output on the vendor's terms.
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

describe("findUsablePredictionId", () => {
  it("reads data.id, and a top-level id as the legacy compatibility path", () => {
    expect(findUsablePredictionId({ data: { id: "pred_1" } })).toBe("pred_1");
    expect(findUsablePredictionId({ id: "pred_2" })).toBe("pred_2");
  });

  it("prefers data.id over a top-level id", () => {
    expect(findUsablePredictionId({ data: { id: "pred_1" }, id: "pred_2" })).toBe("pred_1");
  });

  /**
   * Returns `undefined` rather than throwing. After a 2xx, an unreadable id is
   * an ambiguous *submission*, not a local fault, and the caller answers
   * SUBMISSION_UNKNOWN (ADR-0032).
   */
  it("returns undefined for every unusable form, and never trims", () => {
    for (const payload of [
      {},
      { data: {} },
      { id: "" },
      { id: "   " },
      { id: " pred_1" },
      { id: "pred_1 " },
      { id: "\tpred_1" },
      { id: 7 },
      { id: null },
      { data: { id: "" } },
      { data: { id: " pred_1" } },
    ]) {
      expect(`${JSON.stringify(payload)}:${String(findUsablePredictionId(payload))}`).toBe(
        `${JSON.stringify(payload)}:undefined`,
      );
    }
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
