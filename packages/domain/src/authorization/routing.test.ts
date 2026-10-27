import { describe, expect, it } from "vitest";
import {
  AUTHORIZED_QUALITY_TIERS,
  H3_MAX_PROVIDER_MODEL_ID,
  PRODUCTION_ROUTE_POLICY,
  ROUTING_POLICY_VERSION,
  authorizeRoute,
  authorizedRoutes,
  defineRoutePolicy,
  servesQualityTier,
  type RouteAuthorizationFacts,
  type RoutePolicy,
} from "./routing";

const H3_MAX: RouteAuthorizationFacts = {
  qualityTier: "NORMAL",
  providerName: "fal",
  providerModelId: H3_MAX_PROVIDER_MODEL_ID,
  requestModelKey: "minimax-h3-max",
  nativeGenerationResolution: "768P",
  targetOutputResolution: "720p",
  generationMode: "image-to-video",
  audioMode: "none",
};

describe("route policies (ADR-0089)", () => {
  it("makes production's from the table above and nothing else, frozen", () => {
    expect(PRODUCTION_ROUTE_POLICY).toEqual({
      version: ROUTING_POLICY_VERSION,
      qualityTiers: AUTHORIZED_QUALITY_TIERS,
      routes: authorizedRoutes(),
    });
    expect(Object.isFrozen(PRODUCTION_ROUTE_POLICY)).toBe(true);
    expect(Object.isFrozen(PRODUCTION_ROUTE_POLICY.routes)).toBe(true);
  });

  it("authorizes against the policy given, its qualities and its routes", () => {
    const hq: RoutePolicy = {
      version: "itest-policy.1",
      qualityTiers: ["HIGH_QUALITY"],
      routes: authorizedRoutes().map((route) => ({ ...route, qualityTier: "HIGH_QUALITY" })),
    };
    expect(authorizeRoute({ ...H3_MAX, qualityTier: "HIGH_QUALITY" }, hq).ok).toBe(true);
    expect(authorizeRoute(H3_MAX, hq)).toEqual({ ok: false, reason: "QUALITY_TIER_ROUTE_NOT_AUTHORIZED" });
    // A quality listed with no route for it is refused the same way.
    const listedOnly: RoutePolicy = { ...hq, routes: [] };
    expect(authorizeRoute({ ...H3_MAX, qualityTier: "HIGH_QUALITY" }, listedOnly)).toEqual({
      ok: false,
      reason: "QUALITY_TIER_ROUTE_NOT_AUTHORIZED",
    });
  });

  it("serves a quality only when it is listed and has a route, as the gate checks", () => {
    const hq = authorizedRoutes().map((route) => ({ ...route, qualityTier: "HIGH_QUALITY" as const }));
    expect(servesQualityTier(PRODUCTION_ROUTE_POLICY, "NORMAL")).toBe(true);
    expect(servesQualityTier(PRODUCTION_ROUTE_POLICY, "HIGH_QUALITY")).toBe(false);
    const policy: RoutePolicy = { version: "itest-policy.1", qualityTiers: ["HIGH_QUALITY"], routes: hq };
    expect(servesQualityTier(policy, "HIGH_QUALITY")).toBe(true);
    expect(servesQualityTier({ ...policy, routes: [] }, "HIGH_QUALITY")).toBe(false);
    expect(servesQualityTier({ ...policy, qualityTiers: [] }, "HIGH_QUALITY")).toBe(false);
  });
});

describe("defining a route policy outside production (ADR-0089)", () => {
  const routes = authorizedRoutes();
  const valid: RoutePolicy = { version: "itest-policy.1", qualityTiers: ["NORMAL"], routes };

  it("returns a frozen copy of a consistent policy", () => {
    const defined = defineRoutePolicy(valid);
    expect(defined).toEqual(valid);
    expect(defined).not.toBe(valid);
    expect(Object.isFrozen(defined)).toBe(true);
    expect(Object.isFrozen(defined.routes[0]?.targetOutputResolutions)).toBe(true);
    // The input's own arrays are left as they were.
    const routesIn = routes.map((route) => ({ ...route, targetOutputResolutions: [...route.targetOutputResolutions] }));
    defineRoutePolicy({ ...valid, routes: routesIn });
    expect(Object.isFrozen(routesIn)).toBe(false);
    expect(Object.isFrozen(routesIn[0]?.targetOutputResolutions)).toBe(false);
  });

  it("refuses an empty version, and production's", () => {
    expect(() => defineRoutePolicy({ ...valid, version: " " })).toThrow(/version of its own/);
    expect(() => defineRoutePolicy({ ...valid, version: ROUTING_POLICY_VERSION })).toThrow(/version of its own/);
  });

  it("refuses a quality listed with no route, or twice", () => {
    expect(() => defineRoutePolicy({ ...valid, qualityTiers: ["NORMAL", "HIGH_QUALITY"] })).toThrow(
      /HIGH_QUALITY with no route/,
    );
    expect(() => defineRoutePolicy({ ...valid, qualityTiers: ["NORMAL", "NORMAL"] })).toThrow(/twice/);
  });

  it("refuses a route whose quality is not listed", () => {
    const hq = { ...routes[0]!, qualityTier: "HIGH_QUALITY" as const };
    expect(() => defineRoutePolicy({ ...valid, routes: [...routes, hq] })).toThrow(/does not list HIGH_QUALITY/);
  });
});

describe("route authorization", () => {
  it("authorizes the Normal AI H3 Max route", () => {
    const result = authorizeRoute(H3_MAX);
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.route.providerName).toBe("fal");
    expect(result.route.providerModelId).toBe("minimax/h3-max/image-to-video");
  });

  it("names fal as the provider for H3 Max, never google-veo", () => {
    // A route names whoever the request is sent to and whoever invoices, not
    // the model's manufacturer.
    for (const route of authorizedRoutes()) {
      expect(route.providerName).not.toBe("google-veo");
      expect(route.providerName).not.toBe("google");
    }
  });

  it("serves both product targets from the same 768P generation", () => {
    // 1080p is an upscale of a 768P generation. The route lists both targets
    // against one native tier rather than claiming a native 1080p.
    const h3 = authorizedRoutes().find((r) => r.requestModelKey === "minimax-h3-max");
    expect(h3?.nativeGenerationResolution).toBe("768P");
    expect(h3?.targetOutputResolutions).toEqual(["720p", "1080p"]);
    expect(authorizeRoute({ ...H3_MAX, targetOutputResolution: "1080p" }).ok).toBe(true);
  });

  it.each([
    ["providerName", { providerName: "openai" }, "PROVIDER_NOT_AUTHORIZED"],
    [
      "providerModelId",
      { providerModelId: "minimax/h3/image-to-video" },
      "PROVIDER_MODEL_ID_NOT_AUTHORIZED",
    ],
    ["requestModelKey", { requestModelKey: "minimax-h3" }, "MODEL_KEY_NOT_AUTHORIZED"],
    [
      "nativeGenerationResolution",
      { nativeGenerationResolution: "1080p" },
      "NATIVE_TIER_NOT_AUTHORIZED",
    ],
    ["generationMode", { generationMode: "text-to-video" }, "GENERATION_MODE_NOT_AUTHORIZED"],
    ["audioMode", { audioMode: "on" }, "AUDIO_MODE_NOT_AUTHORIZED"],
  ] as const)("refuses a wrong %s", (_field, patch, reason) => {
    const result = authorizeRoute({ ...H3_MAX, ...patch });
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe(reason);
  });

  it("authorizes no HIGH_QUALITY route at all", () => {
    // Veo remains benchmark-gated with no adapter, no credential and no factory
    // branch. An authorized route would send an attempt to a boundary with
    // nothing behind it.
    expect(AUTHORIZED_QUALITY_TIERS).toEqual(["NORMAL"]);
    expect(authorizedRoutes().some((r) => r.qualityTier === "HIGH_QUALITY")).toBe(false);
    const result = authorizeRoute({ ...H3_MAX, qualityTier: "HIGH_QUALITY" });
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("QUALITY_TIER_ROUTE_NOT_AUTHORIZED");
  });

  it("carries no Veo route under any provider name", () => {
    for (const route of authorizedRoutes()) {
      expect(route.requestModelKey).not.toContain("veo");
      expect(route.providerModelId).not.toContain("veo");
    }
  });

  it("compares opaque tokens exactly, never by parsing them", () => {
    // A renamed tier must become a lookup miss rather than a silently
    // reinterpreted one, so no prefix, suffix or case-insensitive match.
    expect(authorizeRoute({ ...H3_MAX, nativeGenerationResolution: "768p" }).ok).toBe(false);
    expect(authorizeRoute({ ...H3_MAX, providerName: "FAL" }).ok).toBe(false);
    expect(
      authorizeRoute({ ...H3_MAX, providerModelId: "minimax/h3-max/image-to-video/v2" }).ok,
    ).toBe(false);
  });
});
