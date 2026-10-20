/**
 * The AI-generated disclosure layer v1 (ADR-0071): the exact text, Mode A's
 * geometry for every size composition can produce, and the closed table of
 * committed images.
 */

import { describe, expect, it } from "vitest";
import { COMPOSABLE_TARGETS, resolveCompositionProfile } from "../deliverable-composition-execution/profile";
import {
  AI_DISCLOSURE_TEXT,
  DISCLOSURE_LAYER_ASSETS,
  DISCLOSURE_LAYER_KEY,
  DISCLOSURE_MARGIN_PERCENT,
  DISCLOSURE_MIN_TEXT_HEIGHT_PX,
  DISCLOSURE_SHADOW,
  DISCLOSURE_TEXT_HEIGHT_PER_TEN_THOUSAND,
  DISCLOSURE_TEXT_OPACITY,
  disclosureLayerFor,
  disclosureLayout,
} from "./ai-disclosure";

/** Every raster composition profile v1 produces, as `WxH`. */
function composableRasters(): string[] {
  return COMPOSABLE_TARGETS.map((target) => {
    const outcome = resolveCompositionProfile(target);
    if (outcome.kind !== "RESOLVED") throw new Error("a composable target did not resolve");
    return `${outcome.profile.targetWidthPx}x${outcome.profile.targetHeightPx}`;
  }).sort();
}

describe("the text", () => {
  it("is ADR-0052 Decision 8's sentence, character for character", () => {
    expect(AI_DISCLOSURE_TEXT).toBe("本コンテンツは生成AIを使用して作成しています。");
    expect([...AI_DISCLOSURE_TEXT]).toHaveLength(24);
  });
});

describe("Mode A's geometry", () => {
  const EXPECTED: [number, number, number, number, number][] = [
    // width, height, text height, right margin, bottom margin
    [1280, 720, 12, 38, 22],
    [1920, 1080, 14, 58, 32],
    [720, 1280, 16, 22, 38],
    [1080, 1920, 24, 32, 58],
    [720, 720, 12, 22, 22],
    [1080, 1080, 14, 32, 32],
  ];

  for (const [width, height, textHeightPx, rightMarginPx, bottomMarginPx] of EXPECTED) {
    it(`places it in a ${width}x${height} frame`, () => {
      expect(disclosureLayout(width, height)).toEqual({ textHeightPx, rightMarginPx, bottomMarginPx });
    });
  }

  it("covers every size composition can produce", () => {
    expect(EXPECTED.map(([w, h]) => `${w}x${h}`).sort()).toEqual(composableRasters());
  });

  it("is 1.25% of the height, rounding a half up, unless that is under 12 pixels", () => {
    expect(DISCLOSURE_TEXT_HEIGHT_PER_TEN_THOUSAND).toBe(125);
    expect(DISCLOSURE_MIN_TEXT_HEIGHT_PX).toBe(12);
    expect(disclosureLayout(1920, 1080).textHeightPx).toBe(14);
    expect(disclosureLayout(1920, 1040).textHeightPx).toBe(13);
    expect(disclosureLayout(1280, 959).textHeightPx).toBe(12);
    expect(disclosureLayout(1280, 1000).textHeightPx).toBe(13);
    expect(disclosureLayout(1280, 720).textHeightPx).toBe(12);
    expect(disclosureLayout(100, 100).textHeightPx).toBe(12);
  });

  it("puts 3% of the width on the right and 3% of the height below", () => {
    expect(DISCLOSURE_MARGIN_PERCENT).toBe(3);
    expect(disclosureLayout(1000, 2000)).toMatchObject({ rightMarginPx: 30, bottomMarginPx: 60 });
    expect(disclosureLayout(2000, 1000)).toMatchObject({ rightMarginPx: 60, bottomMarginPx: 30 });
  });

  it("is white at 70% over a faint black shadow one pixel down and right", () => {
    expect(DISCLOSURE_TEXT_OPACITY).toBe(0.7);
    expect(DISCLOSURE_SHADOW).toEqual({ offsetPx: 1, blurSigma: 0.5, opacity: 0.6 });
    expect(DISCLOSURE_LAYER_KEY).toBe("vtavision-disclosure:v1");
  });
});

describe("the committed images", () => {
  it("are exactly one per size composition can produce", () => {
    expect(DISCLOSURE_LAYER_ASSETS.map((one) => `${one.widthPx}x${one.heightPx}`).sort()).toEqual(
      composableRasters(),
    );
  });

  it("are named for their size and pinned by checksum", () => {
    for (const asset of DISCLOSURE_LAYER_ASSETS) {
      expect(asset.fileName).toBe(`layer-v1-${asset.widthPx}x${asset.heightPx}.png`);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(DISCLOSURE_LAYER_ASSETS.map((one) => one.sha256)).size).toBe(DISCLOSURE_LAYER_ASSETS.length);
  });

  it("answers each size with its own image, and no other size at all", () => {
    for (const asset of DISCLOSURE_LAYER_ASSETS) {
      expect(disclosureLayerFor(asset.widthPx, asset.heightPx)).toBe(asset);
    }
    expect(disclosureLayerFor(1366, 768)).toBeNull();
    expect(disclosureLayerFor(720, 1920)).toBeNull();
    expect(disclosureLayerFor(1080, 720)).toBeNull();
  });
});
