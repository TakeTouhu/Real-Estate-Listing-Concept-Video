/**
 * The dormant deliverable composer and media inspector, on real FFmpeg.
 *
 * Every other suite drives them through a fake process runner, which proves the
 * argument vector and the outcome mapping but not that FFmpeg does what the
 * vector says. Here the composer encodes two synthetic clips into the Clean
 * Master for each of the six composition profile v1 rasters, then lays the
 * disclosure over that master to make the customer's video (ADR-0075), and the
 * inspector measures both: the exact frame size, the sum of the scene lengths,
 * one video stream and no audio. Decoded frames then show the clips letterboxed
 * rather than cropped, the longer clip trimmed from its start, and the shorter
 * one holding its last frame rather than ending early, looping or holding its
 * first. The customer's video carries the disclosure where its image puts it,
 * and is the master everywhere else; the master carries none. And neither
 * carries the tags or chapters the first clip arrives with, as a provider's
 * might.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COMPOSABLE_TARGETS,
  ISO_BMFF_CONTAINER,
  disclosureLayerFor,
  resolveCompositionProfile,
  type CompositionProfile,
} from "@app/domain";
import { createFfmpegDeliverableComposer, FfprobeMediaProbe } from "@app/storage";
import { decodeFrame, decodeRgba, ffmpeg, probeEverything, probeStreams, runner } from "./media-tools";

const LAYER_DIRECTORY = fileURLToPath(new URL("../../assets/disclosure", import.meta.url));

// A 16:9 clip at 25 fps with a tone, two seconds long, whose timestamps start
// at 3 seconds (a clip need not start at zero): blue, turning green at 1.6
// seconds. And a 9:16 clip at 24 fps, one second long: red, turning yellow for
// its last two frames. The deliverable gives the first 1.5 seconds, so it is
// trimmed and must never show green, and the second 2 seconds, so it holds its
// last frame and must show yellow, not red, after its source ends. The first
// clip also carries a title, a comment, a stream handler name and a chapter,
// each marked PROVIDER_TAG, standing in for what a provider's file could carry.
// The chapter runs past the clip's 3-second start, or FFmpeg would drop it
// whatever the composer asked.
const LANDSCAPE_SCENE_SECONDS = 1.5;
const PORTRAIT_SCENE_SECONDS = 2;
const FRAME_COUNT = (LANDSCAPE_SCENE_SECONDS + PORTRAIT_SCENE_SECONDS) * 30;

const PROVIDER_TAG = "provider-x";

let dir: string;
let landscape: string;
let portrait: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-composer-"));
  landscape = join(dir, "landscape.mp4");
  portrait = join(dir, "portrait.mp4");
  const tags = join(dir, "tags.txt");
  await writeFile(
    tags,
    `;FFMETADATA1\ntitle=${PROVIDER_TAG}-title\ncomment=${PROVIDER_TAG}-comment\n\n` +
      `[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=10000\ntitle=${PROVIDER_TAG}-chapter\n`,
  );
  await ffmpeg([
    "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=25:d=2,drawbox=c=green:t=fill:enable='gte(t,1.6)'",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
    "-i", tags, "-map", "0", "-map", "1", "-map_metadata", "2", "-map_chapters", "2",
    "-metadata:s:v:0", `handler_name=${PROVIDER_TAG}-stream`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-output_ts_offset", "3", landscape,
  ]);
  await ffmpeg([
    "-f", "lavfi", "-i", "color=c=red:s=360x640:r=24:d=1,drawbox=c=yellow:t=fill:enable='gte(t,0.9)'",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", portrait,
  ]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function profileFor(target: (typeof COMPOSABLE_TARGETS)[number]): CompositionProfile {
  const outcome = resolveCompositionProfile(target);
  if (outcome.kind !== "RESOLVED") throw new Error("every composable target resolves");
  return outcome.profile;
}

type Rgb = readonly [number, number, number];

function pixel(frame: Buffer, width: number, x: number, y: number): Rgb {
  const at = (y * width + x) * 3;
  return [frame[at] ?? -1, frame[at + 1] ?? -1, frame[at + 2] ?? -1];
}

const isBlack = ([r, g, b]: Rgb): boolean => r <= 8 && g <= 8 && b <= 8;
const isRed = ([r, g, b]: Rgb): boolean => r >= 200 && g <= 40 && b <= 40;
const isBlue = ([r, g, b]: Rgb): boolean => r <= 40 && g <= 40 && b >= 200;
const isYellow = ([r, g, b]: Rgb): boolean => r >= 200 && g >= 200 && b <= 40;

/** BT.601 luma, the plane `yuv420p` keeps at full resolution (ADR-0072 Decision 5). */
const luma = ([r, g, b]: Rgb): number => 0.299 * r + 0.587 * g + 0.114 * b;

describe.each(COMPOSABLE_TARGETS.map((target) => [`${target.targetAspectRatio} ${target.targetOutputResolution}`, target] as const))(
  "composing into %s",
  (_name, target) => {
    const profile = profileFor(target);
    const { targetWidthPx: width, targetHeightPx: height } = profile;
    const files = { master: "", video: "" };

    beforeAll(async () => {
      files.master = join(dir, `${width}x${height}-clean-master.mp4`);
      files.video = join(dir, `${width}x${height}.mp4`);
      const composer = createFfmpegDeliverableComposer({ runner }, { disclosureLayerDirectory: LAYER_DIRECTORY });
      const master = await composer.composeCleanMaster({
        clips: [
          { localPath: landscape, durationSeconds: LANDSCAPE_SCENE_SECONDS },
          { localPath: portrait, durationSeconds: PORTRAIT_SCENE_SECONDS },
        ],
        profile,
        outputPath: files.master,
      });
      expect(master).toEqual({ kind: "SUCCESS" });
      const video = await composer.applyDisclosure({
        cleanMasterPath: files.master,
        profile,
        disclosureMode: "THROUGHOUT",
        outputPath: files.video,
      });
      expect(video).toEqual({ kind: "SUCCESS" });
    });

    describe.each([
      ["the Clean Master", "master"],
      ["the customer's video", "video"],
    ] as const)("%s", (_label, which) => {
      it("is measured by the inspector at the frame size and the scenes' total length, with no audio", async () => {
        const outcome = await new FfprobeMediaProbe({}, { runner }).probe(files[which]);
        expect(outcome).toEqual({
          kind: "FACTS",
          facts: {
            container: ISO_BMFF_CONTAINER,
            durationMs: (LANDSCAPE_SCENE_SECONDS + PORTRAIT_SCENE_SECONDS) * 1000,
            videoWidth: width,
            videoHeight: height,
            videoStreamCount: 1,
            audioStreamCount: 0,
          },
        });
      });

      it("is H.264 in yuv420p at a constant 30 fps with square pixels, one frame per thirtieth of a second", async () => {
        const { video, audioCount } = await probeStreams(files[which]);
        expect(audioCount).toBe(0);
        expect(video).toHaveLength(1);
        expect(video[0]).toMatchObject({
          codec_name: profile.videoCodec,
          pix_fmt: profile.pixelFormat,
          avg_frame_rate: `${profile.frameRateNumerator}/${profile.frameRateDenominator}`,
          sample_aspect_ratio: "1:1",
          nb_frames: String(FRAME_COUNT),
        });
      });

      it("shows the 16:9 clip whole, letterboxed where the frame is taller, never cropped", async () => {
        const frame = await decodeFrame(dir, files[which], 10);
        expect(frame).toHaveLength(width * height * 3);
        expect(isBlue(pixel(frame, width, width / 2, height / 2))).toBe(true);
        // Scaled to the frame's width, the clip is 9/16 of it tall: anything
        // taller has black bands above and below, and the sides are never cut.
        expect(isBlue(pixel(frame, width, 2, height / 2))).toBe(true);
        expect(isBlue(pixel(frame, width, width - 3, height / 2))).toBe(true);
        const letterboxed = (width * 9) / 16 < height - 4;
        expect(isBlack(pixel(frame, width, width / 2, 1))).toBe(letterboxed);
      });

      it("shows the 9:16 clip whole, pillarboxed where the frame is wider, holding its last frame to the scene's end", async () => {
        // The portrait clip is one second long but its scene is two: frame 100
        // is 1.8 seconds into the scene, well after the source's last frame. A
        // held last frame is yellow; a held first frame, or the clip looped, red.
        const frame = await decodeFrame(dir, files[which], FRAME_COUNT - 5);
        expect(isYellow(pixel(frame, width, width / 2, height / 2))).toBe(true);
        expect(isYellow(pixel(frame, width, width / 2, 2))).toBe(true);
        expect(isYellow(pixel(frame, width, width / 2, height - 3))).toBe(true);
        const pillarboxed = (height * 9) / 16 < width - 4;
        expect(isBlack(pixel(frame, width, 1, height / 2))).toBe(pillarboxed);
      });

      it("carries none of the first clip's tags or chapters, and no stream but the video", async () => {
        // The clip itself carries them all, so their absence is the composer's.
        const clip = await probeEverything(landscape);
        expect(clip.text.split(PROVIDER_TAG).length - 1).toBe(4);
        expect(clip.chapterCount).toBe(1);
        const probed = await probeEverything(files[which]);
        expect(probed.text).not.toContain(PROVIDER_TAG);
        expect(probed.chapterCount).toBe(0);
        // An mp4 holds a chapter as a track of its own, so one surviving would be a second stream.
        expect(probed.streamCount).toBe(1);
      });

      it("cuts from the first clip, trimmed from its start, to the second exactly at the first scene's length", async () => {
        // Frame 44 is 1.47 seconds into the first clip: still blue, where the
        // clip's last 1.5 seconds would have turned green by then.
        const boundary = LANDSCAPE_SCENE_SECONDS * 30;
        const [last, first] = await Promise.all([
          decodeFrame(dir, files[which], boundary - 1),
          decodeFrame(dir, files[which], boundary),
        ]);
        expect(isBlue(pixel(last, width, width / 2, height / 2))).toBe(true);
        expect(isRed(pixel(first, width, width / 2, height / 2))).toBe(true);
      });
    });

    it.each([
      ["the first frame", 0],
      ["the cut", LANDSCAPE_SCENE_SECONDS * 30],
      ["the held last frame", FRAME_COUNT - 1],
    ] as const)(
      "at %s, the customer's video is the master with the disclosure laid over it, and the master carries none",
      async (_moment, frameIndex) => {
        const asset = disclosureLayerFor(width, height)!;
        const image = await decodeRgba(dir, join(LAYER_DIRECTORY, asset.fileName));
        const [master, video] = await Promise.all([
          decodeFrame(dir, files.master, frameIndex),
          decodeFrame(dir, files.video, frameIndex),
        ]);
        expect(image).toHaveLength(width * height * 4);

        const ink = { left: width, top: height, right: -1, bottom: -1 };
        for (let at = 0; at < width * height; at += 1) {
          if ((image[at * 4 + 3] ?? 0) === 0) continue;
          ink.left = Math.min(ink.left, at % width);
          ink.top = Math.min(ink.top, Math.floor(at / width));
          ink.right = Math.max(ink.right, at % width);
          ink.bottom = Math.max(ink.bottom, Math.floor(at / width));
        }
        // H.264 codes 16-pixel macroblocks, so the encode may touch the block
        // holding the text's edge; beyond it the video must be the master.
        const nearInk = (x: number, y: number): boolean =>
          x >= ink.left - 16 && x <= ink.right + 16 && y >= ink.top - 16 && y <= ink.bottom + 16;
        // No band edge runs across the rows just above the text: letterbox
        // edges are far above it and pillarbox edges are vertical. So without
        // a disclosure, each of the master's columns there is one colour.
        const above = ink.top - 24;

        const inkErrors: number[] = [];
        const contrast: number[] = [];
        let largestElsewhere = 0;
        let largestInMaster = 0;
        for (let at = 0; at < width * height; at += 1) {
          const x = at % width;
          const y = Math.floor(at / width);
          const under = luma(pixel(master, width, x, y));
          const got = luma(pixel(video, width, x, y));
          const alpha = (image[at * 4 + 3] ?? 0) / 255;
          if (alpha > 0) {
            const imageLuma = luma([image[at * 4] ?? 0, image[at * 4 + 1] ?? 0, image[at * 4 + 2] ?? 0]);
            inkErrors.push(Math.abs(got - (imageLuma * alpha + under * (1 - alpha))));
            contrast.push(Math.abs(got - under));
            largestInMaster = Math.max(largestInMaster, Math.abs(under - luma(pixel(master, width, x, above))));
          } else if (!nearInk(x, y)) {
            largestElsewhere = Math.max(largestElsewhere, Math.abs(got - under));
          }
        }
        expect(inkErrors.length).toBeGreaterThan(0);
        inkErrors.sort((a, b) => a - b);
        contrast.sort((a, b) => a - b);
        const percentile = (values: readonly number[], share: number): number =>
          values[Math.floor(share * (values.length - 1))] ?? Number.NaN;

        // The disclosure is where its image puts it, at its lightness over the
        // master. Measured on FFmpeg 6.1.1: a mean error of 1.2 to 4.1 levels
        // of 255 and a 99th percentile of 4.4 to 20.3. Looser than over a flat
        // background (ADR-0072), because these frames hold a cut and letterbox
        // bands: over the pure black of a band, one edge pixel of the first
        // frame is up to 46 out, so the bound is on the 99th percentile, not
        // the largest.
        expect(inkErrors.reduce((sum, error) => sum + error, 0) / inkErrors.length).toBeLessThanOrEqual(6);
        expect(percentile(inkErrors, 0.99)).toBeLessThanOrEqual(30);
        // It stands out: the strongest 1% at least 72 levels from the master
        // (measured 120 to 181).
        expect(percentile(contrast, 0.99)).toBeGreaterThanOrEqual(72);
        // Everywhere else the customer's video is the master, re-encoded: in
        // lightness within 3.5 levels (measured, at the edge of the yellow
        // bands in the square frames), where text placed there would be 72 or
        // more out. Compared in lightness because the colour planes are
        // halved, so a band's edge moves by up to 20 in one channel between
        // the two encodes.
        expect(largestElsewhere).toBeLessThanOrEqual(6);
        // And the master itself carries no disclosure: under the text it is
        // what the rows above show (measured exactly).
        expect(largestInMaster).toBeLessThanOrEqual(4);
      },
    );
  },
);
