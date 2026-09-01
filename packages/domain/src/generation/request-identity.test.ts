import { describe, expect, it } from "vitest";
import { computeGenerationRequestHash } from "./request-identity";
import type { GenerationRequestFacts } from "./types";

const BASE: GenerationRequestFacts = {
  assetId: "ast_1",
  compiledPrompt: JSON.stringify({
    preservation: ["Preserve visible structure"],
    sceneFacts: { roomType: "KITCHEN", durationSeconds: 4 },
    userCustomization: null,
    negativeConstraints: { system: ["no people"], user: null },
  }),
  durationSeconds: 4,
  cameraMotion: "slow push in",
  aspectRatio: "16:9",
  targetOutputResolution: "1080p",
  nativeGenerationResolution: "1080p",
  resolutionNormalization: "NONE",
  nativeMeetsTarget: true,
  modelKey: "wavespeed-open-video",
  providerName: "wavespeed",
  providerModelId: "wavespeed-ai/open-video/image-to-video",
};

const hash = (overrides: Partial<GenerationRequestFacts> = {}): string =>
  computeGenerationRequestHash({ ...BASE, ...overrides });

describe("computeGenerationRequestHash", () => {
  it("returns a stable, self-describing digest", () => {
    // `v2` is part of the contract, not decoration: a V1 row and a V2 row must
    // stay distinguishable in stored data forever, because the same request
    // hashes differently under the two tuples (ADR-0034).
    expect(hash()).toMatch(/^sha256:v2:[0-9a-f]{64}$/);
  });

  it("gives the same digest for the same request", () => {
    expect(hash()).toBe(hash());
    expect(computeGenerationRequestHash({ ...BASE })).toBe(hash());
  });

  it("ignores the order the properties arrive in", () => {
    // The payload is built as a positional tuple, so object key order cannot
    // reach the digest.
    const reordered: GenerationRequestFacts = {
      providerModelId: BASE.providerModelId,
      nativeMeetsTarget: BASE.nativeMeetsTarget,
      resolutionNormalization: BASE.resolutionNormalization,
      nativeGenerationResolution: BASE.nativeGenerationResolution,
      targetOutputResolution: BASE.targetOutputResolution,
      modelKey: BASE.modelKey,
      providerName: BASE.providerName,
      aspectRatio: BASE.aspectRatio,
      cameraMotion: BASE.cameraMotion,
      durationSeconds: BASE.durationSeconds,
      compiledPrompt: BASE.compiledPrompt,
      assetId: BASE.assetId,
    };
    expect(computeGenerationRequestHash(reordered)).toBe(hash());
  });
});

describe("what changes the request", () => {
  it.each([
    ["the source photo", { assetId: "ast_2" }],
    ["the compiled prompt", { compiledPrompt: JSON.stringify({ different: true }) }],
    ["the duration", { durationSeconds: 5 }],
    ["the camera motion", { cameraMotion: "slow pull out" }],
    ["the aspect ratio", { aspectRatio: "9:16" }],
    ["the output the customer asked for", { targetOutputResolution: "720p" }],
    ["what the model is asked to generate", { nativeGenerationResolution: "768P" }],
    // Both of these are derivable from today's catalog, and both are still
    // identity. A catalog correction to how a model reaches 1080p must not make
    // a new request compare equal to one admitted under the old plan.
    ["how the target is reached", { resolutionNormalization: "UPSCALE" }],
    ["whether the native generation meets the target", { nativeMeetsTarget: false }],
    ["the selected model", { modelKey: "minimax-h3-max" }],
    ["the provider", { providerName: "fake" }],
    ["the model", { providerModelId: "some-other/model" }],
  ] as const)("a different %s is a different request", (_label, overrides) => {
    expect(hash(overrides)).not.toBe(hash());
  });

  it("treats clearing the camera motion as a different request", () => {
    // null is a real value here, not an absence to be coalesced away.
    expect(hash({ cameraMotion: null })).not.toBe(hash());
  });

  it("does not confuse a prompt change with an equivalent rewording", () => {
    // Identity is textual, not semantic. Two prompts a human would call the
    // same are different requests, because nothing here can prove otherwise.
    const reworded = JSON.parse(BASE.compiledPrompt) as { preservation: string[] };
    reworded.preservation = ["Preserve the visible structure"];
    expect(hash({ compiledPrompt: JSON.stringify(reworded) })).not.toBe(hash());
  });
});

describe("what does not change the request", () => {
  // These facts exist on the scene or the attempt but are deliberately outside
  // the identity. The type does not carry them at all, which is the strongest
  // guarantee available — passing them cannot move the digest because the
  // function never reads them.
  it.each([
    ["scene position", { position: 7 }],
    ["the source analysis revision", { sourceAnalysisRevision: 9 }],
    ["the storyboard scene id", { sourceStoryboardSceneId: "scn_other" }],
    ["a timestamp", { createdAt: new Date("2026-01-01T00:00:00Z") }],
    ["the tenant", { organizationId: "org_2" }],
    ["the acting user", { createdBy: "usr_2" }],
    ["a provider prediction id", { providerPredictionId: "pred_abc" }],
    ["a temporary output URL", { temporaryOutputUrl: "https://provider.example/tmp/x" }],
  ] as const)("%s does not participate", (_label, extra) => {
    const contaminated = { ...BASE, ...extra } as GenerationRequestFacts;
    expect(computeGenerationRequestHash(contaminated)).toBe(hash());
  });

  it("keeps a recomposition from manufacturing a new paid request", () => {
    // Recomposing replaces every scene with a fresh id. If the request facts
    // are unchanged, the identity must be unchanged too — otherwise every
    // recompose would look like a new request and could be billed again.
    const beforeRecompose = { ...BASE, sourceStoryboardSceneId: "scn_a" };
    const afterRecompose = { ...BASE, sourceStoryboardSceneId: "scn_b" };
    expect(computeGenerationRequestHash(beforeRecompose as GenerationRequestFacts)).toBe(
      computeGenerationRequestHash(afterRecompose as GenerationRequestFacts),
    );
  });

  it("keeps a re-analysis that changes nothing generative from re-billing", () => {
    const before = { ...BASE, sourceAnalysisRevision: 1 };
    const after = { ...BASE, sourceAnalysisRevision: 2 };
    expect(computeGenerationRequestHash(before as GenerationRequestFacts)).toBe(
      computeGenerationRequestHash(after as GenerationRequestFacts),
    );
  });
});

describe("the V2 tuple is pinned", () => {
  /**
   * A literal digest, deliberately.
   *
   * Every other test here is relative — it proves two hashes differ, which
   * stays true under a reordered tuple, a renamed field, or an accidentally
   * dropped one, as long as the change is applied to both sides. This one
   * cannot: it fails the moment the tuple's order or membership changes at all.
   *
   * That matters because `requestHash` is stored. A silent change to how it is
   * computed does not corrupt anything visibly — it makes every already-admitted
   * attempt fail its own self-verification, and makes every in-flight request
   * look new, which is a duplicate provider charge rather than an error.
   *
   * If this test fails, the correct response is almost never to update the
   * expected value. It is to bump the identity version, as ADR-0034 did, so old
   * rows stay distinguishable instead of being reinterpreted.
   */
  it("produces a known digest for a known request", () => {
    expect(
      computeGenerationRequestHash({
        assetId: "ast_pin",
        compiledPrompt: '{"preservation":["keep the window"]}',
        durationSeconds: 5,
        cameraMotion: "SLOW_PAN_LEFT",
        aspectRatio: "16:9",
        targetOutputResolution: "1080p",
        nativeGenerationResolution: "768P",
        resolutionNormalization: "UPSCALE",
        nativeMeetsTarget: false,
        modelKey: "minimax-h3-max",
        providerName: "fal",
        providerModelId: "minimax/h3-max/image-to-video",
      }),
    ).toBe("sha256:v2:b9d40169fa977c730c3dd8014fbeac0211fe706f1d7d59ed448243f88c23f617");
  });
});

describe("encoding", () => {
  it("cannot be collided by a value containing a delimiter", () => {
    // Structure, not concatenation: no choice of separator can merge two
    // different requests, which is why the payload is a JSON tuple.
    const a = hash({ assetId: "ast_1", cameraMotion: "x" });
    const b = hash({ assetId: 'ast_1","x', cameraMotion: "" });
    expect(a).not.toBe(b);
  });

  it("is not the composition fingerprint", () => {
    // Both are canonical sha256 digests, but they answer different
    // questions and must never be interchanged: one identifies an approved
    // input set, this one identifies a single paid provider request.
    expect(hash()).toMatch(/^sha256:v2:/);
    expect(hash()).not.toBe(
      "sha256:v2:0000000000000000000000000000000000000000000000000000000000000000",
    );
  });
});
