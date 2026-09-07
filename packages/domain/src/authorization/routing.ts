import { deepFreeze } from "@app/shared";
import type { GenerationQualityTier } from "../orchestration/types";
import type { TargetOutputResolution } from "../generation/model-catalog";

/**
 * Which product routes may cross the paid submission boundary.
 *
 * This is an **authorization** table, not a model catalog. It answers one
 * question — is this exact combination of persisted routing facts a route the
 * product sells? — and deliberately carries none of what the executable
 * catalog owns: no capability envelope, no duration range, no aspect-ratio
 * policy, no native-generation planning, no pricing. Those have one authority
 * each and this is not it.
 *
 * It lives in `@app/domain` because the gate runs here and `@app/domain`
 * depends only on `@app/shared`. Importing `@app/video-providers` to read the
 * executable catalog would invert the dependency and drag a concrete adapter
 * into the layer that decides whether money may be spent. The cost of that
 * choice is one duplicated string — the provider model id — and it is paid
 * with a test rather than a comment: `tests/integration/routing-catalog-parity`
 * imports both packages and fails if they ever disagree.
 *
 * **Nothing here makes a provider executable.** A route being authorized for
 * *validation* is not a factory branch, a credential, or a call. Veo has a
 * verified pricing contract and an authorized route shape and still has no
 * adapter, no key and no way to be constructed — which is the distinction this
 * table has to preserve rather than blur.
 */

/**
 * The version of the route table below.
 *
 * Persisted with every authorization event. Which routes the product sold on a
 * given day is not reconstructible from the current source, so a decision found
 * in transition history needs the table's version alongside it to be readable
 * at all. Bump it whenever a route is added, removed or altered.
 */
export const ROUTING_POLICY_VERSION = "2026-09-07.1";

/** A route's identity: the eight facts an attempt persists about where it goes. */
export interface RouteAuthorizationFacts {
  readonly qualityTier: GenerationQualityTier;
  readonly providerName: string;
  readonly providerModelId: string;
  readonly requestModelKey: string;
  readonly nativeGenerationResolution: string;
  readonly targetOutputResolution: TargetOutputResolution;
  readonly generationMode: string;
  readonly audioMode: string;
}

export type RoutingAuthorizationFailure =
  | "ROUTE_NOT_IN_CATALOG"
  | "PROVIDER_NOT_AUTHORIZED"
  | "PROVIDER_MODEL_ID_NOT_AUTHORIZED"
  | "MODEL_KEY_NOT_AUTHORIZED"
  | "NATIVE_TIER_NOT_AUTHORIZED"
  | "TARGET_RESOLUTION_NOT_AUTHORIZED"
  | "GENERATION_MODE_NOT_AUTHORIZED"
  | "AUDIO_MODE_NOT_AUTHORIZED"
  | "QUALITY_TIER_ROUTE_NOT_AUTHORIZED";

/**
 * One authorized route.
 *
 * `targetOutputResolutions` lists the *product* outputs this route may serve,
 * which is not the same question as what it generates natively. H3 Max
 * generates 768P for both 720p and 1080p targets; the second is an upscale and
 * the route says so by listing both targets against one native tier rather
 * than by claiming a native 1080p it does not have.
 */
export interface AuthorizedRoute {
  readonly qualityTier: GenerationQualityTier;
  readonly providerName: string;
  readonly providerModelId: string;
  readonly requestModelKey: string;
  readonly nativeGenerationResolution: string;
  readonly targetOutputResolutions: readonly TargetOutputResolution[];
  readonly generationMode: string;
  readonly audioMode: string;
}

/**
 * The MiniMax H3 Max executable endpoint, duplicated from the video-providers
 * catalog under test-enforced parity. See the module comment.
 */
export const H3_MAX_PROVIDER_MODEL_ID = "minimax/h3-max/image-to-video";

const AUTHORIZED_ROUTES: readonly AuthorizedRoute[] = deepFreeze([
  /**
   * Normal AI — the current default generation path.
   *
   * Provider is `fal`, matching the pricing contract and the model catalog.
   * Never `google-veo`, and never the model's manufacturer: a route names
   * whoever the request is actually sent to.
   */
  {
    qualityTier: "NORMAL",
    providerName: "fal",
    providerModelId: H3_MAX_PROVIDER_MODEL_ID,
    requestModelKey: "minimax-h3-max",
    nativeGenerationResolution: "768P",
    targetOutputResolutions: ["720p", "1080p"],
    generationMode: "image-to-video",
    audioMode: "none",
  },
  /**
   * WaveSpeed OpenVideo — the economy/fallback route, and the only one with a
   * live adapter today.
   */
  {
    qualityTier: "NORMAL",
    providerName: "wavespeed",
    providerModelId: "wavespeed-ai/open-video/image-to-video",
    requestModelKey: "wavespeed-open-video",
    nativeGenerationResolution: "1080p",
    targetOutputResolutions: ["720p", "1080p"],
    generationMode: "image-to-video",
    audioMode: "none",
  },
] as const);

/**
 * High quality has **no authorized route**.
 *
 * Veo 3.1 Fast is the provisional choice and remains benchmark-gated: it has a
 * verified pricing contract and no adapter, no credential and no factory
 * branch. Listing it here would make a `HIGH_QUALITY` attempt pass routing
 * authorization and arrive at a boundary with nothing behind it, which is a
 * worse failure than being refused early. The empty set is the honest state,
 * and `QUALITY_TIER_ROUTE_NOT_AUTHORIZED` says so precisely.
 */
export const AUTHORIZED_QUALITY_TIERS: readonly GenerationQualityTier[] = deepFreeze([
  "NORMAL",
] as const);

export type RouteAuthorizationResult =
  | { readonly ok: true; readonly route: AuthorizedRoute }
  | { readonly ok: false; readonly reason: RoutingAuthorizationFailure };

/**
 * Is this attempt's persisted route one the product sells?
 *
 * Validation, never selection. The attempt already froze where it goes at
 * admission, and the hash that protects against duplicate payment covers those
 * facts — so silently substituting a different provider or model here would
 * produce an attempt whose stored identity describes work nobody ordered. A
 * route that is no longer authorized fails closed; changing it requires a new
 * attempt row.
 *
 * Every comparison is exact equality on an opaque token. Nothing parses `768P`
 * or splits a model id on `/`: a renamed tier must become a lookup miss rather
 * than a silently reinterpreted one.
 */
export function authorizeRoute(facts: RouteAuthorizationFacts): RouteAuthorizationResult {
  if (!AUTHORIZED_QUALITY_TIERS.includes(facts.qualityTier)) {
    return { ok: false, reason: "QUALITY_TIER_ROUTE_NOT_AUTHORIZED" };
  }

  const byTier = AUTHORIZED_ROUTES.filter((r) => r.qualityTier === facts.qualityTier);
  if (byTier.length === 0) {
    return { ok: false, reason: "QUALITY_TIER_ROUTE_NOT_AUTHORIZED" };
  }

  const byProvider = byTier.filter((r) => r.providerName === facts.providerName);
  if (byProvider.length === 0) return { ok: false, reason: "PROVIDER_NOT_AUTHORIZED" };

  const byModelKey = byProvider.filter((r) => r.requestModelKey === facts.requestModelKey);
  if (byModelKey.length === 0) return { ok: false, reason: "MODEL_KEY_NOT_AUTHORIZED" };

  const route = byModelKey.find((r) => r.providerModelId === facts.providerModelId);
  if (route === undefined) return { ok: false, reason: "PROVIDER_MODEL_ID_NOT_AUTHORIZED" };

  // Narrowed to exactly one route; the rest are field checks against it, each
  // reported separately so a refusal names the fact that disagreed.
  if (route.nativeGenerationResolution !== facts.nativeGenerationResolution) {
    return { ok: false, reason: "NATIVE_TIER_NOT_AUTHORIZED" };
  }
  if (!route.targetOutputResolutions.includes(facts.targetOutputResolution)) {
    return { ok: false, reason: "TARGET_RESOLUTION_NOT_AUTHORIZED" };
  }
  if (route.generationMode !== facts.generationMode) {
    return { ok: false, reason: "GENERATION_MODE_NOT_AUTHORIZED" };
  }
  if (route.audioMode !== facts.audioMode) {
    return { ok: false, reason: "AUDIO_MODE_NOT_AUTHORIZED" };
  }
  return { ok: true, route };
}

/** Read-only view, for tests and documentation. Never a selection surface. */
export function authorizedRoutes(): readonly AuthorizedRoute[] {
  return AUTHORIZED_ROUTES;
}
