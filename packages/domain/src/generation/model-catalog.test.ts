import { describe, expect, it } from "vitest";
import {
  TARGET_OUTPUT_RESOLUTIONS,
  isSelectableModel,
  isTargetOutputResolution,
  planGenerationResolution,
  supportedTargetOutputResolutions,
  type TargetOutputResolution,
  type ModelEntryIdentity,
  type UnverifiedModelEntry,
  type VerifiedModelEntry,
  type VideoModelEntry,
} from "./model-catalog";
import type { VideoModelCapability } from "./capability";

type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;
type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const capability: VideoModelCapability = {
  providerName: "test-provider",
  providerModelId: "test/model",
  durationSeconds: { kind: "RANGE", minSeconds: 5, maxSeconds: 15 },
  nativeGenerationResolutions: ["768P"],
  aspectRatios: { kind: "COMPOSITION_OWNED" },
  negativePrompt: { kind: "UNSUPPORTED" },
  cameraMotion: { kind: "PROMPT_RENDERED" },
};

/** A model shaped like H3 Max: one native token serving both targets differently. */
const fixedNative: VerifiedModelEntry = {
  key: "test-fixed",
  providerName: "test-provider",
  providerModelId: "test/model",
  displayName: "Fixed Native",
  tier: "RECOMMENDED",
  recommended: true,
  availability: { kind: "SELECTABLE" },
  capability,
  nativeGeneration: {
    byTarget: {
      "720p": {
        nativeGenerationResolution: { providerValue: "768P" },
        normalization: "DOWNSCALE",
        nativeMeetsTarget: true,
      },
      "1080p": {
        nativeGenerationResolution: { providerValue: "768P" },
        normalization: "UPSCALE",
        nativeMeetsTarget: false,
      },
    },
  },
  pricing: null,
};

/** A model shaped like OpenVideo: native generation at each product target. */
const perTarget: VerifiedModelEntry = {
  ...fixedNative,
  key: "test-per-target",
  nativeGeneration: {
    byTarget: {
      "720p": {
        nativeGenerationResolution: { providerValue: "720p" },
        normalization: "NONE",
        nativeMeetsTarget: true,
      },
      "1080p": {
        nativeGenerationResolution: { providerValue: "1080p" },
        normalization: "NONE",
        nativeMeetsTarget: true,
      },
    },
  },
};

const unverified: UnverifiedModelEntry = {
  key: "test-unverified",
  providerName: "test-provider",
  displayName: "Unverified",
  tier: "HIGH_RESOLUTION",
  recommended: false,
  availability: { kind: "UNVERIFIED", missing: ["native generation resolution tokens"] },
};

describe("the product target vocabulary is closed", () => {
  it("supports exactly 720p and 1080p", () => {
    expect(TARGET_OUTPUT_RESOLUTIONS).toEqual(["720p", "1080p"]);
  });

  it("refuses anything else, including native generation tokens", () => {
    // `768P` is a *native* token. Admitting it as a product target is exactly
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

describe("an unverified entry cannot hold operational facts", () => {
  /**
   * The blocker this correction closes. An earlier revision filled unverified
   * entries with placeholders — a zero height, a 1-to-1-second duration range,
   * a literal `"unverified"` token — purely to satisfy one wide interface, and
   * argued they were safe because planning refused the entry. Unreachable
   * fabricated data is still fabricated data. Now the type forbids it.
   */
  it("rejects an id, a capability, a native policy or pricing at compile time", () => {
    type WithId = UnverifiedModelEntry & { providerModelId: string };
    type WithCapability = UnverifiedModelEntry & { capability: VideoModelCapability };
    type WithNative = UnverifiedModelEntry & {
      nativeGeneration: VerifiedModelEntry["nativeGeneration"];
    };
    type WithPricing = UnverifiedModelEntry & { pricing: null };

    // Each resolves to `never` on the forbidden member, which is what makes the
    // combination unconstructible rather than merely discouraged.
    const noId: Assert<IsNever<WithId["providerModelId"]>> = true;
    const noCapability: Assert<IsNever<WithCapability["capability"]>> = true;
    const noNative: Assert<IsNever<WithNative["nativeGeneration"]>> = true;
    const noPricing: Assert<IsNever<WithPricing["pricing"]>> = true;

    // And the union itself refuses such a literal — including the id-only case,
    // which is the one that would otherwise look harmless.
    type FabricatedCapability = {
      key: string;
      providerName: string;
      displayName: string;
      tier: "PREMIUM";
      recommended: false;
      availability: { kind: "UNVERIFIED"; missing: readonly string[] };
      capability: VideoModelCapability;
    };
    type FabricatedId = {
      key: string;
      providerName: string;
      displayName: string;
      tier: "PREMIUM";
      recommended: false;
      availability: { kind: "UNVERIFIED"; missing: readonly string[] };
      providerModelId: string;
    };
    const capabilityNotAnEntry: Assert<
      IsExactly<FabricatedCapability extends VideoModelEntry ? true : false, false>
    > = true;
    const idNotAnEntry: Assert<
      IsExactly<FabricatedId extends VideoModelEntry ? true : false, false>
    > = true;

    expect([
      noId,
      noCapability,
      noNative,
      noPricing,
      capabilityNotAnEntry,
      idNotAnEntry,
    ]).toEqual([true, true, true, true, true, true]);
  });

  /**
   * The counterpart: a verified entry must still *require* an id. The rule is
   * "an executable address exists only once the contract is verified", not
   * "ids are optional everywhere".
   */
  it("still requires providerModelId on a verified entry", () => {
    const required: Assert<IsExactly<VerifiedModelEntry["providerModelId"], string>> = true;
    const absentFromSharedIdentity: Assert<
      IsNever<Extract<keyof ModelEntryIdentity, "providerModelId">>
    > = true;
    expect([required, absentFromSharedIdentity]).toEqual([true, true]);
  });

  it("needs no placeholder value to exist at runtime", () => {
    // Only identity and the missing list. No zero, no empty array standing in
    // for a contract, no invented token, and no executable address.
    expect(Object.keys(unverified).sort()).toEqual(
      ["availability", "displayName", "key", "providerName", "recommended", "tier"],
    );
    expect(unverified.availability.missing.length).toBeGreaterThan(0);
  });

  it("is refused before any operational fact is consulted", () => {
    expect(() => planGenerationResolution(unverified, "1080p")).toThrowError(
      /not verified for selection/,
    );
    expect(isSelectableModel(unverified)).toBe(false);
    expect(supportedTargetOutputResolutions(unverified)).toEqual([]);
  });

  it("names the model key and nothing else in its refusal", () => {
    try {
      planGenerationResolution(unverified, "720p");
      expect.unreachable("should have refused");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("test-unverified");
      expect(message).not.toContain("test-provider");
    }
  });
});

describe("delivery is stated per target, never inferred", () => {
  it("serves a 720p target from 768P as a downscale that meets the target", () => {
    const plan = planGenerationResolution(fixedNative, "720p");
    expect(plan.nativeGenerationResolution).toEqual({ providerValue: "768P" });
    expect(plan.normalization).toBe("DOWNSCALE");
    expect(plan.nativeMeetsTarget).toBe(true);
  });

  /**
   * The case the whole separation exists for: the same 768P generation, and an
   * explicit statement that it does not carry 1080p detail.
   */
  it("serves a 1080p target from the same 768P generation, and says it is not native", () => {
    const plan = planGenerationResolution(fixedNative, "1080p");
    expect(plan.nativeGenerationResolution).toEqual({ providerValue: "768P" });
    expect(plan.normalization).toBe("UPSCALE");
    expect(plan.nativeMeetsTarget).toBe(false);
  });

  it("returns the policy verbatim rather than computing it", () => {
    // Reference equality with what the model declared. Nothing was derived, so
    // there is nothing for a parsing bug to get wrong.
    for (const target of TARGET_OUTPUT_RESOLUTIONS) {
      expect(planGenerationResolution(fixedNative, target)).toBe(
        fixedNative.nativeGeneration.byTarget[target],
      );
    }
  });

  /**
   * Provider tokens are opaque. A model may name its native resolution anything
   * — `768P`, `2K`, `hd-plus` — and the relationship still holds, because it
   * was stated rather than parsed out of the string.
   */
  it("works with a provider token carrying no numeric meaning at all", () => {
    const opaque: VerifiedModelEntry = {
      ...fixedNative,
      key: "test-opaque",
      nativeGeneration: {
        byTarget: {
          "1080p": {
            nativeGenerationResolution: { providerValue: "studio-grade" },
            normalization: "NONE",
            nativeMeetsTarget: true,
          },
        },
      },
    };
    const plan = planGenerationResolution(opaque, "1080p");
    expect(plan.nativeGenerationResolution.providerValue).toBe("studio-grade");
    expect(plan.nativeMeetsTarget).toBe(true);
  });

  it("carries no pixel-height field on a native resolution", () => {
    type NativeKeys = keyof VerifiedModelEntry["nativeGeneration"]["byTarget"]["720p"] & string;
    const none: Assert<
      IsNever<Extract<NativeKeys, "heightPx" | "widthPx" | "pixels" | "lines">>
    > = true;
    expect(none).toBe(true);
    const plan = planGenerationResolution(fixedNative, "1080p");
    expect(Object.keys(plan.nativeGenerationResolution)).toEqual(["providerValue"]);
  });

  it("needs no normalization for a model that generates at each target", () => {
    for (const target of TARGET_OUTPUT_RESOLUTIONS) {
      const plan = planGenerationResolution(perTarget, target);
      expect(`${target}:${plan.normalization}`).toBe(`${target}:NONE`);
      expect(plan.nativeMeetsTarget).toBe(true);
    }
  });

  /**
   * Two models with completely different policies planned by the same function
   * — orchestration does not branch on which provider it is.
   */
  it("plans both model shapes through one function", () => {
    expect(planGenerationResolution(fixedNative, "1080p").nativeMeetsTarget).toBe(false);
    expect(planGenerationResolution(perTarget, "1080p").nativeMeetsTarget).toBe(true);
  });
});

describe("supported targets come from the stated policy", () => {
  it("derives them from the policy keys, so no second list can disagree", () => {
    expect(supportedTargetOutputResolutions(fixedNative)).toEqual(["720p", "1080p"]);
    const only720: VerifiedModelEntry = {
      ...fixedNative,
      nativeGeneration: {
        byTarget: {
          "720p": {
            nativeGenerationResolution: { providerValue: "768P" },
            normalization: "DOWNSCALE",
            nativeMeetsTarget: true,
          },
        },
      },
    };
    expect(supportedTargetOutputResolutions(only720)).toEqual(["720p"]);
    expect(() => planGenerationResolution(only720, "1080p")).toThrowError(
      /does not support the 1080p output/,
    );
  });

  it("has no separate targetOutputResolutions field to drift", () => {
    const none: Assert<
      IsNever<Extract<keyof VerifiedModelEntry, "targetOutputResolutions">>
    > = true;
    expect(none).toBe(true);
  });
});

describe("the model entry stays provider-neutral", () => {
  /**
   * The risk is not that someone writes `falQueueUrl` today — it is that a
   * later adapter needs one field, adds it where convenient, and the domain
   * quietly learns about fal.
   */
  it("declares no provider-specific field", () => {
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
    const targetIsClosed: Assert<IsExactly<TargetOutputResolution, "720p" | "1080p">> = true;
    const nativeIsNotATarget: Assert<
      IsExactly<
        [VerifiedModelEntry["nativeGeneration"]] extends [TargetOutputResolution] ? true : false,
        false
      >
    > = true;
    expect([targetIsClosed, nativeIsNotATarget]).toEqual([true, true]);
  });
});
