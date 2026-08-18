import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { frozenExecutionPromptFrom } from "./execution-input";
import type { SceneGeneration } from "./types";

const NOW = new Date("2026-08-17T00:00:00.000Z");

function generation(overrides: Partial<SceneGeneration> = {}): SceneGeneration {
  return {
    id: "gen_1",
    videoProjectId: "vpr_1",
    sourceStoryboardSceneId: "scn_1",
    assetId: "ast_1",
    sourceAnalysisRevision: 1,
    requestHash: "sha256:aaaa",
    providerName: "fixture-provider",
    providerModelId: "fixture/model-v1",
    requestCompiledPrompt: '{"preservation":["r"]}',
    requestDurationSeconds: 5,
    requestCameraMotion: "SLOW_PAN_LEFT",
    requestAspectRatio: "16:9",
    requestResolution: "1080p",
    requestRenderedPrompt: "Preservation rules:\n- frozen at admission",
    state: "QUEUED",
    providerPredictionId: null,
    submittedAt: null,
    lastPolledAt: null,
    normalizedErrorCode: null,
    normalizedErrorMessage: null,
    outputStorageKey: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function rejection(row: SceneGeneration): AppError {
  try {
    frozenExecutionPromptFrom(row);
  } catch (error) {
    return error as AppError;
  }
  throw new Error("expected a refusal, but a prompt was returned");
}

describe("frozenExecutionPromptFrom", () => {
  it("returns the frozen string byte-for-byte", () => {
    const frozen = "Preservation rules:\n- exactly these bytes\n\nAvoid:\n- people";
    expect(frozenExecutionPromptFrom(generation({ requestRenderedPrompt: frozen }))).toBe(frozen);
  });

  it("does not re-render, normalize, or trim what was frozen", () => {
    // Whitespace and ordering are part of the artifact. Anything that "tidied"
    // it would be a second renderer, which is the whole thing this prevents.
    const odd = "  Camera motion (customer-selected):\n\n\nMove slowly.  ";
    expect(frozenExecutionPromptFrom(generation({ requestRenderedPrompt: odd }))).toBe(odd);
  });

  it("fails closed for a row admitted before the freeze contract", () => {
    // Null means "cannot be submitted", never "render it now with today's code".
    const error = rejection(generation({ requestRenderedPrompt: null }));
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("INTERNAL_ERROR");
  });

  it("fails closed on an empty frozen prompt", () => {
    // An empty provider prompt is a paid call for nothing, and the renderer
    // cannot produce one — so an empty column is corruption, not a valid freeze.
    expect(rejection(generation({ requestRenderedPrompt: "" })).code).toBe("INTERNAL_ERROR");
  });

  it("refuses even when every other snapshot field is present", () => {
    // Reconstructing the request is not the same as knowing what will be sent.
    // A row can satisfy `generationRequestFactsFrom` and still not be executable.
    const row = generation({ requestRenderedPrompt: null });
    expect(row.requestCompiledPrompt).not.toBeNull();
    expect(rejection(row)).toBeInstanceOf(AppError);
  });

  it("leaks nothing about the row it refuses", () => {
    const error = rejection(
      generation({
        requestRenderedPrompt: null,
        id: "gen_SENTINEL_ID",
        requestHash: "sha256:SENTINEL_HASH",
        requestCompiledPrompt: '{"userCustomization":"SENTINEL_CUSTOMIZATION"}',
        providerModelId: "SENTINEL_MODEL",
      }),
    );
    const surface = `${error.message} ${JSON.stringify(error.details ?? {})}`;
    for (const secret of [
      "gen_SENTINEL_ID",
      "SENTINEL_HASH",
      "SENTINEL_CUSTOMIZATION",
      "SENTINEL_MODEL",
    ]) {
      expect(surface).not.toContain(secret);
    }
  });
});
