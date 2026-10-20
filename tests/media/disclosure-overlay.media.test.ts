/**
 * The committed disclosure images (ADR-0071), laid over a real encode.
 *
 * DS-5 will have the composer lay the image for the frame size over the video at
 * the origin. This suite proves the method before any composer depends on it:
 * each of the six images, over a mid-grey, a near-white and a near-black clip,
 * encoded with composition profile v1's own settings, comes out of FFmpeg as
 * the image's straight-alpha blend over the background, within what H.264 at
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

const BACKGROUNDS = [
  { name: "mid grey", rgb: [0x80, 0x80, 0x80] },
  { name: "white floor", rgb: [0xf2, 0xf2, 0xf2] },
  { name: "dark room", rgb: [0x20, 0x20, 0x20] },
] as const;

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

    it.each(BACKGROUNDS)("over a $name clip is its blend over the background, and nothing else changes", async ({ rgb }) => {
      const background = `0x${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
      const output = join(dir, `${width}x${height}-${background}.mp4`);
      await ffmpeg([
        "-f", "lavfi", "-i", `color=c=${background}:s=${width}x${height}:r=30:d=1`,
        "-loop", "1", "-i", imagePath,
        "-filter_complex", `[0:v][1:v]overlay=0:0:format=auto:shortest=1,format=${profile.pixelFormat}[out]`,
        "-map", "[out]", "-an",
        "-c:v", "libx264", "-preset", profile.encoderPreset, "-crf", String(profile.crf), "-pix_fmt", profile.pixelFormat,
        "-f", "mp4", output,
      ]);
      const frame = await decodeFrame(dir, output, 15);
      expect(frame).toHaveLength(width * height * 3);

      let inkError = 0;
      let inkSamples = 0;
      let largestInkError = 0;
      let largestElsewhere = 0;
      let darkest = 255;
      let lightest = 0;
      // H.264 codes 16-pixel macroblocks; beyond the one holding the text's
      // edge, the frame must be the background itself.
      const margin = 16;
      for (let at = 0; at < width * height; at += 1) {
        const x = at % width;
        const y = Math.floor(at / width);
        const alpha = (image[at * 4 + 3] ?? 0) / 255;
        const nearInk = x >= ink.left - margin && x <= ink.right + margin && y >= ink.top - margin && y <= ink.bottom + margin;
        for (let channel = 0; channel < 3; channel += 1) {
          const got = frame[at * 3 + channel] ?? -1;
          const backgroundValue = rgb[channel] ?? -1;
          if (alpha > 0) {
            const expected = Math.round((image[at * 4 + channel] ?? 0) * alpha + backgroundValue * (1 - alpha));
            const error = Math.abs(got - expected);
            inkError += error;
            inkSamples += 1;
            largestInkError = Math.max(largestInkError, error);
            darkest = Math.min(darkest, got);
            lightest = Math.max(lightest, got);
          } else if (!nearInk) {
            largestElsewhere = Math.max(largestElsewhere, Math.abs(got - backgroundValue));
          }
        }
      }

      // Measured on Ubuntu 24.04's FFmpeg 6.1.1: a mean of 1.25 to 1.75 and a
      // largest error of 8 to 15 levels of 255, and the background exact to 1.
      expect(inkError / inkSamples).toBeLessThanOrEqual(3);
      expect(largestInkError).toBeLessThanOrEqual(24);
      expect(largestElsewhere).toBeLessThanOrEqual(2);
      // The text stands out from each: the shadow well below a light floor,
      // the white well above a dark one, and either, by about 90, from grey.
      const [floor] = rgb;
      expect(Math.max(floor - darkest, lightest - floor)).toBeGreaterThanOrEqual(80);
    });
  },
);
