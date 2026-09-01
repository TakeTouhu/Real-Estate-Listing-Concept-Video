import { describe, expect, it } from "vitest";
import {
  TARGET_OUTPUT_RESOLUTIONS,
  isTargetOutputResolution,
  planGenerationResolution,
  type TargetOutputResolution,
  type VideoModelEntry,
} from "./model-catalog";

/**
 * A model shaped like H3 Max: one native generation resolution, whatever the
 * customer asked for.
 */
function fixedNativeModel(heightPx: number, providerValue: string): VideoModelEntry {
  return {
    key: "test-fixed",
    providerName: "test-provider",
    providerModelId: "test/fixed",
    displayName: "Fixed Native",
    tier: "RECOMMENDED",
    recommended: true,
    capability: {
      providerName: "test-provider",
      providerModelId: "test/fixed",
      durationSeconds: { kind: "RANGE", minSeconds: 5, maxSeconds: 15 },
      resolutions: [providerValue],
      aspectRatios: { kind: "COMPOSITION_OWNED" },
      negativePrompt: { kind: "UNSUPPORTED" },
      cameraMotion: { kind: "PROMPT_RENDERED" },
    },
    nativeGeneration: { kind: "FIXED", native: { providerValue, heightPx } },
    targetOutputResolutions: ["720p", "1080p"],
    pricing: null,
    availability: { kind: "SELECTABLE" },
  };
}

/** A model shaped like OpenVideo: native generation at each product target. */
function perTargetModel(): VideoModelEntry {
  return {
    ...fixedNativeModel(720, "720p"),
    key: "test-per-target",
    nativeGeneration: {
      kind: "PER_TARGET",
      byTarget: {
        "720p": { providerValue: "720p", heightPx: 720 },
        "1080p": { providerValue: "1080p", heightPx: 1080 },
      },
    },
  };
}

describe("the product target vocabulary is closed", () => {
  it("supports exactly 720p and 1080p", () => {
    expect(TARGET_OUTPUT_RESOLUTIONS).toEqual(["720p", "1080p"]);
  });

  it("refuses anything else, including native generation tokens", () => {
    // `768P` is a *native* value. Admitting it as a product target is exactly
    // the conflation this vocabulary exists to prevent.
    for (const value of ["768P", "480P", "2K", "720P", "1080P", "4k", "", null, 720, {}]) {
      expect(`${String(value)}:${isTargetOutputResolution(value)}`).toBe(
        `${String(value)}:false`,
      );
    }
    for (const value of TARGET_OUTPUT_RESOLUTIONS) {
      expect(isTargetOutputResolution(value)).toBe(true);
    }
  });

  it("uses prototype-safe membership", () => {
    for (const value of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(`${value}:${isTargetOutputResolution(value)}`).toBe(`${value}:false`);
    }
  });
});

describe("a fixed-native model keeps target and native apart", () => {
  const h3MaxLike = fixedNativeModel(768, "768P");

  /**
   * The 720p case. 768 lines is *more* than 720, so the deliverable carries
   * native detail and composition only has to come down.
   */
  it("serves a 720p target from 768P natively, with detail to spare", () => {
    const plan = planGenerationResolution(h3MaxLike, "720p");
    expect(plan.nativeGenerationResolution).toEqual({ providerValue: "768P", heightPx: 768 });
    expect(plan.normalization).toBe("DOWNSCALE");
    expect(plan.nativeMeetsTarget).toBe(true);
  });

  /**
   * The case the whole separation exists for. The customer can ask for a 1080p
   * deliverable and get one — but it is 768 lines enlarged, and
   * `nativeMeetsTarget: false` is the fact that must survive all the way to
   * anything that describes the output.
   */
  it("serves a 1080p target from the same 768P generation, and says it is not native", () => {
    const plan = planGenerationResolution(h3MaxLike, "1080p");
    expect(plan.nativeGenerationResolution.providerValue).toBe("768P");
    expect(plan.normalization).toBe("UPSCALE");
    expect(plan.nativeMeetsTarget).toBe(false);
  });

  it("never reports a native resolution equal to the target it cannot reach", () => {
    for (const target of TARGET_OUTPUT_RESOLUTIONS) {
      const plan = planGenerationResolution(h3MaxLike, target);
      expect(`${target}:${plan.nativeGenerationResolution.providerValue}`).toBe(`${target}:768P`);
    }
  });
});

describe("a per-target model needs no normalization", () => {
  it("generates natively at each product output", () => {
    const model = perTargetModel();
    for (const target of TARGET_OUTPUT_RESOLUTIONS) {
      const plan = planGenerationResolution(model, target);
      expect(`${target}:${plan.normalization}`).toBe(`${target}:NONE`);
      expect(plan.nativeMeetsTarget).toBe(true);
      expect(plan.nativeGenerationResolution.providerValue).toBe(target);
    }
  });

  /**
   * The point of the whole exercise: two models with completely different
   * native policies are planned by the same function, and orchestration does
   * not branch on which provider it is.
   */
  it("is planned by the same function as a fixed-native model", () => {
    const fixed = planGenerationResolution(fixedNativeModel(768, "768P"), "1080p");
    const perTarget = planGenerationResolution(perTargetModel(), "1080p");
    expect(fixed.targetOutputResolution).toBe(perTarget.targetOutputResolution);
    expect(fixed.nativeMeetsTarget).toBe(false);
    expect(perTarget.nativeMeetsTarget).toBe(true);
  });

  it("treats an exactly-equal native resolution as meeting the target", () => {
    const plan = planGenerationResolution(fixedNativeModel(1080, "1080p"), "1080p");
    expect(plan.normalization).toBe("NONE");
    expect(plan.nativeMeetsTarget).toBe(true);
  });
});

describe("planning refuses rather than guessing", () => {
  it("refuses a model that is not verified for selection", () => {
    const unverified: VideoModelEntry = {
      ...fixedNativeModel(0, "2K"),
      key: "test-unverified",
      availability: { kind: "UNVERIFIED", missing: ["native output resolution in lines"] },
    };
    expect(() => planGenerationResolution(unverified, "1080p")).toThrowError(
      /not verified for selection/,
    );
  });

  it("refuses a target the model does not list", () => {
    const only720: VideoModelEntry = {
      ...fixedNativeModel(768, "768P"),
      targetOutputResolutions: ["720p"],
    };
    expect(() => planGenerationResolution(only720, "1080p")).toThrowError(
      /does not support the 1080p output/,
    );
    expect(planGenerationResolution(only720, "720p").normalization).toBe("DOWNSCALE");
  });

  /** The refusal names the model key and leaks nothing else. */
  it("names no provider payload, endpoint or credential in its refusal", () => {
    const unverified: VideoModelEntry = {
      ...fixedNativeModel(0, "2K"),
      key: "test-unverified",
      providerModelId: "vendor/secret-endpoint",
      availability: { kind: "UNVERIFIED", missing: ["pricing contract"] },
    };
    try {
      planGenerationResolution(unverified, "720p");
      expect.unreachable("should have refused");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("test-unverified");
      expect(message).not.toContain("vendor/secret-endpoint");
    }
  });
});

describe("the model entry stays provider-neutral", () => {
  /**
   * Compile-time. The risk is not that someone writes `falQueueUrl` today — it
   * is that a later adapter needs one field, adds it here because it is
   * convenient, and the domain quietly learns about fal.
   */
  it("declares no provider-specific field", () => {
    type Assert<T extends true> = T;
    type IsNever<T> = [T] extends [never] ? true : false;
    type ProviderSpecific =
      | "falQueueUrl"
      | "falEndpoint"
      | "wavespeedBaseUrl"
      | "minimaxPreset"
      | "googleProject"
      | "apiKey"
      | "headers"
      | "requestBody";
    const none: Assert<IsNever<Extract<keyof VideoModelEntry, ProviderSpecific>>> = true;
    expect(none).toBe(true);
  });

  it("keeps native resolution and product target structurally distinct", () => {
    type Assert<T extends true> = T;
    type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    // A native value is a provider token plus a height; a target is a closed
    // union. Neither is assignable to the other.
    const targetIsClosed: Assert<IsExactly<TargetOutputResolution, "720p" | "1080p">> = true;
    const nativeIsNotATarget: Assert<
      IsExactly<
        [VideoModelEntry["nativeGeneration"]] extends [TargetOutputResolution] ? true : false,
        false
      >
    > = true;
    expect([targetIsClosed, nativeIsNotATarget]).toEqual([true, true]);
  });
});
