/**
 * The committed disclosure images (ADR-0071): each is the file the domain table
 * pins, and each still has the geometry and transparency Mode A describes. The
 * renderer is checked against them, so an image re-rendered from the bundled
 * font lands in the same place.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { DISCLOSURE_LAYER_ASSETS, disclosureLayout, type DisclosureLayerAsset } from "@app/domain";
import { DISCLOSURE_FONT_PATH, renderDisclosureLayer } from "./render-disclosure-layer";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const FONT_FILE = `${REPO_ROOT}${DISCLOSURE_FONT_PATH}`;

function committed(asset: DisclosureLayerAsset): Buffer {
  return readFileSync(`${REPO_ROOT}assets/disclosure/${asset.fileName}`);
}

interface Measured {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  /** The smallest rectangle holding every pixel that is not fully transparent. */
  readonly ink: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  readonly maxAlpha: number;
  readonly maxWhiteAlpha: number;
  readonly maxBlackAlpha: number;
  readonly alpha: Uint8Array;
}

async function measure(image: Buffer): Promise<Measured> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const ink = { left: Infinity, top: Infinity, right: -1, bottom: -1 };
  let maxAlpha = 0;
  let maxWhiteAlpha = 0;
  let maxBlackAlpha = 0;
  const alpha = new Uint8Array(info.width * info.height);
  for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
    const at = pixel * info.channels;
    const a = data[at + 3] ?? 0;
    alpha[pixel] = a;
    if (a === 0) continue;
    const x = pixel % info.width;
    const y = Math.floor(pixel / info.width);
    ink.left = Math.min(ink.left, x);
    ink.top = Math.min(ink.top, y);
    ink.right = Math.max(ink.right, x);
    ink.bottom = Math.max(ink.bottom, y);
    maxAlpha = Math.max(maxAlpha, a);
    const [r, g, b] = [data[at], data[at + 1], data[at + 2]];
    if (r === 255 && g === 255 && b === 255) maxWhiteAlpha = Math.max(maxWhiteAlpha, a);
    if (r === 0 && g === 0 && b === 0) maxBlackAlpha = Math.max(maxBlackAlpha, a);
  }
  return { width: info.width, height: info.height, channels: info.channels, ink, maxAlpha, maxWhiteAlpha, maxBlackAlpha, alpha };
}

describe("the bundled font", () => {
  it("is the pinned subset of Noto Sans JP Regular", () => {
    expect(createHash("sha256").update(readFileSync(FONT_FILE)).digest("hex")).toBe(
      "64ae008b81bfd23b75f56aba0c73520daf45ea97287b575c5fd398e3beb2556e",
    );
  });
});

describe.each(DISCLOSURE_LAYER_ASSETS.map((asset) => [`${asset.widthPx}x${asset.heightPx}`, asset] as const))(
  "the %s image",
  (_size, asset) => {
    const layout = disclosureLayout(asset.widthPx, asset.heightPx);

    it("is the file the domain table pins", () => {
      expect(createHash("sha256").update(committed(asset)).digest("hex")).toBe(asset.sha256);
    });

    it("covers the whole frame, so it is laid over the video at the origin", async () => {
      const image = await measure(committed(asset));
      expect([image.width, image.height, image.channels]).toEqual([asset.widthPx, asset.heightPx, 4]);
    });

    it("draws the whole sentence bottom-right, inside the margins but for its one-pixel shadow", async () => {
      const { ink } = await measure(committed(asset));
      const rightGap = asset.widthPx - 1 - ink.right;
      const bottomGap = asset.heightPx - 1 - ink.bottom;
      expect(rightGap).toBeGreaterThanOrEqual(layout.rightMarginPx - 2);
      expect(rightGap).toBeLessThanOrEqual(layout.rightMarginPx);
      expect(bottomGap).toBeGreaterThanOrEqual(layout.bottomMarginPx - 2);
      expect(bottomGap).toBeLessThanOrEqual(layout.bottomMarginPx);
      const inkHeight = ink.bottom - ink.top + 1;
      expect(inkHeight).toBeGreaterThanOrEqual(layout.textHeightPx);
      expect(inkHeight).toBeLessThanOrEqual(layout.textHeightPx + 3);
      // Twenty-four characters on one line: far wider than tall.
      expect(ink.right - ink.left + 1).toBeGreaterThan(20 * layout.textHeightPx);
    });

    it("is never opaque: white text at no more than 70%, a black shadow at no more than 60%", async () => {
      const image = await measure(committed(asset));
      expect(image.maxWhiteAlpha).toBeGreaterThan(0);
      expect(image.maxWhiteAlpha).toBeLessThanOrEqual(Math.round(255 * 0.7));
      expect(image.maxBlackAlpha).toBeGreaterThan(0);
      expect(image.maxBlackAlpha).toBeLessThanOrEqual(Math.round(255 * 0.6));
      // White over shadow: 0.7 + 0.6 × 0.3 = 0.88.
      expect(image.maxAlpha).toBeLessThanOrEqual(Math.ceil(255 * 0.88));
    });

    it("is what the renderer draws from the bundled font", async () => {
      const [again, kept] = await Promise.all([
        measure(await renderDisclosureLayer({ widthPx: asset.widthPx, heightPx: asset.heightPx, fontFile: FONT_FILE })),
        measure(committed(asset)),
      ]);
      expect(again.ink).toEqual(kept.ink);
      let largest = 0;
      for (let pixel = 0; pixel < kept.alpha.length; pixel += 1) {
        largest = Math.max(largest, Math.abs((again.alpha[pixel] ?? 0) - (kept.alpha[pixel] ?? 0)));
      }
      // A different text renderer may shade an edge differently, never move the text.
      expect(largest).toBeLessThanOrEqual(16);
    });
  },
);
