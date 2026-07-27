import { describe, expect, it } from "vitest";
import { FakeVideoProvider } from "./fake-provider";
import type { ProviderGenerationInput } from "../types";

const input: ProviderGenerationInput = {
  modelId: "wavespeed-ai/open-video/image-to-video",
  sourceImageUrl: "https://storage.internal/o/org/img?token=x",
  prompt: "bright natural interior",
  durationSeconds: 6,
  aspectRatio: "16:9",
  resolution: "1080p",
  requestHash: "abc123",
};

describe("FakeVideoProvider", () => {
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  const provider = new FakeVideoProvider({ now });

  it("is deterministic and performs no network I/O", async () => {
    const a = await provider.createGeneration(input);
    const b = await provider.createGeneration(input);
    expect(a).toEqual(b);
    expect(a.predictionId).toBe("fake_abc123");
    expect(a.provider).toBe("fake");
  });

  it("reports SUCCEEDED with a temporary output url and expiry", async () => {
    const ref = await provider.createGeneration(input);
    const status = await provider.getStatus(ref);
    expect(status.state).toBe("SUCCEEDED");
    expect(status.progressPercent).toBe(100);
    expect(status.temporaryOutputUrl).toContain("fake_abc123");
    expect(status.temporaryOutputExpiresAt).toBe("2026-01-01T01:00:00.000Z");
  });

  it("estimates cost from duration and pricing", async () => {
    const cost = await provider.estimateCost(input);
    expect(cost).toEqual({ amountMinor: 30, currency: "USD" });
  });

  it("cancel resolves without error", async () => {
    const ref = await provider.createGeneration(input);
    await expect(provider.cancelGeneration(ref)).resolves.toBeUndefined();
  });
});
