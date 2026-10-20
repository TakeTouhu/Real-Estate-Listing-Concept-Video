/**
 * The committed disclosure images (ADR-0071), laid over a real encode.
 *
 * DS-5 will have the composer lay the image for the frame size over the video at
 * the origin. This suite proves the method before any composer depends on it:
 * each of the six images, over neutral and coloured clips, encoded with
 * composition profile v1's own settings, comes out of FFmpeg with the lightness
 * of the image's straight-alpha blend over the background, within what H.264 at
 * CRF 18 changes, and leaves the rest of the frame as it was. On the white floor
 * the shadow is what keeps the white text readable, and it survives the encode.
 *
 * The overlay graph here is the method, not yet product code. When DS-5 moves it
 * into the composer, this suite drives the composer instead.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DISCLOSURE_LAYER_ASSETS, resolveCompositionProfile, type CompositionProfile } from "@app/domain";
import { decodeFrame, decodeRgba, ffmpeg } from "./media-tools";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Three neutrals, and the colours a room is likely to show behind the text.
const BACKGROUNDS = [
  { name: "mid grey", hex: "808080" },
  { name: "white floor", hex: "f2f2f2" },
  { name: "dark room", hex: "202020" },
  { name: "blue sky", hex: "2060c0" },
  { name: "green garden", hex: "30a040" },
  { name: "red brick", hex: "c03030" },
  { name: "yellow wall", hex: "f0e060" },
  { name: "beige plaster", hex: "d8c8a8" },
  { name: "dark wood", hex: "6a4a30" },
] as const;

/**
 * Lightness, as BT.601 luma: the plane `yuv420p` keeps at full resolution, and
 * what the text's legibility rests on. The colour planes are halved in each
 * direction, so a saturated background's colour spreads into the text's edges;
 * this measure leaves that out, and an exact decode leaves it out too.
 */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Every frame size the images cover is a composition profile v1 raster. */
function profileFor(widthPx: number, heightPx: number): CompositionProfile {
  for (const targetAspectRatio of ["16:9", "9:16", "1:1"]) {
    for (const targetOutputResolution of ["720p", "1080p"]) {
      const outcome = resolveCompositionProfile({ targetAspectRatio, targetOutputResolution });
      if (
        outcome.kind === "RESOLVED" &&
        outcome.profile.targetWidthPx === widthPx &&
        outcome.profile.targetHeightPx === heightPx
      ) {
        return outcome.profile;
      }
    }
  }
  throw new Error(`no composition profile v1 raster is ${widthPx}x${heightPx}`);
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-disclosure-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.each(DISCLOSURE_LAYER_ASSETS.map((asset) => [`${asset.widthPx}x${asset.heightPx}`, asset] as const))(
  "the %s image",
  (_size, asset) => {
    const { widthPx: width, heightPx: height } = asset;
    const profile = profileFor(width, height);
    const imagePath = `${REPO_ROOT}assets/disclosure/${asset.fileName}`;
    let image: Buffer;
    /** The smallest rectangle holding every pixel of the image that is not fully transparent. */
    const ink = { left: Infinity, top: Infinity, right: -1, bottom: -1 };
    // H.264 codes 16-pixel macroblocks; beyond the one holding the text's
    // edge, the frame must be the background itself.
    const margin = 16;
    const nearInk = (x: number, y: number): boolean =>
      x >= ink.left - margin && x <= ink.right + margin && y >= ink.top - margin && y <= ink.bottom + margin;

    beforeAll(async () => {
      image = await decodeRgba(dir, imagePath);
      expect(image).toHaveLength(width * height * 4);
      for (let at = 0; at < width * height; at += 1) {
        if ((image[at * 4 + 3] ?? 0) === 0) continue;
        ink.left = Math.min(ink.left, at % width);
        ink.top = Math.min(ink.top, Math.floor(at / width));
        ink.right = Math.max(ink.right, at % width);
        ink.bottom = Math.max(ink.bottom, Math.floor(at / width));
      }
    });

    it.each(BACKGROUNDS)("over a $name clip keeps the text's lightness, and nothing else changes", async ({ hex }) => {
      const output = join(dir, `${width}x${height}-${hex}.mp4`);
      await ffmpeg([
        "-f", "lavfi", "-i", `color=c=0x${hex}:s=${width}x${height}:r=30:d=1`,
        "-loop", "1", "-i", imagePath,
        "-filter_complex", `[0:v][1:v]overlay=0:0:format=auto:shortest=1,format=${profile.pixelFormat}[out]`,
        "-map", "[out]", "-an",
        "-c:v", "libx264", "-preset", profile.encoderPreset, "-crf", String(profile.crf), "-pix_fmt", profile.pixelFormat,
        "-f", "mp4", output,
      ]);
      const frame = await decodeFrame(dir, output, 15);
      expect(frame).toHaveLength(width * height * 3);

      // The background as it decodes, from the frame's top-left corner, well
      // clear of the text. A saturated colour comes back a few levels from the
      // one asked for (3 at most, measured), which is the encode, not the text.
      expect(nearInk(0, 0)).toBe(false);
      const background = [frame[0] ?? -1, frame[1] ?? -1, frame[2] ?? -1] as const;
      const requested = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
      for (let channel = 0; channel < 3; channel += 1) {
        expect(Math.abs((background[channel] ?? -1) - (requested[channel] ?? -1))).toBeLessThanOrEqual(6);
      }
      const backgroundLuma = luma(...background);

      let inkError = 0;
      let largestInkError = 0;
      let largestElsewhere = 0;
      const contrast: number[] = [];
      for (let at = 0; at < width * height; at += 1) {
        const got = [frame[at * 3] ?? -1, frame[at * 3 + 1] ?? -1, frame[at * 3 + 2] ?? -1] as const;
        const alpha = (image[at * 4 + 3] ?? 0) / 255;
        if (alpha > 0) {
          // Luma is linear, so the blend's luma is the blend of the lumas.
          const imageLuma = luma(image[at * 4] ?? 0, image[at * 4 + 1] ?? 0, image[at * 4 + 2] ?? 0);
          const error = Math.abs(luma(...got) - (imageLuma * alpha + backgroundLuma * (1 - alpha)));
          inkError += error;
          largestInkError = Math.max(largestInkError, error);
          contrast.push(Math.abs(luma(...got) - backgroundLuma));
        } else if (!nearInk(at % width, Math.floor(at / width))) {
          for (let channel = 0; channel < 3; channel += 1) {
            largestElsewhere = Math.max(largestElsewhere, Math.abs((got[channel] ?? -1) - (background[channel] ?? -1)));
          }
        }
      }

      // Measured on Ubuntu 24.04's FFmpeg 6.1.1 over all nine backgrounds: a
      // mean of 1.31 to 1.69 and a largest error of 6.3 to 16.6 levels of 255,
      // and the background exact.
      expect(contrast.length).toBeGreaterThan(0);
      expect(inkError / contrast.length).toBeLessThanOrEqual(3);
      expect(largestInkError).toBeLessThanOrEqual(24);
      expect(largestElsewhere).toBeLessThanOrEqual(2);
      // The text stands out from each: the strongest 1% of it (20 to 54
      // pixels) stands at least 72 levels from the background, measured 82 on mid
      // grey to 158. On a light floor that is the shadow, below the floor; in a
      // dark room the white, above it.
      contrast.sort((a, b) => a - b);
      expect(contrast[Math.floor(0.99 * (contrast.length - 1))]).toBeGreaterThanOrEqual(72);
    });
  },
);
