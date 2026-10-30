import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import {
  PRODUCTION_ROUTE_POLICY,
  authorizeRoute,
  createPricingSnapshot,
  createProviderPricingCatalog,
  epochMillisFromDate,
  isSelectableModel,
  planGenerationResolution,
  validateFxSnapshot,
  type ProviderPricingIdentity,
  type RouteAuthorizationFacts,
} from "@app/domain";
import { createVideoModelCatalog } from "../catalog";
import { FAKE_ROUTE_VERSION, FAKE_VIDEO_MODEL_ID, FAKE_VIDEO_MODEL_KEY, createFakeRouteKit } from "./route-kit";

const DEV = { NODE_ENV: "test", VIDEO_PROVIDER: "fake" } as const;

function identity(nativeTier: "720p" | "1080p"): ProviderPricingIdentity {
  return {
    provider: "fake",
    pricingModelKey: FAKE_VIDEO_MODEL_KEY,
    generationMode: "image-to-video",
    nativeTier,
    audioMode: "none",
    durationBillingRuleId: "per-second",
    pricingVersion: FAKE_ROUTE_VERSION,
  };
}

function facts(overrides: Partial<RouteAuthorizationFacts> = {}): RouteAuthorizationFacts {
  return {
    qualityTier: "NORMAL",
    providerName: "fake",
    providerModelId: FAKE_VIDEO_MODEL_ID,
    requestModelKey: FAKE_VIDEO_MODEL_KEY,
    nativeGenerationResolution: "720p",
    targetOutputResolution: "720p",
    generationMode: "image-to-video",
    audioMode: "none",
    ...overrides,
  };
}

function refusal(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected the kit to be refused");
}

describe("building the test route", () => {
  const ambient = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = ambient;
  });

  it("is refused in production, with no override", () => {
    const error = refusal(() => createFakeRouteKit({ NODE_ENV: "production", VIDEO_PROVIDER: "fake" }));
    expect(error.code).toBe("CONFIGURATION_ERROR");
  });

  it("is refused when the process runs in production, whatever it is told", () => {
    process.env.NODE_ENV = "production";
    expect(refusal(() => createFakeRouteKit(DEV)).code).toBe("CONFIGURATION_ERROR");
  });

  it("is refused unless the test provider is the configured provider", () => {
    const error = refusal(() => createFakeRouteKit({ NODE_ENV: "development", VIDEO_PROVIDER: "wavespeed" }));
    expect(error.code).toBe("CONFIGURATION_ERROR");
  });

  it("is built in development and in tests", () => {
    expect(createFakeRouteKit({ NODE_ENV: "development", VIDEO_PROVIDER: "fake" }).routePolicy.version).toBe(
      FAKE_ROUTE_VERSION,
    );
    expect(createFakeRouteKit(DEV).routePolicy.version).toBe(FAKE_ROUTE_VERSION);
  });
});

describe("the test route's model catalog", () => {
  const { models } = createFakeRouteKit(DEV);

  it("holds the test provider alone, as the selectable default", () => {
    expect(models.list().map((e) => e.key)).toEqual([FAKE_VIDEO_MODEL_KEY]);
    expect(models.default().key).toBe(FAKE_VIDEO_MODEL_KEY);
    expect(models.default().providerName).toBe("fake");
    expect(isSelectableModel(models.default())).toBe(true);
    expect(models.find(FAKE_VIDEO_MODEL_KEY)).toBe(models.default());
    expect(models.find("minimax-h3-max")).toBeUndefined();
  });

  it("generates each target at its own size, so nothing is upscaled", () => {
    for (const size of ["720p", "1080p"] as const) {
      const delivery = planGenerationResolution(models.default(), size);
      expect(delivery.nativeGenerationResolution.providerValue).toBe(size);
      expect(delivery.normalization).toBe("NONE");
      expect(delivery.nativeMeetsTarget).toBe(true);
    }
  });
});

describe("the test route's policy", () => {
  const kit = createFakeRouteKit(DEV);

  it("serves Normal at 720p and HQ at 1080p, under its own version", () => {
    expect(kit.routePolicy.version).toBe(FAKE_ROUTE_VERSION);
    expect(authorizeRoute(facts(), kit.routePolicy).ok).toBe(true);
    expect(
      authorizeRoute(
        facts({ qualityTier: "HIGH_QUALITY", nativeGenerationResolution: "1080p", targetOutputResolution: "1080p" }),
        kit.routePolicy,
      ).ok,
    ).toBe(true);
    expect(kit.qualityOffer.offers("NORMAL")).toBe(true);
    expect(kit.qualityOffer.offers("HIGH_QUALITY")).toBe(true);
  });

  it("does not serve a quality at the other's size", () => {
    expect(
      authorizeRoute(facts({ nativeGenerationResolution: "1080p", targetOutputResolution: "1080p" }), kit.routePolicy),
    ).toEqual({ ok: false, reason: "NATIVE_TIER_NOT_AUTHORIZED" });
    expect(authorizeRoute(facts({ targetOutputResolution: "1080p" }), kit.routePolicy)).toEqual({
      ok: false,
      reason: "TARGET_RESOLUTION_NOT_AUTHORIZED",
    });
    expect(
      authorizeRoute(facts({ qualityTier: "HIGH_QUALITY", targetOutputResolution: "720p" }), kit.routePolicy),
    ).toEqual({ ok: false, reason: "NATIVE_TIER_NOT_AUTHORIZED" });
  });

  it("holds no production route", () => {
    expect(PRODUCTION_ROUTE_POLICY.routes.length).toBeGreaterThan(0);
    for (const production of PRODUCTION_ROUTE_POLICY.routes) {
      for (const target of production.targetOutputResolutions) {
        const result = authorizeRoute(
          {
            qualityTier: production.qualityTier,
            providerName: production.providerName,
            providerModelId: production.providerModelId,
            requestModelKey: production.requestModelKey,
            nativeGenerationResolution: production.nativeGenerationResolution,
            targetOutputResolution: target,
            generationMode: production.generationMode,
            audioMode: production.audioMode,
          },
          kit.routePolicy,
        );
        expect(`${production.requestModelKey} ${target}: ${result.ok}`).toBe(
          `${production.requestModelKey} ${target}: false`,
        );
      }
    }
  });
});

describe("the test route's prices and rate", () => {
  const kit = createFakeRouteKit(DEV);

  it("prices both sizes, beside production's contracts", () => {
    expect(kit.pricing.findByIdentity(identity("720p"))).toBeDefined();
    expect(kit.pricing.findByIdentity(identity("1080p"))).toBeDefined();
    const production = createProviderPricingCatalog().all();
    expect(kit.pricing.all()).toHaveLength(production.length + 2);
    for (const contract of production) {
      expect(kit.pricing.findByIdentity(contract.identity)).toEqual(contract);
    }
  });

  it("is a usable rate that names itself as no market rate", () => {
    expect(validateFxSnapshot(kit.fx).ok).toBe(true);
    expect(kit.fx.sourceReference).toContain("not a market rate");
  });

  it("can be snapshotted for every length the route generates", () => {
    for (const [size, riskProfileKey] of [
      ["720p", "NORMAL_AI"],
      ["1080p", "HIGH_QUALITY_AI"],
    ] as const) {
      const contract = kit.pricing.findByIdentity(identity(size));
      if (contract === undefined) throw new Error("expected the kit's contract");
      for (const requestedSeconds of [5, 15]) {
        const taken = createPricingSnapshot({
          contract,
          riskProfileKey,
          requestedSeconds,
          pricingEffectiveAt: epochMillisFromDate(new Date("2026-10-27T00:00:00.000Z")),
          fx: kit.fx,
        });
        expect(`${size} ${requestedSeconds}s: ${taken.ok}`).toBe(`${size} ${requestedSeconds}s: true`);
      }
    }
  });
});

describe("production's tables", () => {
  it("are not changed by building the kit", () => {
    createFakeRouteKit(DEV);
    expect(PRODUCTION_ROUTE_POLICY.routes.some((r) => r.providerName === "fake")).toBe(false);
    expect(createProviderPricingCatalog().all().some((c) => c.identity.provider === "fake")).toBe(false);
    expect(createProviderPricingCatalog().findByIdentity(identity("720p"))).toBeUndefined();
    expect(createVideoModelCatalog().find(FAKE_VIDEO_MODEL_KEY)).toBeUndefined();
    expect(createVideoModelCatalog().list().some((e) => e.providerName === "fake")).toBe(false);
  });
});

describe("the kit", () => {
  it("cannot be changed by the composition it is handed to", () => {
    const kit = createFakeRouteKit(DEV);
    expect(Object.isFrozen(kit)).toBe(true);
    expect(Object.isFrozen(kit.models)).toBe(true);
    expect(Object.isFrozen(kit.qualityOffer)).toBe(true);
    expect(Object.isFrozen(kit.pricing)).toBe(true);
    expect(Object.isFrozen(kit.routePolicy)).toBe(true);
    expect(Object.isFrozen(kit.routePolicy.routes[0])).toBe(true);
    expect(Object.isFrozen(kit.fx)).toBe(true);
    expect(Object.isFrozen(kit.models.default())).toBe(true);
    expect(Object.isFrozen(kit.models.default().nativeGeneration?.byTarget["1080p"])).toBe(true);
    expect(Object.isFrozen(kit.pricing.findByIdentity(identity("1080p")))).toBe(true);
  });
});

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".next", "dist", "coverage"]);

/**
 * Source outside tests naming `name`, comments stripped (a `//` after a colon
 * is kept, so a URL in a string does not hide the rest of its line).
 */
function callers(name: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full);
      } else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) && !entry.name.includes(".test.")) {
        const text = readFileSync(full, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, " ")
          .replace(/(^|[^:])\/\/[^\n]*/gm, "$1 ");
        if (text.includes(name)) found.push(full.slice(REPO_ROOT.length + 1));
      }
    }
  };
  for (const root of ["apps", "packages"]) {
    const base = join(REPO_ROOT, root);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base)) walk(join(base, pkg));
  }
  for (const root of ["infra", "prisma"]) {
    if (existsSync(join(REPO_ROOT, root))) walk(join(REPO_ROOT, root));
  }
  return found.sort();
}

describe("who builds the kit, or a policy or catalog like it", () => {
  /**
   * The development pipeline's assembly (GS-9b, ADR-0106) is the factory's
   * first caller. The start route (GS-10) adds itself here when it is
   * reviewed. The two builders the factory uses have no production check of
   * their own, so nothing else may call them.
   */
  it("is the package that defines the factory and the development pipeline", () => {
    expect(callers("createFakeRouteKit")).toEqual([
      "apps/worker/src/development-pipeline/assembly.ts",
      "packages/video-providers/src/fake/route-kit.ts",
      "packages/video-providers/src/index.ts",
    ]);
  });

  it("leaves the policy and catalog builders to the factory", () => {
    expect(callers("defineRoutePolicy")).toEqual([
      "packages/domain/src/authorization/routing.ts",
      "packages/video-providers/src/fake/route-kit.ts",
    ]);
    expect(callers("extendProviderPricingCatalog")).toEqual([
      "packages/domain/src/pricing/provider-pricing-catalog.ts",
      "packages/video-providers/src/fake/route-kit.ts",
    ]);
  });
});

describe("who builds the test provider's studio and its clip maker", () => {
  /** As with the kit, the development pipeline's assembly (GS-9b, ADR-0106). */
  it("is the packages that define them and the development pipeline", () => {
    expect(callers("createFakeClipStudio")).toEqual([
      "apps/worker/src/development-pipeline/assembly.ts",
      "packages/video-providers/src/fake/clip-studio.ts",
      "packages/video-providers/src/index.ts",
    ]);
    expect(callers("createFfmpegFakeClipRenderer")).toEqual([
      "apps/worker/src/development-pipeline/assembly.ts",
      "packages/storage/src/fake-clip-renderer.ts",
      "packages/storage/src/index.ts",
    ]);
  });
});
