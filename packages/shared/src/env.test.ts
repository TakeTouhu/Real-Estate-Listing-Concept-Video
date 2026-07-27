import { describe, expect, it } from "vitest";
import { serverEnvSchema } from "./env";

const base = {
  SESSION_SECRET: "session-secret-abcdef123456",
  HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
};

describe("serverEnvSchema", () => {
  it("applies documented defaults for the fake provider", () => {
    const env = serverEnvSchema.parse(base);
    expect(env.VIDEO_PROVIDER).toBe("fake");
    expect(env.WAVESPEED_API_BASE_URL).toBe("https://api.wavespeed.ai/api/v3");
    expect(env.WAVESPEED_VIDEO_MODEL_ID).toBe("wavespeed-ai/open-video/image-to-video");
    expect(env.SESSION_TTL_SECONDS).toBe(3600);
  });

  it("does not require a WaveSpeedAI key while provider=fake", () => {
    expect(serverEnvSchema.safeParse(base).success).toBe(true);
  });

  it("requires WAVESPEED_API_KEY when provider=wavespeed", () => {
    const result = serverEnvSchema.safeParse({ ...base, VIDEO_PROVIDER: "wavespeed" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("WAVESPEED_API_KEY"))).toBe(true);
    }
  });

  it("rejects short secrets", () => {
    expect(serverEnvSchema.safeParse({ ...base, SESSION_SECRET: "short" }).success).toBe(false);
  });

  it("coerces numeric poll settings", () => {
    const env = serverEnvSchema.parse({ ...base, WAVESPEED_POLL_INITIAL_MS: "500" });
    expect(env.WAVESPEED_POLL_INITIAL_MS).toBe(500);
  });
});
