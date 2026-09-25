/**
 * Composition profile v1 — the exhaustive table, and everything it refuses.
 *
 * The refusals carry most of the weight. A profile that quietly approximated an
 * unknown target would deliver a letterboxed or cropped video the customer never
 * agreed to, produced by rounding, and nothing downstream would ever say so.
 */

import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import {
  COMPOSABLE_ASPECT_RATIOS,
  COMPOSABLE_TARGETS,
  COMPOSITION_AUDIO_MODE,
  COMPOSITION_CRF,
  COMPOSITION_ENCODER_PRESET,
  COMPOSITION_FIT_MODE,
  COMPOSITION_FRAME_RATE_DENOMINATOR,
  COMPOSITION_FRAME_RATE_NUMERATOR,
  COMPOSITION_PIXEL_FORMAT,
  COMPOSITION_PROFILE_KEY,
  COMPOSITION_TRANSITION_MODE,
  COMPOSITION_VIDEO_CODEC,
  assertRunnableProfile,
  isComposableAspectRatio,
  resolveCompositionProfile,
} from "./profile";

function profileFor(targetAspectRatio: string, targetOutputResolution: string) {
  return resolveCompositionProfile({ targetAspectRatio, targetOutputResolution });
}

// ---------------------------------------------------------------------------

describe("the raster table is exhaustive and even on both axes", () => {
  const EXPECTED: [string, string, number, number][] = [
    ["16:9", "720p", 1280, 720],
    ["16:9", "1080p", 1920, 1080],
    ["9:16", "720p", 720, 1280],
    ["9:16", "1080p", 1080, 1920],
    ["1:1", "720p", 720, 720],
    ["1:1", "1080p", 1080, 1080],
  ];

  for (const [aspect, resolution, width, height] of EXPECTED) {
    it(`resolves ${aspect} + ${resolution} to ${width}x${height}`, () => {
      const outcome = profileFor(aspect, resolution);
      expect(outcome.kind).toBe("RESOLVED");
      if (outcome.kind !== "RESOLVED") return;
      expect(outcome.profile.targetWidthPx).toBe(width);
      expect(outcome.profile.targetHeightPx).toBe(height);
    });
  }

  it("has exactly six composable targets, and they are the six above", () => {
    expect(COMPOSABLE_TARGETS).toHaveLength(6);
    expect(
      [...COMPOSABLE_TARGETS]
        .map((one) => `${one.targetAspectRatio}+${one.targetOutputResolution}`)
        .sort(),
    ).toEqual(EXPECTED.map(([a, r]) => `${a}+${r}`).sort());
  });

  it("makes every dimension even, because yuv420p cannot encode an odd one", () => {
    for (const [aspect, resolution] of EXPECTED) {
      const outcome = profileFor(aspect, resolution);
      if (outcome.kind !== "RESOLVED") throw new Error("expected a profile");
      expect(outcome.profile.targetWidthPx % 2).toBe(0);
      expect(outcome.profile.targetHeightPx % 2).toBe(0);
    }
  });

  it("freezes one set of encoder settings across every target", () => {
    for (const [aspect, resolution] of EXPECTED) {
      const outcome = profileFor(aspect, resolution);
      if (outcome.kind !== "RESOLVED") throw new Error("expected a profile");
      const { profile } = outcome;
      expect(profile.profileKey).toBe(COMPOSITION_PROFILE_KEY);
      expect(profile.videoCodec).toBe(COMPOSITION_VIDEO_CODEC);
      expect(profile.pixelFormat).toBe(COMPOSITION_PIXEL_FORMAT);
      expect(profile.fitMode).toBe(COMPOSITION_FIT_MODE);
      expect(profile.transitionMode).toBe(COMPOSITION_TRANSITION_MODE);
      expect(profile.audioMode).toBe(COMPOSITION_AUDIO_MODE);
      expect(profile.encoderPreset).toBe(COMPOSITION_ENCODER_PRESET);
      expect(profile.crf).toBe(COMPOSITION_CRF);
      expect(profile.frameRateNumerator).toBe(COMPOSITION_FRAME_RATE_NUMERATOR);
      expect(profile.frameRateDenominator).toBe(COMPOSITION_FRAME_RATE_DENOMINATOR);
    }
  });

  it("names v1 explicitly, so a later version cannot inherit this row", () => {
    expect(COMPOSITION_PROFILE_KEY).toBe("vtavision-compose:v1");
  });
});

describe("anything outside the table refuses, and nothing is normalized", () => {
  const UNSUPPORTED_ASPECTS = [
    "21:9",
    "4:3",
    "",
    "   ",
    "16 : 9",
    "16:9 ",
    " 16:9",
    "16/9",
    "16X9",
    "HD",
    "sixteen by nine",
    "1:1:1",
  ];

  for (const aspect of UNSUPPORTED_ASPECTS) {
    it(`refuses the aspect ratio ${JSON.stringify(aspect)}`, () => {
      expect(profileFor(aspect, "1080p").kind).toBe("UNSUPPORTED_TARGET");
    });
  }

  for (const resolution of ["", "  ", "4k", "2160p", "1080P", "1080p ", "720", "HD", "medium"]) {
    it(`refuses the resolution ${JSON.stringify(resolution)}`, () => {
      expect(profileFor("16:9", resolution).kind).toBe("UNSUPPORTED_TARGET");
    });
  }

  it("refuses a resolution borrowed from Object.prototype", () => {
    for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(profileFor("16:9", key).kind).toBe("UNSUPPORTED_TARGET");
    }
  });

  it("never trims, case-folds or nearest-matches its way to an answer", () => {
    // Each of these differs from a supported value by whitespace or case alone,
    // and each is a decision about what the customer receives.
    for (const [aspect, resolution] of [
      ["16:9 ", "1080p"],
      ["16:9", " 1080p"],
      ["16:9", "1080P"],
      ["9:16 ", "720p"],
    ]) {
      expect(profileFor(aspect!, resolution!).kind).toBe("UNSUPPORTED_TARGET");
    }
  });
});

describe("the aspect-ratio guard is a closed list", () => {
  it("accepts exactly the three composable ratios", () => {
    expect([...COMPOSABLE_ASPECT_RATIOS]).toEqual(["16:9", "9:16", "1:1"]);
    for (const aspect of COMPOSABLE_ASPECT_RATIOS) {
      expect(isComposableAspectRatio(aspect)).toBe(true);
    }
  });

  it("rejects every non-string and every unlisted string", () => {
    for (const value of [null, undefined, 169, {}, [], true, "21:9", ""]) {
      expect(isComposableAspectRatio(value)).toBe(false);
    }
  });
});

describe("a persisted profile from another version is refused, never re-derived", () => {
  const v1 = (() => {
    const outcome = profileFor("16:9", "1080p");
    if (outcome.kind !== "RESOLVED") throw new Error("expected a profile");
    return outcome.profile;
  })();

  it("returns a v1 profile unchanged", () => {
    expect(assertRunnableProfile(v1)).toEqual(v1);
  });

  it("refuses a profile carrying any other key", () => {
    for (const key of ["vtavision-compose:v2", "vtavision-compose:v0", "", "other"]) {
      expect(() => assertRunnableProfile({ ...v1, profileKey: key })).toThrow(AppError);
    }
  });

  it("refuses with a configuration defect, not a media verdict", () => {
    try {
      assertRunnableProfile({ ...v1, profileKey: "vtavision-compose:v2" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("CONFIGURATION_ERROR");
    }
  });
});
