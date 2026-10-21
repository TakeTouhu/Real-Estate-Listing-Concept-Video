/**
 * The Clean Master inspector refuses, on real FFmpeg, every master the
 * disclosure must not be laid over (ADR-0076 Decision 3).
 *
 * The disclosure image is frame-sized and laid at the origin, so a master of
 * another size would come out with the image cut off or misplaced, or, smaller
 * than the image's ink, with no disclosure at all. Each master here is made the
 * way a wrong one could arrive, by an encode at another size or rate, and the
 * inspector's reading of it must not match the 1080p landscape profile. The
 * composer suite proves the opposite half: every master the composer makes
 * matches its own profile.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanMasterMatchesProfile, resolveCompositionProfile, type CompositionProfile } from "@app/domain";
import { FfprobeCleanMasterInspector } from "@app/storage";
import { ffmpeg, runner } from "./media-tools";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-clean-master-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function profileFor(targetAspectRatio: string, targetOutputResolution: string): CompositionProfile {
  const outcome = resolveCompositionProfile({ targetAspectRatio, targetOutputResolution });
  if (outcome.kind !== "RESOLVED") throw new Error("expected a profile");
  return outcome.profile;
}

const LANDSCAPE_1080 = profileFor("16:9", "1080p");

/** A one-second H.264 master in MP4, encoded as the composer encodes, at this size and rate. */
async function masterAt(name: string, size: string, rate: string): Promise<string> {
  const path = join(dir, `${name}.mp4`);
  await ffmpeg([
    "-f", "lavfi", "-i", `testsrc2=s=${size}:r=${rate}:d=1`,
    "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", path,
  ]);
  return path;
}

const inspect = (localPath: string) => new FfprobeCleanMasterInspector({}, { runner }).inspect({ localPath });

describe("a master the 1080p landscape profile must not take", () => {
  it.each([
    ["at 720p", "1280x720", "30", { widthPx: 1280, heightPx: 720, frameRateNumerator: 30, frameRateDenominator: 1 }],
    ["portrait", "1080x1920", "30", { widthPx: 1080, heightPx: 1920, frameRateNumerator: 30, frameRateDenominator: 1 }],
    ["two pixels narrower", "1918x1080", "30", { widthPx: 1918, heightPx: 1080, frameRateNumerator: 30, frameRateDenominator: 1 }],
    ["at 25 fps", "1920x1080", "25", { widthPx: 1920, heightPx: 1080, frameRateNumerator: 25, frameRateDenominator: 1 }],
    ["at 29.97 fps", "1920x1080", "30000/1001", { widthPx: 1920, heightPx: 1080, frameRateNumerator: 30000, frameRateDenominator: 1001 }],
  ])("is read as it is %s, and refused", async (name, size, rate, raster) => {
    const outcome = await inspect(await masterAt(name.replace(/\W+/g, "-"), size, rate));
    expect(outcome).toEqual({ kind: "RASTER", raster });
    if (outcome.kind === "RASTER") expect(cleanMasterMatchesProfile(outcome.raster, LANDSCAPE_1080)).toBe(false);
  });

  it("is matched only at the profile's own size and rate", async () => {
    const outcome = await inspect(await masterAt("matching", "1920x1080", "30"));
    expect(outcome).toEqual({
      kind: "RASTER",
      raster: { widthPx: 1920, heightPx: 1080, frameRateNumerator: 30, frameRateDenominator: 1 },
    });
    if (outcome.kind === "RASTER") expect(cleanMasterMatchesProfile(outcome.raster, LANDSCAPE_1080)).toBe(true);
  });

  it("is unusable when it is not an MP4 video at all", async () => {
    const image = join(dir, "still.png");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=1920x1080", "-frames:v", "1", image]);
    const matroska = join(dir, "master.mkv");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", matroska]);
    const text = join(dir, "not-a-video.mp4");
    await writeFile(text, "not a video");
    for (const path of [image, matroska, text]) {
      expect(await inspect(path)).toEqual({ kind: "UNUSABLE" });
    }
  });
});
