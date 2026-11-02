import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Where the web app builds the start (GS-10c, ADR-0111 Decision 2): only where
 * the test provider's route is handed out, which its own guard decides.
 */
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("./env", () => ({ getServerEnv: () => env.value }));

const DEVELOPMENT = { NODE_ENV: "development", VIDEO_PROVIDER: "fake", USER_SESSION_TTL_SECONDS: 3600 } as const;

/** A fresh module each time, so nothing one test built is cached for the next. */
async function composition(): Promise<typeof import("./generation-start")> {
  vi.resetModules();
  return import("./generation-start");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the test provider's route", () => {
  it("is handed out outside production with the test provider, serving both qualities", async () => {
    const { testProviderRoute } = await composition();
    for (const NODE_ENV of ["development", "test"] as const) {
      const route = testProviderRoute({ NODE_ENV, VIDEO_PROVIDER: "fake" });
      expect(route?.qualityOffer.offers("NORMAL")).toBe(true);
      expect(route?.qualityOffer.offers("HIGH_QUALITY")).toBe(true);
    }
  });

  it("is refused in production, given or ambient, and with another provider", async () => {
    const { testProviderRoute } = await composition();
    expect(testProviderRoute({ NODE_ENV: "production", VIDEO_PROVIDER: "fake" })).toBeNull();
    expect(testProviderRoute({ NODE_ENV: "development", VIDEO_PROVIDER: "wavespeed" })).toBeNull();
    vi.stubEnv("NODE_ENV", "production");
    expect(testProviderRoute({ NODE_ENV: "development", VIDEO_PROVIDER: "fake" })).toBeNull();
  });
});

describe("the start", () => {
  it("is built once, in development with the test provider", async () => {
    env.value = DEVELOPMENT;
    const { getGenerationStartService } = await composition();
    // The domain module the fresh composition loaded.
    const { GenerationStartService } = await import("@app/domain");
    const service = getGenerationStartService();
    expect(service).toBeInstanceOf(GenerationStartService);
    expect(getGenerationStartService()).toBe(service);
  });

  it.each([
    ["in production", { ...DEVELOPMENT, NODE_ENV: "production" }],
    ["with another provider", { ...DEVELOPMENT, VIDEO_PROVIDER: "wavespeed" }],
  ])("is not built %s", async (_where, configured) => {
    env.value = configured;
    const { getGenerationStartService } = await composition();
    expect(getGenerationStartService()).toBeNull();
    expect(getGenerationStartService()).toBeNull();
  });
});
