import { describe, expect, it } from "vitest";
import type { PreparedGeneration } from "@app/domain";
import { providerError } from "./errors";
import { FakeVideoProvider, fakePredictionIdFor } from "./fake/fake-provider";
import {
  createPreparedGenerationSender,
  providerGenerationInputFor,
  submissionObservationFor,
} from "./prepared-generation-sender";
import type { VideoGenerationSubmissionProvider } from "./provider";
import type { ProviderErrorKind, ProviderGenerationInput, ProviderSubmissionOutcome } from "./types";

const PREPARED: PreparedGeneration = {
  generationId: "sgen_sender",
  organizationId: "org_sender",
  providerName: "fake",
  providerModelId: "fake/image-to-video",
  sourceImageUrl: "https://storage.example.test/source?sig=secret",
  sourceUrlExpiresAt: new Date("2026-11-10T01:10:00.000Z"),
  sourceIdentity: { storageKey: "org/org_sender/a/ast/normalized.jpg", mimeType: "image/jpeg", sha256: "d".repeat(64) },
  prompt: "Preservation rules:\n- keep the window",
  durationSeconds: 5,
  aspectRatio: "16:9",
  targetOutputResolution: "1080p",
  nativeGenerationResolution: "720p",
  resolutionNormalization: "UPSCALE",
  nativeMeetsTarget: false,
  requestHash: "e".repeat(64),
};

/** A submission adapter that records each request and answers as told. */
function recording(answer: ProviderSubmissionOutcome, name: "fake" | "wavespeed" = "fake") {
  const requests: ProviderGenerationInput[] = [];
  const provider: VideoGenerationSubmissionProvider = {
    name,
    async createGeneration(input) {
      requests.push(input);
      return answer;
    },
    normalizeError: () => providerError({ kind: "UNKNOWN", code: "X", messageSanitized: "x" }),
  };
  return { provider, requests };
}

function failure(kind: ProviderErrorKind, retryable: boolean) {
  return providerError({ kind, code: "TEST_CODE", messageSanitized: "Fixed text", retryable });
}

describe("the provider's request", () => {
  it("is the prepared generation's native request, field by field, and nothing else", () => {
    expect(providerGenerationInputFor(PREPARED)).toEqual({
      modelId: "fake/image-to-video",
      sourceImageUrl: "https://storage.example.test/source?sig=secret",
      prompt: "Preservation rules:\n- keep the window",
      durationSeconds: 5,
      aspectRatio: "16:9",
      nativeGenerationResolution: "720p",
      requestHash: "e".repeat(64),
    });
  });
});

describe("the provider's answer", () => {
  it("carries an acceptance's prediction id and nothing else of its reference", () => {
    const observed = submissionObservationFor({
      kind: "ACCEPTED",
      ref: { provider: "fake", modelId: "m", predictionId: "pred_1", submittedAt: "2026-11-10T01:00:00.000Z" },
    });
    expect(observed).toEqual({ kind: "ACCEPTED", providerPredictionId: "pred_1" });
  });

  it.each([true, false])("keeps a definitive refusal's retryable %s", (retryable) => {
    const error = failure("INVALID_INPUT", retryable);
    const observed = submissionObservationFor({ kind: "DEFINITIVELY_REJECTED", error });
    expect(observed).toEqual({ kind: "DEFINITIVELY_REJECTED", retryable, normalizedErrorCode: null });
  });

  it.each<[ProviderErrorKind, string | null]>([
    ["TIMEOUT", "TIMEOUT"],
    ["NETWORK", null],
    ["RATE_LIMITED", null],
    ["AUTH", null],
    ["PROVIDER", null],
    ["UNKNOWN", null],
  ])("names only a timeout among the errors, %s giving %s", (kind, code) => {
    expect(submissionObservationFor({ kind: "SUBMISSION_UNKNOWN", error: failure(kind, true) })).toEqual({
      kind: "SUBMISSION_UNKNOWN",
      normalizedErrorCode: code,
    });
    expect(submissionObservationFor({ kind: "DEFINITIVELY_REJECTED", error: failure(kind, false) })).toMatchObject({
      normalizedErrorCode: code,
    });
  });
});

describe("the sender", () => {
  it("makes one call with the request and answers with the observation", async () => {
    const { provider, requests } = recording({ kind: "SUBMISSION_UNKNOWN", error: failure("TIMEOUT", true) });
    const sender = createPreparedGenerationSender(provider);
    expect(sender.providerName).toBe("fake");
    expect(await sender.send(PREPARED)).toEqual({ kind: "SUBMISSION_UNKNOWN", normalizedErrorCode: "TIMEOUT" });
    expect(requests).toEqual([providerGenerationInputFor(PREPARED)]);
  });

  it("sends nothing for another provider's attempt, and says it never left", async () => {
    const unknown: ProviderSubmissionOutcome = { kind: "SUBMISSION_UNKNOWN", error: failure("TIMEOUT", true) };
    const { provider, requests } = recording(unknown, "wavespeed");
    const sender = createPreparedGenerationSender(provider);
    expect(sender.providerName).toBe("wavespeed");
    expect(await sender.send(PREPARED)).toEqual({
      kind: "DEFINITIVELY_REJECTED",
      retryable: false,
      normalizedErrorCode: "LOCAL_CONFIGURATION",
    });
    expect(requests).toEqual([]);
  });

  it("lets a provider's throw through, for the runner to record as unknown", async () => {
    const provider: VideoGenerationSubmissionProvider = {
      name: "fake",
      createGeneration: () => Promise.reject(new Error("defect")),
      normalizeError: () => providerError({ kind: "UNKNOWN", code: "X", messageSanitized: "x" }),
    };
    await expect(createPreparedGenerationSender(provider).send(PREPARED)).rejects.toThrow("defect");
  });

  it("over the test provider, answers its acceptance with the prediction id the studio names the clip by", async () => {
    const sender = createPreparedGenerationSender(new FakeVideoProvider());
    expect(await sender.send(PREPARED)).toEqual({
      kind: "ACCEPTED",
      providerPredictionId: fakePredictionIdFor(PREPARED.requestHash),
    });
  });
});
