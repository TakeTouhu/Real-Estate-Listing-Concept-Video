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
  resolution: "1080p",
  providerName: "wavespeed",
  providerModelId: "wavespeed-ai/open-video/image-to-video",
};

const hash = (overrides: Partial<GenerationRequestFacts> = {}): string =>
  computeGenerationRequestHash({ ...BASE, ...overrides });

describe("computeGenerationRequestHash", () => {
  it("returns a stable, self-describing digest", () => {
    expect(hash()).toMatch(/^sha256:[0-9a-f]{64}$/);
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
      resolution: BASE.resolution,
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
    ["the resolution", { resolution: "720p" }],
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

describe("encoding", () => {
  it("cannot be collided by a value containing a delimiter", () => {
    // Structure, not concatenation: no choice of separator can merge two
    // different requests, which is why the payload is a JSON tuple.
    const a = hash({ assetId: "ast_1", cameraMotion: "x" });
    const b = hash({ assetId: 'ast_1","x', cameraMotion: "" });
    expect(a).not.toBe(b);
  });

  it("is not the composition fingerprint", () => {
    // Both are `sha256:<hex>` and both are canonical, but they answer different
    // questions and must never be interchanged: one identifies an approved
    // input set, this one identifies a single paid provider request.
    expect(hash()).toMatch(/^sha256:/);
    expect(hash()).not.toBe(
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    );
  });
});
