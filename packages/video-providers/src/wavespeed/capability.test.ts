import { describe, expect, it } from "vitest";
import { WAVESPEED_OPEN_VIDEO_MODEL_ID, serverEnvSchema } from "@app/shared";
import { assertSettingsSupported, type GenerationRequestSettings } from "@app/domain";
import {
  OPEN_VIDEO_CAPABILITY,
  OPEN_VIDEO_OPTIONAL_REQUEST_FIELDS,
  OPEN_VIDEO_REQUEST_FIELDS,
  createOpenVideoCapabilityProvider,
} from "./capability";

/**
 * The verified OpenVideo descriptor.
 *
 * These assertions are transcriptions of the official documentation, not
 * restatements of the implementation — if someone edits the descriptor to make
 * a failing admission pass, these fail. That is the entire point: the previous
 * adapter sent three fields this endpoint does not document, and nothing caught
 * it because no test asserted what the model actually accepts.
 */

const settings = (o: Partial<GenerationRequestSettings> = {}): GenerationRequestSettings => ({
  durationSeconds: 5,
  resolution: "1080p",
  aspectRatio: "16:9",
  cameraMotion: null,
  negativePrompt: null,
  ...o,
});

describe("OpenVideo capability descriptor", () => {
  it("names the verified provider and model", () => {
    expect(OPEN_VIDEO_CAPABILITY.providerName).toBe("wavespeed");
    expect(OPEN_VIDEO_CAPABILITY.providerModelId).toBe("wavespeed-ai/open-video/image-to-video");
  });

  it("declares the documented duration range of 3-20 integer seconds", () => {
    expect(OPEN_VIDEO_CAPABILITY.durationSeconds).toEqual({
      kind: "RANGE",
      minSeconds: 3,
      maxSeconds: 20,
    });
  });

  it("declares exactly the documented resolutions", () => {
    expect([...OPEN_VIDEO_CAPABILITY.resolutions]).toEqual(["480p", "720p", "1080p"]);
  });

  it("declares aspect ratio as composition-owned, not provider-honoured", () => {
    // The documented parameter table has no `aspect_ratio`. Claiming
    // PROVIDER_HONORED would be a lie; UNSUPPORTED would refuse every project,
    // since a VideoProject always carries a ratio.
    expect(OPEN_VIDEO_CAPABILITY.aspectRatios).toEqual({ kind: "COMPOSITION_OWNED" });
  });

  it("declares a user negative prompt unsupported", () => {
    expect(OPEN_VIDEO_CAPABILITY.negativePrompt).toEqual({ kind: "UNSUPPORTED" });
  });

  it("declares camera motion as prompt-rendered", () => {
    expect(OPEN_VIDEO_CAPABILITY.cameraMotion).toEqual({ kind: "PROMPT_RENDERED" });
  });

  it("is frozen, so a caller cannot mutate the shared descriptor", () => {
    expect(Object.isFrozen(OPEN_VIDEO_CAPABILITY)).toBe(true);
  });

  it("is what the production provider hands out", () => {
    expect(createOpenVideoCapabilityProvider().current()).toBe(OPEN_VIDEO_CAPABILITY);
  });
});

describe("admission against the real descriptor", () => {
  it("admits a typical request", () => {
    expect(() => assertSettingsSupported(settings(), OPEN_VIDEO_CAPABILITY)).not.toThrow();
  });

  it.each([3, 20])("admits the documented boundary duration %s", (durationSeconds) => {
    expect(() =>
      assertSettingsSupported(settings({ durationSeconds }), OPEN_VIDEO_CAPABILITY),
    ).not.toThrow();
  });

  it.each([2, 21, 5.5])("refuses duration %s", (durationSeconds) => {
    expect(() =>
      assertSettingsSupported(settings({ durationSeconds }), OPEN_VIDEO_CAPABILITY),
    ).toThrow();
  });

  it.each(["480p", "720p", "1080p"])("admits resolution %s", (resolution) => {
    expect(() =>
      assertSettingsSupported(settings({ resolution }), OPEN_VIDEO_CAPABILITY),
    ).not.toThrow();
  });

  it("refuses an undocumented resolution", () => {
    expect(() => assertSettingsSupported(settings({ resolution: "4k" }), OPEN_VIDEO_CAPABILITY)).toThrow();
  });

  it("admits any aspect ratio, because composition owns the guarantee", () => {
    // This is the case that makes the product work at all: every VideoProject
    // carries a ratio, so a provider-side refusal here would block 100% of
    // admissions.
    for (const aspectRatio of ["16:9", "9:16", "1:1", "4:3"]) {
      expect(() =>
        assertSettingsSupported(settings({ aspectRatio }), OPEN_VIDEO_CAPABILITY),
      ).not.toThrow();
    }
  });

  it("refuses a project carrying a real user negative prompt", () => {
    expect(() =>
      assertSettingsSupported(settings({ negativePrompt: "no people" }), OPEN_VIDEO_CAPABILITY),
    ).toThrow();
  });

  it("admits a blank negative prompt, which is absent rather than requested", () => {
    for (const negativePrompt of [null, "", "   "]) {
      expect(() =>
        assertSettingsSupported(settings({ negativePrompt }), OPEN_VIDEO_CAPABILITY),
      ).not.toThrow();
    }
  });

  it("admits a camera motion, which the prompt input carries", () => {
    expect(() =>
      assertSettingsSupported(settings({ cameraMotion: "slow push in" }), OPEN_VIDEO_CAPABILITY),
    ).not.toThrow();
  });
});

describe("model identity is single-sourced", () => {
  it("uses the same id as the configured environment default", () => {
    // One constant feeds both. Before Phase 4B-2a the id was a bare literal in
    // the env schema *and* an unread `WaveSpeedConfig.modelId`, so the
    // descriptor and the configured default could drift apart unnoticed.
    // The schema is parsed directly rather than through `loadServerEnv`, which
    // memoizes process-wide and would leak state between test files. Only the
    // two secrets have no default, so that is all this fixture supplies; the
    // model id comes from the schema's own default.
    const env = serverEnvSchema.parse({
      SESSION_SECRET: "x".repeat(16),
      HEALTHCHECK_API_TOKEN: "y".repeat(16),
      STORAGE_SIGNING_SECRET: "z".repeat(16),
    });
    expect(env.WAVESPEED_VIDEO_MODEL_ID).toBe(WAVESPEED_OPEN_VIDEO_MODEL_ID);
    expect(OPEN_VIDEO_CAPABILITY.providerModelId).toBe(WAVESPEED_OPEN_VIDEO_MODEL_ID);
    expect(OPEN_VIDEO_CAPABILITY.providerModelId).toBe(env.WAVESPEED_VIDEO_MODEL_ID);
  });
});

describe("documented request fields", () => {
  it("lists exactly the always-sent documented parameters", () => {
    expect([...OPEN_VIDEO_REQUEST_FIELDS]).toEqual(["image", "prompt", "duration", "resolution"]);
  });

  it("lists seed as the only documented optional parameter", () => {
    expect([...OPEN_VIDEO_OPTIONAL_REQUEST_FIELDS]).toEqual(["seed"]);
  });

  it.each(["aspect_ratio", "negative_prompt", "camera_motion", "preset"])(
    "does not treat %s as a documented field",
    (field) => {
      const all: readonly string[] = [
        ...OPEN_VIDEO_REQUEST_FIELDS,
        ...OPEN_VIDEO_OPTIONAL_REQUEST_FIELDS,
      ];
      expect(all).not.toContain(field);
    },
  );
});
