import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import {
  assertSettingsSupported,
  type GenerationRequestSettings,
  type VideoModelCapability,
} from "./capability";

/**
 * FIXTURE VALUES ONLY — invented for these tests.
 *
 * They are **not** any real provider's capabilities and must never be copied
 * into configuration. The configured model's real limits are unverified, and
 * populating them is Phase 4B-2's job after the provider contract is checked
 * against an authoritative source.
 */
const FIXTURE: VideoModelCapability = {
  providerName: "fixture-provider",
  providerModelId: "fixture/model-v1",
  durationSeconds: { kind: "RANGE", minSeconds: 4, maxSeconds: 12 },
  resolutions: ["720p", "1080p"],
  aspectRatios: { kind: "SUPPORTED", ratios: ["16:9", "9:16"] },
  negativePrompt: "SUPPORTED",
  cameraMotion: "SUPPORTED",
};

const SETTINGS: GenerationRequestSettings = {
  durationSeconds: 6,
  resolution: "1080p",
  aspectRatio: "16:9",
  cameraMotion: null,
  negativePrompt: null,
};

const settings = (o: Partial<GenerationRequestSettings> = {}): GenerationRequestSettings => ({
  ...SETTINGS,
  ...o,
});
const capability = (o: Partial<VideoModelCapability> = {}): VideoModelCapability => ({
  ...FIXTURE,
  ...o,
});

const refusalOf = (s: GenerationRequestSettings, c: VideoModelCapability): AppError | null => {
  try {
    assertSettingsSupported(s, c);
    return null;
  } catch (error: unknown) {
    return error as AppError;
  }
};

describe("duration", () => {
  it("accepts a duration inside a supported range", () => {
    expect(() => assertSettingsSupported(settings({ durationSeconds: 4 }), FIXTURE)).not.toThrow();
    expect(() => assertSettingsSupported(settings({ durationSeconds: 12 }), FIXTURE)).not.toThrow();
  });

  it.each([3, 13, 0, -1, 6.5])("refuses %s seconds against that range", (durationSeconds) => {
    const error = refusalOf(settings({ durationSeconds }), FIXTURE);
    expect(error).toBeInstanceOf(AppError);
    expect(error!.code).toBe("VALIDATION_FAILED");
  });

  it("accepts only the listed lengths when a model enumerates them", () => {
    // Some models offer fixed clip lengths rather than a range; collapsing the
    // two forms would force a lie about whichever model does not fit.
    const enumerated = capability({
      durationSeconds: { kind: "ENUMERATED", seconds: [5, 10] },
    });
    expect(() => assertSettingsSupported(settings({ durationSeconds: 5 }), enumerated)).not.toThrow();
    expect(() => assertSettingsSupported(settings({ durationSeconds: 10 }), enumerated)).not.toThrow();
    expect(refusalOf(settings({ durationSeconds: 7 }), enumerated)).toBeInstanceOf(AppError);
  });
});

describe("resolution", () => {
  it("accepts a supported resolution", () => {
    expect(() => assertSettingsSupported(settings({ resolution: "720p" }), FIXTURE)).not.toThrow();
  });

  it("refuses one the model does not list", () => {
    const error = refusalOf(settings({ resolution: "4k" }), FIXTURE);
    expect(error!.code).toBe("VALIDATION_FAILED");
    expect(error!.message).toContain("4k");
  });
});

describe("aspect ratio", () => {
  it("accepts a ratio the model can deliver", () => {
    expect(() => assertSettingsSupported(settings({ aspectRatio: "9:16" }), FIXTURE)).not.toThrow();
  });

  it("refuses a ratio outside the supported set", () => {
    expect(refusalOf(settings({ aspectRatio: "1:1" }), FIXTURE)!.code).toBe("VALIDATION_FAILED");
  });

  it("refuses outright when the model cannot honour a chosen ratio at all", () => {
    // The load-bearing case. A model with no way to request a ratio has NOT
    // satisfied one — proceeding would ship an unknown shape while the customer
    // believes they chose. Refusal, never silent omission.
    const cannot = capability({ aspectRatios: { kind: "UNSUPPORTED" } });
    const error = refusalOf(settings({ aspectRatio: "16:9" }), cannot);
    expect(error).toBeInstanceOf(AppError);
    expect(error!.code).toBe("VALIDATION_FAILED");
    expect(error!.message).toContain("aspect ratio");
  });
});

describe("optional customer-authored inputs", () => {
  it("refuses a negative prompt the model does not honour", () => {
    const cannot = capability({ negativePrompt: "UNSUPPORTED" });
    expect(refusalOf(settings({ negativePrompt: "no people" }), cannot)!.code).toBe(
      "VALIDATION_FAILED",
    );
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["spaces", "   "],
    ["a tab and newline", "\n\t"],
  ])("treats a %s negative prompt as absent, not as a requirement", (_label, negativePrompt) => {
    // Review caught this: blank text was being read as a customer requirement.
    // `compileScenePrompt` normalizes blank and whitespace-only user text to
    // absent, so such a project compiles to `userNegative: null` and the model
    // never sees it. Refusing here would block work over a field that was never
    // going to be sent.
    const cannot = capability({ negativePrompt: "UNSUPPORTED" });
    expect(() => assertSettingsSupported(settings({ negativePrompt }), cannot)).not.toThrow();
  });

  it("still requires support once the negative prompt has real content", () => {
    const cannot = capability({ negativePrompt: "UNSUPPORTED" });
    expect(refusalOf(settings({ negativePrompt: "  no people  " }), cannot)!.code).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("does not rewrite the negative prompt while interpreting it", () => {
    // Capability *interpretation*, not normalization — the stored project value
    // must survive untouched.
    const s = settings({ negativePrompt: "  no people  " });
    assertSettingsSupported(s, capability({ negativePrompt: "SUPPORTED" }));
    expect(s.negativePrompt).toBe("  no people  ");
  });

  it("does not apply the blank rule to camera motion", () => {
    // Deliberate asymmetry. `createProject` stores cameraMotion as given
    // without trimming, nothing normalizes it downstream, and it reaches the
    // provider as stored — so a blank one IS part of the request, including in
    // the request hash. Treating it as absent here would make this rule
    // disagree with what is actually being asked for.
    const cannot = capability({ cameraMotion: "UNSUPPORTED" });
    expect(refusalOf(settings({ cameraMotion: "   " }), cannot)!.code).toBe("VALIDATION_FAILED");
    expect(() =>
      assertSettingsSupported(settings({ cameraMotion: null }), cannot),
    ).not.toThrow();
  });

  it("refuses a camera motion the model does not honour", () => {
    const cannot = capability({ cameraMotion: "UNSUPPORTED" });
    expect(refusalOf(settings({ cameraMotion: "slow push in" }), cannot)!.code).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("ignores an unsupported feature the request never asked for", () => {
    // Refusing here would block work for no benefit: the customer did not ask
    // for the thing the model lacks.
    const cannot = capability({ negativePrompt: "UNSUPPORTED", cameraMotion: "UNSUPPORTED" });
    expect(() =>
      assertSettingsSupported(settings({ negativePrompt: null, cameraMotion: null }), cannot),
    ).not.toThrow();
  });
});

describe("as a rule", () => {
  it("carries provider and model identity unchanged", () => {
    // Validation never rewrites which model was validated — 4B-1b freezes this
    // pair onto the attempt and into the request hash.
    const c = capability();
    assertSettingsSupported(settings(), c);
    expect(c.providerName).toBe("fixture-provider");
    expect(c.providerModelId).toBe("fixture/model-v1");
  });

  it("is deterministic", () => {
    expect(refusalOf(settings({ resolution: "4k" }), FIXTURE)!.message).toBe(
      refusalOf(settings({ resolution: "4k" }), FIXTURE)!.message,
    );
  });

  it("mutates neither argument", () => {
    const s = settings({ resolution: "4k" });
    const c = capability();
    const beforeSettings = JSON.stringify(s);
    const beforeCapability = JSON.stringify(c);
    refusalOf(s, c);
    expect(JSON.stringify(s)).toBe(beforeSettings);
    expect(JSON.stringify(c)).toBe(beforeCapability);
  });

  it("checks duration before resolution, so the first refusal is stable", () => {
    const error = refusalOf(settings({ durationSeconds: 99, resolution: "4k" }), FIXTURE);
    expect(error!.message).toContain("seconds");
  });
});
