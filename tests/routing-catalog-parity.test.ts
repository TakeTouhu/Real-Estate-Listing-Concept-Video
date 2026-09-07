import { describe, expect, it } from "vitest";
import { H3_MAX_PROVIDER_MODEL_ID, authorizedRoutes } from "@app/domain";
import {
  MINIMAX_H3_MAX_MODEL_ID,
  createVideoModelCatalog,
} from "@app/video-providers";

/**
 * The one duplicated string, kept honest.
 *
 * `@app/domain` cannot import `@app/video-providers` — that would invert the
 * dependency direction and put a concrete provider adapter inside the layer
 * that decides whether money may be spent. So the routing authorization table
 * carries its own copy of the executable model id, and this test is what stops
 * the two from drifting: it is in `tests/`, which may depend on both packages,
 * and it fails the build rather than leaving a comment asking people to
 * remember.
 *
 * This is a *parity* check, not a second catalog. It asserts the facts that
 * appear in both places agree, and nothing about capability envelopes, native
 * generation policy, pricing or availability, all of which have exactly one
 * authority and are not duplicated at all.
 */
describe("routing authorization and the executable model catalog agree", () => {
  it("uses the same H3 Max provider model id", () => {
    expect(H3_MAX_PROVIDER_MODEL_ID).toBe(MINIMAX_H3_MAX_MODEL_ID);
  });

  it("names a model key and provider the catalog also verifies", () => {
    const catalog = createVideoModelCatalog();
    for (const route of authorizedRoutes()) {
      const entry = catalog.find(route.requestModelKey);
      expect(`${route.requestModelKey}: ${entry !== undefined}`).toBe(
        `${route.requestModelKey}: true`,
      );
      expect(entry?.providerName).toBe(route.providerName);
    }
  });

  it("authorizes no route the catalog cannot execute", () => {
    // A route whose model has no verified capability would send an attempt to
    // a boundary with nothing behind it. Pricing verification and executable
    // verification are separate concerns, and routing needs both.
    const catalog = createVideoModelCatalog();
    for (const route of authorizedRoutes()) {
      const entry = catalog.find(route.requestModelKey);
      expect(`${route.requestModelKey}: ${entry?.availability.kind}`).toBe(
        `${route.requestModelKey}: SELECTABLE`,
      );
      expect(entry?.providerModelId).toBe(route.providerModelId);
    }
  });

  it("generates H3 Max at the tier the catalog documents", () => {
    const catalog = createVideoModelCatalog();
    const entry = catalog.find("minimax-h3-max");
    const h3Route = authorizedRoutes().find((r) => r.requestModelKey === "minimax-h3-max");
    // 720p and 1080p are both served from one 768P generation; the second is an
    // upscale. Neither the catalog nor the route may claim native 1080p.
    expect(entry?.capability?.nativeGenerationResolutions).toContain(
      h3Route?.nativeGenerationResolution,
    );
    expect(entry?.nativeGeneration?.byTarget["1080p"]?.nativeMeetsTarget).toBe(false);
    expect(entry?.nativeGeneration?.byTarget["1080p"]?.nativeGenerationResolution.providerValue)
      .toBe("768P");
  });
});
