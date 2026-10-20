/**
 * The committed disclosure images (ADR-0071): each is the file the domain table
 * pins, and each still has the geometry and transparency Mode A describes. The
 * renderer is checked against them, so an image re-rendered from the bundled
 * font, under the bundled font configuration, lands in the same place.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { DISCLOSURE_LAYER_ASSETS, disclosureLayout, type DisclosureLayerAsset } from "@app/domain";
import {
  DISCLOSURE_FONT_FAMILY,
  DISCLOSURE_FONT_PATH,
  DISCLOSURE_FONTCONFIG_PATH,
  renderDisclosureLayer,
} from "./render-disclosure-layer";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const FONT_FILE = `${REPO_ROOT}${DISCLOSURE_FONT_PATH}`;
const FONT_CONFIG_FILE = `${REPO_ROOT}${DISCLOSURE_FONTCONFIG_PATH}`;

// fontconfig reads it when this process first draws text, which is below:
// vitest runs each test file in a process of its own.
process.env.FONTCONFIG_FILE = FONT_CONFIG_FILE;

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
  /** Visible pixels whose red, green and blue are not all equal: colour fringes. */
  readonly coloured: number;
  /** Each pixel's red, green and blue weighted by its alpha, then its alpha. */
  readonly premultiplied: Uint8Array;
}

async function measure(image: Buffer): Promise<Measured> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const ink = { left: Infinity, top: Infinity, right: -1, bottom: -1 };
  let maxAlpha = 0;
  let maxWhiteAlpha = 0;
  let maxBlackAlpha = 0;
  let coloured = 0;
  const premultiplied = new Uint8Array(info.width * info.height * 4);
  for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
    const at = pixel * info.channels;
    const a = data[at + 3] ?? 0;
    for (let channel = 0; channel < 3; channel += 1) {
      premultiplied[pixel * 4 + channel] = Math.round(((data[at + channel] ?? 0) * a) / 255);
    }
    premultiplied[pixel * 4 + 3] = a;
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
    if (r !== g || g !== b) coloured += 1;
  }
  return {
    width: info.width,
    height: info.height,
    channels: info.channels,
    ink,
    maxAlpha,
    maxWhiteAlpha,
    maxBlackAlpha,
    coloured,
    premultiplied,
  };
}

describe("the bundled font", () => {
  it("is the pinned subset of Noto Sans JP Regular", () => {
    expect(createHash("sha256").update(readFileSync(FONT_FILE)).digest("hex")).toBe(
      "64ae008b81bfd23b75f56aba0c73520daf45ea97287b575c5fd398e3beb2556e",
    );
  });

  it("is named for the family the renderer asks for", () => {
    // Font names are stored as UTF-16 big-endian.
    expect(readFileSync(FONT_FILE).includes(Buffer.from(DISCLOSURE_FONT_FAMILY, "utf16le").swap16())).toBe(true);
  });
});

describe("the font configuration", () => {
  it("loads no installed font and draws without hinting or colour fringes", () => {
    const config = readFileSync(FONT_CONFIG_FILE, "utf8").replace(/<!--[\s\S]*?-->/g, "");
    expect(config).not.toMatch(/<(dir|include|cachedir)\b/);
    for (const [name, value] of [
      ["antialias", "<bool>true</bool>"],
      ["hinting", "<bool>false</bool>"],
      ["hintstyle", "<const>hintnone</const>"],
      ["autohint", "<bool>false</bool>"],
      ["rgba", "<const>none</const>"],
      ["lcdfilter", "<const>lcdnone</const>"],
    ]) {
      expect(config).toContain(`<edit name="${name}" mode="assign">${value}</edit>`);
    }
  });

  it("is required: the renderer refuses to draw under any other", async () => {
    await expect(
      renderDisclosureLayer({ widthPx: 1280, heightPx: 720, fontFile: FONT_FILE, fontConfigFile: "/etc/fonts/fonts.conf" }),
    ).rejects.toThrow(/its own font configuration/);
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

    it("draws the whole sentence bottom-right, on the margins but for its one-pixel shadow", async () => {
      const { ink } = await measure(committed(asset));
      // The shadow is the text one pixel down and right, so the ink ends exactly
      // one pixel past the text, which ends on the margins.
      expect(asset.widthPx - 1 - ink.right).toBe(layout.rightMarginPx - 1);
      expect(asset.heightPx - 1 - ink.bottom).toBe(layout.bottomMarginPx - 1);
      // The text's height, or a row more where anti-aliasing reaches below, and the shadow's row.
      const inkHeight = ink.bottom - ink.top + 1;
      expect(inkHeight).toBeGreaterThanOrEqual(layout.textHeightPx + 1);
      expect(inkHeight).toBeLessThanOrEqual(layout.textHeightPx + 2);
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

    it("is white and black only, with no colour fringe", async () => {
      expect((await measure(committed(asset))).coloured).toBe(0);
    });

    it("is what the renderer draws from the bundled font, in the same place and colours", async () => {
      const [again, kept] = await Promise.all([
        measure(
          await renderDisclosureLayer({
            widthPx: asset.widthPx,
            heightPx: asset.heightPx,
            fontFile: FONT_FILE,
            fontConfigFile: FONT_CONFIG_FILE,
          }),
        ),
        measure(committed(asset)),
      ]);
      expect(again.coloured).toBe(0);
      expect(again.ink).toEqual(kept.ink);
      let largest = 0;
      for (let value = 0; value < kept.premultiplied.length; value += 1) {
        largest = Math.max(largest, Math.abs((again.premultiplied[value] ?? 0) - (kept.premultiplied[value] ?? 0)));
      }
      // A different text renderer may shade an edge differently, never move the
      // text or change its colour: grey instead of white is 36 apart.
      expect(largest).toBeLessThanOrEqual(16);
    });
  },
);
