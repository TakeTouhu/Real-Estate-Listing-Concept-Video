import { describe, expect, it } from "vitest";
import { AppError, serverEnvSchema } from "@app/shared";
import { createVideoProvider } from "./factory";

const baseEnv = {
  SESSION_SECRET: "session-secret-abcdef123456",
  HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
};

describe("createVideoProvider", () => {
  it("returns the fake provider in Phase 0", () => {
    const env = serverEnvSchema.parse(baseEnv);
    expect(createVideoProvider(env).name).toBe("fake");
  });

  it("fails fast when wavespeed is selected (deferred to Phase 1)", () => {
    const env = serverEnvSchema.parse({
      ...baseEnv,
      VIDEO_PROVIDER: "wavespeed",
      WAVESPEED_API_KEY: "k",
    });
    expect(() => createVideoProvider(env)).toThrow(AppError);
    expect(() => createVideoProvider(env)).toThrow(/Phase 1/);
  });
});
