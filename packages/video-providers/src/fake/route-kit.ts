import { AppError, type ServerEnv } from "@app/shared";
import {
  defineRoutePolicy,
  epochMillisFromDate,
  extendProviderPricingCatalog,
  microUsd,
  routeQualityOffer,
  type AuthorizedRoute,
  type FxSnapshot,
  type GenerationQualityTier,
  type ProviderPricingCatalog,
  type ProviderPricingContract,
  type RoutePolicy,
  type StartQualityOffer,
  type VerifiedModelEntry,
  type VideoModelCatalog,
} from "@app/domain";
import { deepFreeze } from "../deep-freeze";

/**
 * The test provider's route, price, catalog entry and exchange rate (GS-5a-2,
 * ADR-0090), for development and CI only.
 *
 * None of it is in production's tables: production's route policy, price
 * catalog and model catalog are unchanged, and only {@link createFakeRouteKit},
 * which refuses production, hands any of it out. A composition passes the
 * kit's policy to both the start and the paid-submission gate, and its price
 * catalog to the authorization repository (ADR-0089).
 */

/** Never a real endpoint: the fake provider calls no service. */
export const FAKE_VIDEO_MODEL_ID = "fake/zoom-pan/image-to-video";
export const FAKE_VIDEO_MODEL_KEY = "fake-zoom-pan";
/** The version the kit's routes and prices are recorded under. */
export const FAKE_ROUTE_VERSION = "dev-test-route.1";

/**
 * The test provider's catalog entry. It records each target as generated at
 * its own size, so nothing is upscaled; the fake provider makes no clip yet,
 * and GS-6's must be made at that size (`docs/decisions/TODO.md`). The duration
 * range is production's default model's, so a storyboard composed for one fits
 * the other.
 */
const FAKE_VIDEO_MODEL: VerifiedModelEntry = deepFreeze({
  key: FAKE_VIDEO_MODEL_KEY,
  providerName: "fake",
  providerModelId: FAKE_VIDEO_MODEL_ID,
  displayName: "Test provider",
  tier: "ECONOMY",
  recommended: true,
  availability: { kind: "SELECTABLE" },
  capability: {
    providerName: "fake",
    providerModelId: FAKE_VIDEO_MODEL_ID,
    durationSeconds: { kind: "RANGE", minSeconds: 5, maxSeconds: 15 },
    nativeGenerationResolutions: ["720p", "1080p"],
    aspectRatios: { kind: "COMPOSITION_OWNED" },
    negativePrompt: { kind: "UNSUPPORTED" },
    cameraMotion: { kind: "PROMPT_RENDERED" },
  },
  nativeGeneration: {
    byTarget: {
      "720p": {
        nativeGenerationResolution: { providerValue: "720p" },
        normalization: "NONE",
        nativeMeetsTarget: true,
      },
      "1080p": {
        nativeGenerationResolution: { providerValue: "1080p" },
        normalization: "NONE",
        nativeMeetsTarget: true,
      },
    },
  },
  pricing: null,
} as const);

function fakeRoute(qualityTier: GenerationQualityTier, size: "720p" | "1080p"): AuthorizedRoute {
  return {
    qualityTier,
    providerName: "fake",
    providerModelId: FAKE_VIDEO_MODEL_ID,
    requestModelKey: FAKE_VIDEO_MODEL_KEY,
    nativeGenerationResolution: size,
    targetOutputResolutions: [size],
    generationMode: "image-to-video",
    audioMode: "none",
  };
}

/** Normal is a 720p video and HQ a 1080p one, each generated at its own size. */
const FAKE_ROUTES: readonly AuthorizedRoute[] = [fakeRoute("NORMAL", "720p"), fakeRoute("HIGH_QUALITY", "1080p")];

/**
 * A nominal price, one cent a second, so the Cost Safety Guard has a cost to
 * weigh. Nothing is ever billed for it: the fake provider is not paid.
 */
function fakeContract(nativeTier: "720p" | "1080p"): ProviderPricingContract {
  return {
    identity: {
      provider: "fake",
      pricingModelKey: FAKE_VIDEO_MODEL_KEY,
      generationMode: "image-to-video",
      nativeTier,
      audioMode: "none",
      durationBillingRuleId: "per-second",
      pricingVersion: FAKE_ROUTE_VERSION,
    },
    stable: {
      verification: "VERIFIED_STABLE",
      rule: { kind: "PER_SECOND", unitPriceMicroUsdPerSecond: microUsd(10_000) },
    },
    promotion: null,
    billableDuration: { kind: "CONTINUOUS", minSeconds: 5, maxSeconds: 15 },
    effectiveFrom: epochMillisFromDate(new Date("2026-09-01T00:00:00.000Z")),
    effectiveUntil: null,
  };
}

/** A fixed ¥150 per dollar, named as what it is: not a market rate. */
const FAKE_FX_SNAPSHOT: FxSnapshot = deepFreeze({
  id: "fx_dev_fixed_usd_jpy_150",
  baseCurrency: "USD",
  quoteCurrency: "JPY",
  rateNumerator: 150,
  rateDenominator: 1,
  effectiveAt: epochMillisFromDate(new Date("2026-09-01T00:00:00.000Z")),
  sourceReference: "development fixed rate, not a market rate",
});

export interface FakeRouteKit {
  /** The test provider alone, as the default. */
  readonly models: VideoModelCatalog;
  /** The test provider's two routes and nothing else; passed to the gate. */
  readonly routePolicy: RoutePolicy;
  /** Built from the same policy, for the start, so the two agree. */
  readonly qualityOffer: StartQualityOffer;
  /** Production's contracts and the test provider's two. */
  readonly pricing: ProviderPricingCatalog;
  /** The rate the test provider's prices are converted at. */
  readonly fx: FxSnapshot;
}

/**
 * The test route, outside production only.
 *
 * Refused when the given or the ambient `NODE_ENV` is `production` (the given
 * value cannot vouch for the ambient one), with no override, and unless
 * `VIDEO_PROVIDER` is `fake`.
 */
export function createFakeRouteKit(env: Pick<ServerEnv, "NODE_ENV" | "VIDEO_PROVIDER">): FakeRouteKit {
  if (env.NODE_ENV === "production" || process.env.NODE_ENV === "production") {
    throw new AppError("CONFIGURATION_ERROR", "The test provider's route is refused in production");
  }
  if (env.VIDEO_PROVIDER !== "fake") {
    throw new AppError("CONFIGURATION_ERROR", "The test provider's route needs VIDEO_PROVIDER=fake");
  }
  const routePolicy = defineRoutePolicy({
    version: FAKE_ROUTE_VERSION,
    qualityTiers: ["NORMAL", "HIGH_QUALITY"],
    routes: FAKE_ROUTES,
  });
  // The kit and each part, so no composition it is handed to can swap a lookup.
  return Object.freeze({
    models: Object.freeze({
      list: () => [FAKE_VIDEO_MODEL],
      default: () => FAKE_VIDEO_MODEL,
      find: (key: string) => (key === FAKE_VIDEO_MODEL_KEY ? FAKE_VIDEO_MODEL : undefined),
    }),
    routePolicy,
    qualityOffer: Object.freeze(routeQualityOffer(routePolicy)),
    pricing: Object.freeze(extendProviderPricingCatalog([fakeContract("720p"), fakeContract("1080p")])),
    fx: FAKE_FX_SNAPSHOT,
  });
}
