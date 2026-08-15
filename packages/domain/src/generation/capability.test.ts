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
 * into configuration. The configured OpenVideo model's verified values live in
 * `@app/video-providers` (`OPEN_VIDEO_CAPABILITY`) and are asserted there; this
 * file proves the *rule*, so its fixtures stay deliberately unlike any real
 * model.
 */
const FIXTURE: VideoModelCapability = {
  providerName: "fixture-provider",
  providerModelId: "fixture/model-v1",
  durationSeconds: { kind: "RANGE", minSeconds: 4, maxSeconds: 12 },
  resolutions: ["720p", "1080p"],
  aspectRatios: { kind: "PROVIDER_HONORED", ratios: ["16:9", "9:16"] },
  negativePrompt: { kind: "PROVIDER_FIELD" },
  cameraMotion: { kind: "PROVIDER_FIELD" },
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
    const cannot = capability({ negativePrompt: { kind: "UNSUPPORTED" } });
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
    const cannot = capability({ negativePrompt: { kind: "UNSUPPORTED" } });
    expect(() => assertSettingsSupported(settings({ negativePrompt }), cannot)).not.toThrow();
  });

  it("still requires support once the negative prompt has real content", () => {
    const cannot = capability({ negativePrompt: { kind: "UNSUPPORTED" } });
    expect(refusalOf(settings({ negativePrompt: "  no people  " }), cannot)!.code).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("does not rewrite the negative prompt while interpreting it", () => {
    // Capability *interpretation*, not normalization — the stored project value
    // must survive untouched.
    const s = settings({ negativePrompt: "  no people  " });
    assertSettingsSupported(s, capability({ negativePrompt: { kind: "PROVIDER_FIELD" } }));
    expect(s.negativePrompt).toBe("  no people  ");
  });

  it("does not apply the blank rule to camera motion", () => {
    // Deliberate asymmetry. `createProject` stores cameraMotion as given
    // without trimming, nothing normalizes it downstream, and it reaches the
    // provider as stored — so a blank one IS part of the request, including in
    // the request hash. Treating it as absent here would make this rule
    // disagree with what is actually being asked for.
    const cannot = capability({ cameraMotion: { kind: "UNSUPPORTED" } });
    expect(refusalOf(settings({ cameraMotion: "   " }), cannot)!.code).toBe("VALIDATION_FAILED");
    expect(() =>
      assertSettingsSupported(settings({ cameraMotion: null }), cannot),
    ).not.toThrow();
  });

  it("refuses a camera motion the model does not honour", () => {
    const cannot = capability({ cameraMotion: { kind: "UNSUPPORTED" } });
    expect(refusalOf(settings({ cameraMotion: "slow push in" }), cannot)!.code).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("ignores an unsupported feature the request never asked for", () => {
    // Refusing here would block work for no benefit: the customer did not ask
    // for the thing the model lacks.
    const cannot = capability({ negativePrompt: { kind: "UNSUPPORTED" }, cameraMotion: { kind: "UNSUPPORTED" } });
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

/**
 * Phase 4B-2a: delivery ownership.
 *
 * The two type changes exist to stop a boolean forcing a false choice between
 * claiming support a provider does not offer and refusing work the system can
 * still deliver. These tests pin each arm of that distinction, including the
 * one that would otherwise be easy to get wrong — that `COMPOSITION_OWNED`
 * accepts *without* consulting a provider ratio list, because the provider is
 * never asked.
 */
describe("aspect-ratio ownership", () => {
  it("validates the value when the provider honours the ratio", () => {
    const honored = capability({
      aspectRatios: { kind: "PROVIDER_HONORED", ratios: ["16:9", "9:16"] },
    });
    expect(() => assertSettingsSupported(settings({ aspectRatio: "16:9" }), honored)).not.toThrow();
    expect(refusalOf(settings({ aspectRatio: "4:3" }), honored)!.code).toBe("VALIDATION_FAILED");
  });

  it("accepts any requested ratio when composition owns the guarantee", () => {
    // No provider ratio list is consulted — there is none, and the provider is
    // not being asked. A ratio the model has never heard of is still a valid
    // request, because Phase 5 normalizes the delivered video to it.
    const composed = capability({ aspectRatios: { kind: "COMPOSITION_OWNED" } });
    for (const aspectRatio of ["16:9", "9:16", "1:1", "4:3", "2.39:1"]) {
      expect(() =>
        assertSettingsSupported(settings({ aspectRatio }), composed),
      ).not.toThrow();
    }
  });

  it("still refuses when nothing in the system can deliver a ratio", () => {
    const impossible = capability({ aspectRatios: { kind: "UNSUPPORTED" } });
    expect(refusalOf(settings({ aspectRatio: "16:9" }), impossible)!.code).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("does not let COMPOSITION_OWNED mask an unrelated failure", () => {
    // Moving the aspect-ratio guarantee must not weaken the other rules.
    const composed = capability({
      aspectRatios: { kind: "COMPOSITION_OWNED" },
      resolutions: ["1080p"],
    });
    expect(refusalOf(settings({ resolution: "480p" }), composed)!.code).toBe("VALIDATION_FAILED");
  });
});

describe("optional-input delivery mechanism", () => {
  it.each([
    ["PROVIDER_FIELD", { kind: "PROVIDER_FIELD" } as const],
    ["PROMPT_RENDERED", { kind: "PROMPT_RENDERED" } as const],
  ])("accepts a camera motion delivered by %s", (_label, cameraMotion) => {
    // PROMPT_RENDERED is a real delivery, not a euphemism for unsupported: the
    // intent reaches the model through its documented prompt input.
    expect(() =>
      assertSettingsSupported(settings({ cameraMotion: "slow push in" }), capability({ cameraMotion })),
    ).not.toThrow();
  });

  it("refuses a camera motion that cannot be delivered at all", () => {
    expect(
      refusalOf(
        settings({ cameraMotion: "slow push in" }),
        capability({ cameraMotion: { kind: "UNSUPPORTED" } }),
      )!.code,
    ).toBe("VALIDATION_FAILED");
  });

  it("accepts a null camera motion under every delivery mechanism", () => {
    for (const kind of ["PROVIDER_FIELD", "PROMPT_RENDERED", "UNSUPPORTED"] as const) {
      expect(() =>
        assertSettingsSupported(settings({ cameraMotion: null }), capability({ cameraMotion: { kind } })),
      ).not.toThrow();
    }
  });

  it.each([
    ["PROVIDER_FIELD", { kind: "PROVIDER_FIELD" } as const],
    ["PROMPT_RENDERED", { kind: "PROMPT_RENDERED" } as const],
  ])("accepts a negative prompt delivered by %s", (_label, negativePrompt) => {
    expect(() =>
      assertSettingsSupported(settings({ negativePrompt: "no people" }), capability({ negativePrompt })),
    ).not.toThrow();
  });
});
