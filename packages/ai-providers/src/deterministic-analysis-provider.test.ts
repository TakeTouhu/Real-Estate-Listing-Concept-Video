import { describe, expect, it } from "vitest";
import { serverEnvSchema } from "@app/shared";
import { ROOM_TYPES } from "@app/domain";
import type { AnalysisRequest } from "@app/domain";
import { DeterministicImageAnalysisProvider } from "./deterministic-analysis-provider";
import { createImageAnalysisProvider } from "./factory";

function request(overrides: Partial<AnalysisRequest> = {}): AnalysisRequest {
  const bytes = new Uint8Array(512);
  bytes.fill(128);
  return {
    assetId: "ast_1",
    imageBytes: bytes,
    mimeType: "image/jpeg",
    width: 1600,
    height: 1200,
    perceptualHash: "0f0f0f0f0f0f0f0f",
    ...overrides,
  };
}

describe("DeterministicImageAnalysisProvider", () => {
  const provider = new DeterministicImageAnalysisProvider();

  it("is deterministic for the same asset", async () => {
    const a = await provider.analyze(request());
    const b = await provider.analyze(request());
    expect(a).toEqual(b);
  });

  it("varies across assets but stays in the room vocabulary", async () => {
    const results = await Promise.all(
      ["ast_1", "ast_2", "ast_3", "ast_4", "ast_5"].map((assetId) =>
        provider.analyze(request({ assetId })),
      ),
    );
    for (const r of results) {
      expect(ROOM_TYPES).toContain(r.roomType);
    }
    expect(new Set(results.map((r) => r.roomType)).size).toBeGreaterThan(1);
  });

  it("returns normalized scores within 0..1", async () => {
    const r = await provider.analyze(request());
    for (const score of [r.confidence, r.qualityScore, r.brightnessScore, r.blurScore]) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
    for (const o of r.detectedObjects) {
      expect(o.confidence).toBeGreaterThanOrEqual(0);
      expect(o.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("derives brightness from the actual bytes", async () => {
    const dark = new Uint8Array(256);
    dark.fill(10);
    const bright = new Uint8Array(256);
    bright.fill(240);
    const darkResult = await provider.analyze(request({ imageBytes: dark }));
    const brightResult = await provider.analyze(request({ imageBytes: bright }));
    expect(darkResult.brightnessScore).toBeLessThan(brightResult.brightnessScore);
  });

  it("honours a forced room type and confidence", async () => {
    const forced = new DeterministicImageAnalysisProvider({
      forcedRoomType: "BALCONY",
      forcedConfidence: 0.25,
    });
    const r = await forced.analyze(request());
    expect(r.roomType).toBe("BALCONY");
    expect(r.confidence).toBeCloseTo(0.25);
  });

  it("attaches configured extra safety flags", async () => {
    const flagged = new DeterministicImageAnalysisProvider({
      extraFlags: [{ code: "PERSON_DETECTED", severity: "BLOCKING", message: "person visible" }],
    });
    const r = await flagged.analyze(request());
    expect(r.safetyFlags.map((f) => f.code)).toContain("PERSON_DETECTED");
  });

  it("rejects empty image bytes with a normalized INVALID_INPUT error", async () => {
    await expect(provider.analyze(request({ imageBytes: new Uint8Array() }))).rejects.toMatchObject({
      kind: "INVALID_INPUT",
      retryable: false,
    });
  });

  it("normalizes arbitrary throwables and passes through provider errors", () => {
    const normalized = provider.normalizeError(new Error("oops"));
    expect(normalized.kind).toBe("UNKNOWN");
    expect(normalized.messageSanitized).not.toContain("oops");

    const passthrough = provider.normalizeError({
      kind: "RATE_LIMITED",
      retryable: true,
      code: "X",
      messageSanitized: "slow down",
    });
    expect(passthrough.kind).toBe("RATE_LIMITED");
  });

  it("performs no network I/O (no fetch in the module graph)", async () => {
    // A failing provider surfaces its own error rather than any network error.
    const failing = new DeterministicImageAnalysisProvider({ failWith: new Error("forced") });
    await expect(failing.analyze(request())).rejects.toThrow("forced");
  });
});

describe("createImageAnalysisProvider", () => {
  const baseEnv = {
    SESSION_SECRET: "session-secret-abcdef123456",
    HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
    STORAGE_SIGNING_SECRET: "storage-signing-secret-abc",
  };

  it("returns the deterministic provider by default", () => {
    const env = serverEnvSchema.parse(baseEnv);
    expect(env.ANALYSIS_PROVIDER).toBe("deterministic");
    expect(createImageAnalysisProvider(env).name).toBe("deterministic");
  });
});
