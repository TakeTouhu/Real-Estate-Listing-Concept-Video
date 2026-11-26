import { describe, expect, it, vi } from "vitest";
import { resetServerEnvCache, serverEnvSchema } from "@app/shared";
import { createLogger } from "@app/observability";
import { FakeVideoProvider, OPEN_VIDEO_CAPABILITY } from "@app/video-providers";
import { bootstrapWorker } from "./bootstrap";

const env = serverEnvSchema.parse({
  SESSION_SECRET: "session-secret-abcdef123456",
  HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
  STORAGE_SIGNING_SECRET: "storage-signing-secret-abc",
});

const silentLogger = createLogger({ sink: () => {} });

describe("bootstrapWorker", () => {
  it("bootstraps with the fake provider and runs an offline self-check", async () => {
    const provider = new FakeVideoProvider();
    const spy = vi.spyOn(provider, "estimateCost");
    const result = await bootstrapWorker({ env, logger: silentLogger, provider });
    expect(result).toEqual({ ready: true, provider: "fake" });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("self-checks with settings the configured model would actually accept", async () => {
    // The self-check previously asked for 1 second, outside the descriptor's
    // documented 3–20s range — so it exercised the adapter with a request
    // admission would refuse. `estimateCost` never validates, which is why
    // nothing failed and why this assertion is on the settings, not the call.
    const provider = new FakeVideoProvider();
    const spy = vi.spyOn(provider, "estimateCost");
    await bootstrapWorker({ env, logger: silentLogger, provider });
    // Read from the descriptor rather than restating 3 and 20, so a corrected
    // vendor range moves this assertion with it. The worker does not depend on
    // @app/domain, so the range is checked here rather than through
    // `assertSettingsSupported` — adding a package dependency for one test
    // would be a bigger change than the defect.
    const [input] = spy.mock.calls[0]!;
    const duration = OPEN_VIDEO_CAPABILITY.durationSeconds;
    expect(duration.kind).toBe("RANGE");
    if (duration.kind !== "RANGE") throw new Error("unreachable");
    expect(input.durationSeconds).toBeGreaterThanOrEqual(duration.minSeconds);
    expect(input.durationSeconds).toBeLessThanOrEqual(duration.maxSeconds);
    expect(OPEN_VIDEO_CAPABILITY.nativeGenerationResolutions).toContain(
      input.nativeGenerationResolution,
    );
  });

  it("propagates provider self-check failures", async () => {
    const provider = new FakeVideoProvider();
    vi.spyOn(provider, "estimateCost").mockRejectedValueOnce(new Error("boom"));
    await expect(
      bootstrapWorker({ env, logger: silentLogger, provider }),
    ).rejects.toThrow("boom");
  });

  it("refuses, as the web app does, a production environment that widens what Node.js trusts (ADR-0184)", async () => {
    // The worker image runs no Node.js today (ADR-0151 Decision 4), so this test alone holds the worker's refusal.
    const widening = { NODE_OPTIONS: "--use-openssl-ca", NODE_USE_SYSTEM_CA: "1", OPENSSL_CONF: "/marker.cnf" };
    // The schema checks these only once every required setting is there.
    const required = {
      SESSION_SECRET: "session-secret-abcdef123456",
      HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
      STORAGE_SIGNING_SECRET: "storage-signing-secret-abc",
    };
    for (const [name, value] of Object.entries({ NODE_ENV: "production", ...required, ...widening })) {
      vi.stubEnv(name, value);
    }
    resetServerEnvCache();
    try {
      const failure = await bootstrapWorker({ logger: silentLogger, provider: new FakeVideoProvider() }).then(
        () => "started",
        (error: unknown) => String(error),
      );
      for (const name of Object.keys(widening)) {
        expect(failure).toContain(`\n  - ${name}: ${name} must not be set in production: `);
      }
      expect(failure).not.toMatch(/marker|openssl-ca/);
    } finally {
      vi.unstubAllEnvs();
      resetServerEnvCache();
    }
  });
});
