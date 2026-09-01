import { describe, expect, it } from "vitest";
import {
  WAVESPEED_OPEN_VIDEO_MODEL_ID,
  serverEnvSchema,
} from "@app/shared";
import {
  computeGenerationRequestHash,
  planGenerationResolution,
  type GenerationRequestFacts,
} from "@app/domain";
import { createVideoModelCatalog, MINIMAX_H3_MAX_MODEL_ID } from "./catalog";
import { createVideoProvider } from "./factory";
import { OPEN_VIDEO_CAPABILITY } from "./wavespeed/capability";

const catalog = createVideoModelCatalog();

describe("the default product model", () => {
  it("is MiniMax H3 Max on fal", () => {
    const entry = catalog.default();
    expect(entry.key).toBe("minimax-h3-max");
    expect(entry.displayName).toBe("MiniMax H3 Max");
    expect(entry.providerName).toBe("fal");
    expect(entry.providerModelId).toBe(MINIMAX_H3_MAX_MODEL_ID);
    expect(entry.tier).toBe("RECOMMENDED");
  });

  it("is the only entry marked recommended", () => {
    const recommended = catalog.list().filter((entry) => entry.recommended);
    expect(recommended.map((entry) => entry.key)).toEqual(["minimax-h3-max"]);
    expect(catalog.default().recommended).toBe(true);
  });

  /**
   * Being the default *model* is not being an executable *request*. The catalog
   * is a table; nothing about it selects an adapter or spends money.
   */
  it("does not make fal the configured execution provider", () => {
    const env = serverEnvSchema.parse({
      SESSION_SECRET: "session-secret-abcdef123456",
      HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
      STORAGE_SIGNING_SECRET: "storage-signing-secret-abc",
    });
    expect(env.VIDEO_PROVIDER).toBe("fake");
    expect(createVideoProvider(env).name).toBe("fake");
  });

  it("cannot be configured as an execution provider at all", () => {
    // `fal` is a catalog identity, not a wired adapter. The env enum refuses it,
    // so no deployment can point execution at a provider that does not exist.
    const parsed = serverEnvSchema.safeParse({
      SESSION_SECRET: "session-secret-abcdef123456",
      HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
      STORAGE_SIGNING_SECRET: "storage-signing-secret-abc",
      VIDEO_PROVIDER: "fal",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("H3 Max native generation is 768P, never 720p or 1080p", () => {
  const h3Max = catalog.default();

  it("declares 768P as its native generation resolution", () => {
    expect(h3Max.nativeGeneration).toEqual({
      kind: "FIXED",
      native: { providerValue: "768P", heightPx: 768 },
    });
  });

  it("advertises only native generation tokens in its capability", () => {
    // `720p` and `1080p` are product outputs. They must not appear in a list
    // describing what the model generates.
    expect(h3Max.capability.resolutions).toEqual(["480P", "768P"]);
    expect(h3Max.capability.resolutions).not.toContain("720p");
    expect(h3Max.capability.resolutions).not.toContain("1080p");
  });

  it("offers 720p and 1080p as product outputs", () => {
    expect(h3Max.targetOutputResolutions).toEqual(["720p", "1080p"]);
  });

  it("serves a 720p deliverable natively, and a 1080p deliverable by upscale", () => {
    const at720 = planGenerationResolution(h3Max, "720p");
    expect(at720.nativeGenerationResolution.providerValue).toBe("768P");
    expect(at720.nativeMeetsTarget).toBe(true);

    const at1080 = planGenerationResolution(h3Max, "1080p");
    expect(at1080.nativeGenerationResolution.providerValue).toBe("768P");
    expect(at1080.normalization).toBe("UPSCALE");
    expect(at1080.nativeMeetsTarget).toBe(false);
  });

  it("documents 5-15 second durations", () => {
    expect(h3Max.capability.durationSeconds).toEqual({
      kind: "RANGE",
      minSeconds: 5,
      maxSeconds: 15,
    });
  });

  /** fal documents image-to-video output as following the source image. */
  it("leaves aspect ratio to composition", () => {
    expect(h3Max.capability.aspectRatios).toEqual({ kind: "COMPOSITION_OWNED" });
  });
});

describe("unverified models are present but unusable", () => {
  it.each(["minimax-h3", "veo-3-1"])("%s is listed and refused", (key) => {
    const entry = catalog.find(key);
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error("unreachable");
    expect(entry.availability.kind).toBe("UNVERIFIED");
    expect(entry.recommended).toBe(false);
    expect(() => planGenerationResolution(entry, "1080p")).toThrowError(/not verified/);
  });

  it("records what is missing rather than a bare flag", () => {
    const h3 = catalog.find("minimax-h3");
    if (h3?.availability.kind !== "UNVERIFIED") throw new Error("expected UNVERIFIED");
    expect(h3.availability.missing.length).toBeGreaterThan(0);
    // The reason H3 has no native height: "2K" has no single reading in lines,
    // and nothing here invents one.
    expect(h3.availability.missing.join(" ")).toContain("2K");
  });

  it("carries no pricing for any model, verified or not", () => {
    for (const entry of catalog.list()) {
      expect(`${entry.key}:${String(entry.pricing)}`).toBe(`${entry.key}:null`);
    }
  });
});

describe("WaveSpeed remains supported and unchanged", () => {
  const wavespeed = catalog.find("wavespeed-open-video");

  it("is still selectable", () => {
    expect(wavespeed?.availability).toEqual({ kind: "SELECTABLE" });
    expect(wavespeed?.providerName).toBe("wavespeed");
    expect(wavespeed?.providerModelId).toBe(WAVESPEED_OPEN_VIDEO_MODEL_ID);
  });

  /**
   * By reference, not by restatement. A copied descriptor is a descriptor that
   * can drift from the one ADR-0019 froze.
   */
  it("reuses the frozen OpenVideo capability descriptor itself", () => {
    expect(wavespeed?.capability).toBe(OPEN_VIDEO_CAPABILITY);
    expect(OPEN_VIDEO_CAPABILITY.resolutions).toEqual(["480p", "720p", "1080p"]);
    expect(OPEN_VIDEO_CAPABILITY.cameraMotion).toEqual({ kind: "PROMPT_RENDERED" });
    expect(OPEN_VIDEO_CAPABILITY.negativePrompt).toEqual({ kind: "UNSUPPORTED" });
  });

  it("generates natively at both product outputs, needing no normalization", () => {
    if (wavespeed === undefined) throw new Error("unreachable");
    for (const target of ["720p", "1080p"] as const) {
      const plan = planGenerationResolution(wavespeed, target);
      expect(`${target}:${plan.normalization}`).toBe(`${target}:NONE`);
      expect(plan.nativeMeetsTarget).toBe(true);
    }
  });
});

describe("existing generations are not retargeted by the catalog default", () => {
  /**
   * The immutable request snapshot already carries `providerName` and
   * `providerModelId`, and request identity is computed from those persisted
   * facts — never from a catalog lookup. Changing the default model therefore
   * cannot move an admitted generation onto H3 Max, and this test is the pin
   * that says so.
   */
  const admittedOnWaveSpeed: GenerationRequestFacts = {
    assetId: "asset-1",
    compiledPrompt: "a sunlit living room",
    durationSeconds: 6,
    cameraMotion: null,
    aspectRatio: "16:9",
    resolution: "720p",
    providerName: "wavespeed",
    providerModelId: WAVESPEED_OPEN_VIDEO_MODEL_ID,
  };

  it("keeps a WaveSpeed-admitted request hashing to its own provider and model", () => {
    const before = computeGenerationRequestHash(admittedOnWaveSpeed);
    // Introducing the catalog, and making H3 Max the default, changes nothing
    // about a request already admitted under another model.
    expect(catalog.default().providerName).toBe("fal");
    expect(computeGenerationRequestHash(admittedOnWaveSpeed)).toBe(before);
  });

  it("gives a different identity to the same request on a different model", () => {
    const onWaveSpeed = computeGenerationRequestHash(admittedOnWaveSpeed);
    const onH3Max = computeGenerationRequestHash({
      ...admittedOnWaveSpeed,
      providerName: "fal",
      providerModelId: MINIMAX_H3_MAX_MODEL_ID,
    });
    expect(onH3Max).not.toBe(onWaveSpeed);
  });

  /**
   * Resolution is already a hashed fact, so a change to it changes identity.
   * Under today's single-field contract that value is
   * **LEGACY_AMBIGUOUS** — it is simultaneously the product target and the
   * native token, because for OpenVideo they coincide. Separating them changes
   * what is hashed, which is why that migration is its own milestone
   * (Phase 4C-3B-2B) rather than a side effect of this one.
   */
  it("already treats resolution as identity-bearing", () => {
    const at720 = computeGenerationRequestHash(admittedOnWaveSpeed);
    const at1080 = computeGenerationRequestHash({
      ...admittedOnWaveSpeed,
      resolution: "1080p",
    });
    expect(at1080).not.toBe(at720);
  });
});

describe("the catalog performs no provider work", () => {
  it("has stable, duplicate-free keys", () => {
    const keys = catalog.list().map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["minimax-h3-max", "minimax-h3", "veo-3-1", "wavespeed-open-video"]);
  });

  it("returns the same frozen entries every time, and cannot be mutated", () => {
    expect(createVideoModelCatalog().list()).toBe(catalog.list());
    expect(Object.isFrozen(catalog.list())).toBe(true);
    for (const entry of catalog.list()) expect(Object.isFrozen(entry)).toBe(true);
  });

  it("finds nothing for an unknown key, prototype-safely", () => {
    for (const key of ["nope", "toString", "constructor", "__proto__"]) {
      expect(`${key}:${String(catalog.find(key))}`).toBe(`${key}:undefined`);
    }
  });
});
