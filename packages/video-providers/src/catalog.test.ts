import { describe, expect, it } from "vitest";
import { WAVESPEED_OPEN_VIDEO_MODEL_ID, serverEnvSchema } from "@app/shared";
import {
  PRESERVATION_RULES,
  SYSTEM_NEGATIVE_CONSTRAINTS,
  computeGenerationRequestHash,
  isSelectableModel,
  planGenerationResolution,
  renderPrompt,
  supportedTargetOutputResolutions,
  type CameraMotion,
  type CompiledPrompt,
  type GenerationRequestFacts,
} from "@app/domain";
import { createVideoModelCatalog, MINIMAX_H3_MAX_MODEL_ID } from "./catalog";
import { createVideoProvider } from "./factory";
import { OPEN_VIDEO_CAPABILITY, createOpenVideoCapabilityProvider } from "./wavespeed/capability";

const catalog = createVideoModelCatalog();

const baseEnv = {
  SESSION_SECRET: "session-secret-abcdef123456",
  HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
  STORAGE_SIGNING_SECRET: "storage-signing-secret-abc",
};

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
    expect(catalog.list().filter((e) => e.recommended).map((e) => e.key)).toEqual([
      "minimax-h3-max",
    ]);
  });

  /**
   * `SELECTABLE` is product model-selection eligibility, not paid-execution
   * readiness. H3 Max is selectable and has no adapter at all — the two are
   * independent, and this test exists so nobody reads the first as the second.
   */
  it("is selectable without any execution path existing", () => {
    expect(isSelectableModel(catalog.default())).toBe(true);
    const env = serverEnvSchema.parse(baseEnv);
    expect(env.VIDEO_PROVIDER).toBe("fake");
    expect(createVideoProvider(env).name).toBe("fake");
    // Selectable, yet unpriced — one more reason it is not execution-ready.
    expect(catalog.default().pricing).toBeNull();
  });

  it("cannot be configured as an execution provider at all", () => {
    // `fal` is a catalog identity, not a wired adapter.
    expect(serverEnvSchema.safeParse({ ...baseEnv, VIDEO_PROVIDER: "fal" }).success).toBe(false);
  });
});

describe("H3 Max carries only verified fal facts", () => {
  const h3Max = catalog.default();

  it("declares the documented native tokens, and no product output among them", () => {
    expect(h3Max.capability.nativeGenerationResolutions).toEqual(["480P", "768P"]);
    expect(h3Max.capability.nativeGenerationResolutions).not.toContain("720p");
    expect(h3Max.capability.nativeGenerationResolutions).not.toContain("1080p");
  });

  it("documents 5-15 second durations", () => {
    expect(h3Max.capability.durationSeconds).toEqual({
      kind: "RANGE",
      minSeconds: 5,
      maxSeconds: 15,
    });
  });

  /** fal documents image-to-video output as following the supplied image. */
  it("leaves aspect ratio to composition", () => {
    expect(h3Max.capability.aspectRatios).toEqual({ kind: "COMPOSITION_OWNED" });
  });

  it("serves 720p as a downscale and 1080p as an upscale, from one 768P generation", () => {
    const at720 = planGenerationResolution(h3Max, "720p");
    expect(at720.nativeGenerationResolution).toEqual({ providerValue: "768P" });
    expect(at720.normalization).toBe("DOWNSCALE");
    expect(at720.nativeMeetsTarget).toBe(true);

    const at1080 = planGenerationResolution(h3Max, "1080p");
    expect(at1080.nativeGenerationResolution).toEqual({ providerValue: "768P" });
    expect(at1080.normalization).toBe("UPSCALE");
    expect(at1080.nativeMeetsTarget).toBe(false);
  });

  it("offers both product outputs", () => {
    expect(supportedTargetOutputResolutions(h3Max)).toEqual(["720p", "1080p"]);
  });
});

/**
 * The declaration follows the behaviour, never the reverse.
 *
 * H3 Max declares `cameraMotion: PROMPT_RENDERED`, which is a claim about the
 * renderer that the type system cannot check — the same claim OpenVideo makes
 * and owes a test for (ADR-0019, ADR-0020). Asserting the enum value would only
 * restate the constant; these assertions tie it to what `renderPrompt`
 * demonstrably does, so if the renderer stopped carrying motion the declaration
 * would have to become `UNSUPPORTED`.
 */
describe("H3 Max's PROMPT_RENDERED claim is tied to the real renderer", () => {
  const MOTION: CameraMotion = "SLOW_DOLLY_FORWARD";
  const MOTION_TEXT = "Move the camera slowly forward into the room.";

  function compiled(cameraMotion: CameraMotion | null): CompiledPrompt {
    return {
      preservation: [...PRESERVATION_RULES],
      sceneFacts: {
        assetId: "ast_1",
        position: 1,
        roomType: "LIVING_ROOM",
        durationSeconds: 6,
        cameraMotion,
      },
      userCustomization: null,
      negativeConstraints: { system: [...SYSTEM_NEGATIVE_CONSTRAINTS], user: null },
    };
  }

  it("declares camera motion as prompt-rendered", () => {
    expect(catalog.default().capability.cameraMotion).toEqual({ kind: "PROMPT_RENDERED" });
  });

  it("actually carries the motion intent into the rendered prompt", () => {
    const rendered = renderPrompt(JSON.stringify(compiled(MOTION)));
    expect(rendered).toContain(MOTION_TEXT);
  });

  it("omits motion text when the scene carries none, so the claim is discriminating", () => {
    const rendered = renderPrompt(JSON.stringify(compiled(null)));
    expect(rendered).not.toContain(MOTION_TEXT);
  });

  it("would be unsupportable if the renderer dropped motion", () => {
    // The pin: the declaration is only honest while these two differ.
    const withMotion = renderPrompt(JSON.stringify(compiled(MOTION)));
    const withoutMotion = renderPrompt(JSON.stringify(compiled(null)));
    expect(withMotion).not.toBe(withoutMotion);
  });
});

describe("unverified models carry identity and nothing operational", () => {
  it.each(["minimax-h3", "veo-3-1"])("%s is listed and refused", (key) => {
    const entry = catalog.find(key);
    if (entry === undefined) throw new Error("unreachable");
    expect(entry.availability.kind).toBe("UNVERIFIED");
    expect(entry.recommended).toBe(false);
    expect(isSelectableModel(entry)).toBe(false);
    expect(() => planGenerationResolution(entry, "1080p")).toThrowError(/not verified/);
  });

  /**
   * No `heightPx: 0`, no 1-to-1-second duration range, no `"unverified"` token.
   * The entry has no slot for any of them.
   */
  /**
   * The exact key set is the assertion: no `providerModelId`, no capability, no
   * native policy, no pricing, and no room for a placeholder to return. A
   * provider model id is where a paid request would be sent, and these are
   * exactly the models whose contract nobody has frozen — Veo 3.1 publishes
   * standard, Fast and other variants, so naming one would present an unmade
   * choice as a decision.
   */
  it.each(["minimax-h3", "veo-3-1"])("%s holds no operational fact and no id", (key) => {
    const entry = catalog.find(key);
    if (entry === undefined) throw new Error("unreachable");
    expect(Object.keys(entry).sort()).toEqual([
      "availability",
      "displayName",
      "key",
      "providerName",
      "recommended",
      "tier",
    ]);
    expect(supportedTargetOutputResolutions(entry)).toEqual([]);
    // No indirect holder either — no candidate id, no metadata bag.
    expect(JSON.stringify(entry)).not.toContain("image-to-video");
  });

  it("records what is unresolved, and no longer claims the endpoint is unknown", () => {
    const h3 = catalog.find("minimax-h3");
    if (h3?.availability.kind !== "UNVERIFIED") throw new Error("expected UNVERIFIED");
    expect(h3.availability.missing).toContain("verified pricing contract");
    // The route is known; the product contract is not. Saying otherwise was stale.
    expect(h3.availability.missing.join(" ")).not.toContain("exact production endpoint");

    const veo = catalog.find("veo-3-1");
    if (veo?.availability.kind !== "UNVERIFIED") throw new Error("expected UNVERIFIED");
    expect(veo.availability.missing).toContain(
      "production variant selection and frozen endpoint contract",
    );
  });

  it("keeps the verified entries' provider model ids intact", () => {
    expect(catalog.default().providerModelId).toBe("minimax/h3-max/image-to-video");
    const wavespeed = catalog.find("wavespeed-open-video");
    if (wavespeed === undefined || !isSelectableModel(wavespeed)) throw new Error("unreachable");
    expect(wavespeed.providerModelId).toBe(WAVESPEED_OPEN_VIDEO_MODEL_ID);
  });

  it("carries no pricing for any model, verified or not", () => {
    for (const entry of catalog.list()) {
      // A verified entry may hold pricing and holds none; an unverified entry
      // has no slot for it at all.
      const shown = isSelectableModel(entry) ? String(entry.pricing) : "no such field";
      expect(`${entry.key}:${shown}`).toBe(
        `${entry.key}:${isSelectableModel(entry) ? "null" : "no such field"}`,
      );
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

  it("reuses the frozen OpenVideo capability descriptor itself", () => {
    if (wavespeed === undefined || !isSelectableModel(wavespeed)) throw new Error("unreachable");
    expect(wavespeed.capability).toBe(OPEN_VIDEO_CAPABILITY);
    expect(OPEN_VIDEO_CAPABILITY.nativeGenerationResolutions).toEqual(["480p", "720p", "1080p"]);
    expect(OPEN_VIDEO_CAPABILITY.cameraMotion).toEqual({ kind: "PROMPT_RENDERED" });
  });

  it("generates natively at both product outputs, needing no normalization", () => {
    if (wavespeed === undefined) throw new Error("unreachable");
    for (const target of ["720p", "1080p"] as const) {
      const plan = planGenerationResolution(wavespeed, target);
      expect(`${target}:${plan.normalization}`).toBe(`${target}:NONE`);
      expect(plan.nativeMeetsTarget).toBe(true);
      expect(plan.nativeGenerationResolution.providerValue).toBe(target);
    }
  });
});

/**
 * Runtime immutability, not the compile-time courtesy.
 *
 * `readonly` disappears at runtime and does not apply to a JavaScript consumer
 * at all, and `Object.freeze` is one level deep — a "frozen" entry would still
 * hand out a live `resolutions` array. The OpenVideo descriptor makes this
 * concrete: it is shared **by reference** between the capability provider and
 * the catalog, so one mutation through either reference would poison both.
 */
describe("catalog data is deeply immutable at runtime", () => {
  function attempt(mutate: () => void): void {
    // Frozen objects throw in strict mode (modules are always strict); either
    // way the assertion that follows is on the observed state.
    try {
      mutate();
    } catch {
      /* expected */
    }
  }

  it("refuses mutation of a capability's resolutions array", () => {
    const h3Max = catalog.default();
    attempt(() => (h3Max.capability.nativeGenerationResolutions as string[]).push("4K"));
    attempt(() => ((h3Max.capability.nativeGenerationResolutions as string[])[0] = "poisoned"));
    expect(createVideoModelCatalog().default().capability.nativeGenerationResolutions).toEqual(["480P", "768P"]);
  });

  it("refuses mutation of a native generation policy", () => {
    const h3Max = catalog.default();
    const at1080 = h3Max.nativeGeneration.byTarget["1080p"];
    if (at1080 === undefined) throw new Error("unreachable");
    attempt(() => ((at1080 as { nativeMeetsTarget: boolean }).nativeMeetsTarget = true));
    attempt(
      () =>
        ((at1080.nativeGenerationResolution as { providerValue: string }).providerValue = "1080p"),
    );
    const after = planGenerationResolution(createVideoModelCatalog().default(), "1080p");
    expect(after.nativeMeetsTarget).toBe(false);
    expect(after.nativeGenerationResolution.providerValue).toBe("768P");
  });

  it("refuses mutation of an availability missing list", () => {
    // Bind the nested value: TypeScript narrows a variable, not a property
    // path, and the mutation happens inside a callback.
    const availability = catalog.find("minimax-h3")?.availability;
    if (availability === undefined || availability.kind !== "UNVERIFIED") {
      throw new Error("unreachable");
    }
    const before = [...availability.missing];
    attempt(() => (availability.missing as string[]).push("nothing, actually"));
    const reread = createVideoModelCatalog().find("minimax-h3");
    if (reread?.availability.kind !== "UNVERIFIED") throw new Error("unreachable");
    expect([...reread.availability.missing]).toEqual(before);
  });

  it("refuses mutation of the entry list", () => {
    attempt(() => (catalog.list() as unknown[]).pop());
    expect(createVideoModelCatalog().list()).toHaveLength(4);
  });

  it("refuses mutation of an entry's own fields", () => {
    const h3Max = catalog.default();
    attempt(() => ((h3Max as { recommended: boolean }).recommended = false));
    attempt(() => ((h3Max as { key: string }).key = "hijacked"));
    expect(createVideoModelCatalog().default().recommended).toBe(true);
    expect(createVideoModelCatalog().default().key).toBe("minimax-h3-max");
  });

  /**
   * The shared-reference case. Poisoning `resolutions` through the catalog must
   * not change what the capability provider hands to admission — that array
   * decides which resolutions a paid request may ask for.
   */
  it("cannot poison the shared OpenVideo descriptor through the catalog", () => {
    const wavespeed = catalog.find("wavespeed-open-video");
    if (wavespeed === undefined || !isSelectableModel(wavespeed)) throw new Error("unreachable");
    attempt(() => (wavespeed.capability.nativeGenerationResolutions as string[]).push("8K"));
    attempt(() => ((wavespeed.capability.nativeGenerationResolutions as string[])[0] = "poisoned"));
    attempt(
      () =>
        ((wavespeed.capability.cameraMotion as { kind: string }).kind = "UNSUPPORTED"),
    );

    expect(createOpenVideoCapabilityProvider().current().nativeGenerationResolutions).toEqual([
      "480p",
      "720p",
      "1080p",
    ]);
    expect(createOpenVideoCapabilityProvider().current().cameraMotion).toEqual({
      kind: "PROMPT_RENDERED",
    });
    expect(OPEN_VIDEO_CAPABILITY.nativeGenerationResolutions).toEqual(["480p", "720p", "1080p"]);
  });

  it("freezes every reachable object in the graph", () => {
    for (const entry of catalog.list()) {
      expect(`${entry.key}:${Object.isFrozen(entry)}`).toBe(`${entry.key}:true`);
      expect(Object.isFrozen(entry.availability)).toBe(true);
      if (isSelectableModel(entry)) {
        expect(Object.isFrozen(entry.capability)).toBe(true);
        expect(Object.isFrozen(entry.capability.nativeGenerationResolutions)).toBe(true);
        expect(Object.isFrozen(entry.capability.durationSeconds)).toBe(true);
        expect(Object.isFrozen(entry.capability.aspectRatios)).toBe(true);
        expect(Object.isFrozen(entry.capability.cameraMotion)).toBe(true);
        expect(Object.isFrozen(entry.capability.negativePrompt)).toBe(true);
        expect(Object.isFrozen(entry.nativeGeneration.byTarget)).toBe(true);
        for (const target of supportedTargetOutputResolutions(entry)) {
          const delivery = entry.nativeGeneration.byTarget[target];
          expect(Object.isFrozen(delivery)).toBe(true);
          expect(Object.isFrozen(delivery?.nativeGenerationResolution)).toBe(true);
        }
      }
      const availability = entry.availability;
      if (availability.kind === "UNVERIFIED") {
        expect(Object.isFrozen(availability.missing)).toBe(true);
      }
    }
    expect(Object.isFrozen(catalog.list())).toBe(true);
  });
});

describe("existing generations are not retargeted by the catalog default", () => {
  /**
   * The immutable request snapshot already carries `providerName` and
   * `providerModelId`, and request identity is computed from those persisted
   * facts — never from a catalog lookup. Changing the default therefore cannot
   * move an admitted generation onto H3 Max.
   */
  const admittedOnWaveSpeed: GenerationRequestFacts = {
    assetId: "asset-1",
    compiledPrompt: "a sunlit living room",
    durationSeconds: 6,
    cameraMotion: null,
    aspectRatio: "16:9",
    targetOutputResolution: "720p",
    nativeGenerationResolution: "720p",
    resolutionNormalization: "NONE",
    nativeMeetsTarget: true,
    modelKey: "wavespeed-open-video",
    providerName: "wavespeed",
    providerModelId: WAVESPEED_OPEN_VIDEO_MODEL_ID,
  };

  it("keeps a WaveSpeed-admitted request hashing to its own provider and model", () => {
    const before = computeGenerationRequestHash(admittedOnWaveSpeed);
    expect(catalog.default().providerName).toBe("fal");
    expect(computeGenerationRequestHash(admittedOnWaveSpeed)).toBe(before);
  });

  it("gives a different identity to the same request on a different model", () => {
    expect(
      computeGenerationRequestHash({
        ...admittedOnWaveSpeed,
        modelKey: "minimax-h3-max",
        providerName: "fal",
        providerModelId: MINIMAX_H3_MAX_MODEL_ID,
      }),
    ).not.toBe(computeGenerationRequestHash(admittedOnWaveSpeed));
  });

  /**
   * The single ambiguous `resolution` this file described as LEGACY_AMBIGUOUS is
   * gone. Phase 4C-3B-2B split it into the product target and the native token,
   * and both are identity-bearing separately — which is what lets two requests
   * that generate identically but promise different deliverables stay distinct.
   */
  it("treats the product target and the native token as separate identity", () => {
    expect(
      computeGenerationRequestHash({ ...admittedOnWaveSpeed, targetOutputResolution: "1080p" }),
    ).not.toBe(computeGenerationRequestHash(admittedOnWaveSpeed));
    expect(
      computeGenerationRequestHash({ ...admittedOnWaveSpeed, nativeGenerationResolution: "1080p" }),
    ).not.toBe(computeGenerationRequestHash(admittedOnWaveSpeed));
  });
});

describe("the catalog performs no provider work", () => {
  it("has stable, duplicate-free keys", () => {
    const keys = catalog.list().map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["minimax-h3-max", "minimax-h3", "veo-3-1", "wavespeed-open-video"]);
  });

  it("returns the same entries every time", () => {
    expect(createVideoModelCatalog().list()).toBe(catalog.list());
  });

  it("finds nothing for an unknown key, prototype-safely", () => {
    for (const key of ["nope", "toString", "constructor", "__proto__"]) {
      expect(`${key}:${String(catalog.find(key))}`).toBe(`${key}:undefined`);
    }
  });
});
