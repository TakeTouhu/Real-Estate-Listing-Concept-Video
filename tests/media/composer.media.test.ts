/**
 * The dormant deliverable composer and media inspector, on real FFmpeg.
 *
 * Every other suite drives them through a fake process runner, which proves the
 * argument vector and the outcome mapping but not that FFmpeg does what the
 * vector says. Here the composer encodes two synthetic clips into each of the
 * six composition profile v1 rasters, and the inspector measures the result:
 * the exact frame size, the sum of the scene lengths, one video stream and no
 * audio. Decoded frames then show the clips letterboxed rather than cropped,
 * the longer clip trimmed from its start, and the shorter one holding its last
 * frame rather than ending early, looping or holding its first.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COMPOSABLE_TARGETS,
  ISO_BMFF_CONTAINER,
  resolveCompositionProfile,
  type CompositionProfile,
} from "@app/domain";
import { createFfmpegDeliverableComposer, FfprobeMediaProbe } from "@app/storage";
import { decodeFrame, ffmpeg, probeStreams, runner } from "./media-tools";

// A 16:9 clip at 25 fps with a tone, two seconds long, whose timestamps start
// at 3 seconds (a clip need not start at zero): blue, turning green at 1.6
// seconds. And a 9:16 clip at 24 fps, one second long: red, turning yellow for
// its last two frames. The deliverable gives the first 1.5 seconds, so it is
// trimmed and must never show green, and the second 2 seconds, so it holds its
// last frame and must show yellow, not red, after its source ends.
const LANDSCAPE_SCENE_SECONDS = 1.5;
const PORTRAIT_SCENE_SECONDS = 2;
const FRAME_COUNT = (LANDSCAPE_SCENE_SECONDS + PORTRAIT_SCENE_SECONDS) * 30;

let dir: string;
let landscape: string;
let portrait: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-composer-"));
  landscape = join(dir, "landscape.mp4");
  portrait = join(dir, "portrait.mp4");
  await ffmpeg([
    "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=25:d=2,drawbox=c=green:t=fill:enable='gte(t,1.6)'",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
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

describe.each(COMPOSABLE_TARGETS.map((target) => [`${target.targetAspectRatio} ${target.targetOutputResolution}`, target] as const))(
  "composing into %s",
  (_name, target) => {
    const profile = profileFor(target);
    const { targetWidthPx: width, targetHeightPx: height } = profile;
    let output: string;

    beforeAll(async () => {
      output = join(dir, `${width}x${height}.mp4`);
      const composer = createFfmpegDeliverableComposer({ runner });
      const outcome = await composer.compose({
        clips: [
          { localPath: landscape, durationSeconds: LANDSCAPE_SCENE_SECONDS },
          { localPath: portrait, durationSeconds: PORTRAIT_SCENE_SECONDS },
        ],
        profile,
        outputPath: output,
      });
      expect(outcome).toEqual({ kind: "SUCCESS" });
    });

    it("is measured by the inspector at the frame size and the scenes' total length, with no audio", async () => {
      const outcome = await new FfprobeMediaProbe({}, { runner }).probe(output);
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
      const { video, audioCount } = await probeStreams(output);
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
      const frame = await decodeFrame(dir, output, 10);
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
      const frame = await decodeFrame(dir, output, FRAME_COUNT - 5);
      expect(isYellow(pixel(frame, width, width / 2, height / 2))).toBe(true);
      expect(isYellow(pixel(frame, width, width / 2, 2))).toBe(true);
      expect(isYellow(pixel(frame, width, width / 2, height - 3))).toBe(true);
      const pillarboxed = (height * 9) / 16 < width - 4;
      expect(isBlack(pixel(frame, width, 1, height / 2))).toBe(pillarboxed);
    });

    it("cuts from the first clip, trimmed from its start, to the second exactly at the first scene's length", async () => {
      // Frame 44 is 1.47 seconds into the first clip: still blue, where the
      // clip's last 1.5 seconds would have turned green by then.
      const boundary = LANDSCAPE_SCENE_SECONDS * 30;
      const [last, first] = await Promise.all([
        decodeFrame(dir, output, boundary - 1),
        decodeFrame(dir, output, boundary),
      ]);
      expect(isBlue(pixel(last, width, width / 2, height / 2))).toBe(true);
      expect(isRed(pixel(first, width, width / 2, height / 2))).toBe(true);
    });
  },
);
