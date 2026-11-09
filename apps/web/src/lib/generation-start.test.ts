import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeRouteKit } from "@app/video-providers";

/**
 * Where the web app builds the start (GS-10c, ADR-0111 Decision 2): only where
 * the test provider's route is handed out, which its own guard decides, and
 * with that route's qualities and route check (ADR-0123).
 */
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
/** Each kit handed out, each start built with what, and a kit failure a test sets. */
const seen = vi.hoisted(() => ({
  kits: [] as unknown[],
  starts: [] as { readonly qualities: unknown; readonly routes: unknown }[],
  kitFailure: null as Error | null,
}));

vi.mock("./env", () => ({ getServerEnv: () => env.value }));
// Mocked as itself so its `AppError` stays one class across `vi.resetModules`,
// which keeps mocked modules: the kit below throws the one the composition checks.
vi.mock("@app/shared", async (importOriginal) => importOriginal<typeof import("@app/shared")>());
vi.mock("@app/video-providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@app/video-providers")>();
  return {
    ...actual,
    createFakeRouteKit: (given: Parameters<typeof actual.createFakeRouteKit>[0]) => {
      if (seen.kitFailure !== null) throw seen.kitFailure;
      const kit = actual.createFakeRouteKit(given);
      seen.kits.push(kit);
      return kit;
    },
  };
});
vi.mock("@app/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@app/domain")>();
  class RecordedStart extends actual.GenerationStartService {
    constructor(deps: ConstructorParameters<typeof actual.GenerationStartService>[0]) {
      super(deps);
      seen.starts.push(deps);
    }
  }
  return { ...actual, GenerationStartService: RecordedStart };
});

const DEVELOPMENT = { NODE_ENV: "development", VIDEO_PROVIDER: "fake", USER_SESSION_TTL_SECONDS: 3600 } as const;

/** A fresh module each time, so nothing one test built is cached for the next. */
async function composition(): Promise<typeof import("./generation-start")> {
  vi.resetModules();
  return import("./generation-start");
}

beforeEach(() => {
  seen.kits = [];
  seen.starts = [];
  seen.kitFailure = null;
});

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

  it("lets any failure but the guard's refusal through", async () => {
    const { testProviderRoute } = await composition();
    const { AppError } = await import("@app/shared");
    for (const failure of [new AppError("INTERNAL_ERROR", "broken kit"), new TypeError("bug")]) {
      seen.kitFailure = failure;
      expect(() => testProviderRoute({ NODE_ENV: "development", VIDEO_PROVIDER: "fake" })).toThrow(failure);
    }
  });
});

describe("the start", () => {
  it("is built once, in development with the test provider, with the route's qualities and route check", async () => {
    env.value = DEVELOPMENT;
    const { getGenerationStartService } = await composition();
    // The domain module the fresh composition loaded.
    const { GenerationStartService } = await import("@app/domain");
    const service = getGenerationStartService();
    expect(service).toBeInstanceOf(GenerationStartService);
    expect(getGenerationStartService()).toBe(service);

    expect(seen.kits).toHaveLength(1);
    expect(seen.starts).toHaveLength(1);
    const [kit] = seen.kits as FakeRouteKit[];
    expect(seen.starts[0]?.qualities).toBe(kit?.qualityOffer);
    expect(seen.starts[0]?.routes).toBe(kit?.routeCheck);
  });

  it.each([
    ["in production", { ...DEVELOPMENT, NODE_ENV: "production" }],
    ["with another provider", { ...DEVELOPMENT, VIDEO_PROVIDER: "wavespeed" }],
  ])("is not built %s", async (_where, configured) => {
    env.value = configured;
    const { getGenerationStartService } = await composition();
    expect(getGenerationStartService()).toBeNull();
    expect(getGenerationStartService()).toBeNull();
    expect(seen.starts).toEqual([]);
  });
});
