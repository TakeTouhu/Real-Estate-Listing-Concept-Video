import type {
  PreparedGeneration,
  PreparedGenerationSender,
  ProviderSubmissionObservation,
  SubmissionDiagnosticCode,
} from "@app/domain";
import type { VideoGenerationSubmissionProvider } from "./provider";
import type { ProviderError, ProviderGenerationInput, ProviderSubmissionOutcome } from "./types";

/**
 * The one place a provider's create POST is made for an orchestrated attempt
 * (GS-7c-2b, ADR-0098): the attempt sender's port, over a submission adapter.
 *
 * The request is built from the prepared generation alone, which preparation
 * built from the attempt's frozen snapshot (ADR-0018), so nothing current is
 * read here. The provider's answer is translated into the provider-neutral
 * observation the submission outcome records; the prediction id is the only
 * provider value carried across, and an error contributes only which of the
 * application's own codes, if any, describes it.
 *
 * Dormant: nothing in production constructs it.
 */

/** The provider's request, field by field from the prepared generation. */
export function providerGenerationInputFor(prepared: PreparedGeneration): ProviderGenerationInput {
  return {
    modelId: prepared.providerModelId,
    sourceImageUrl: prepared.sourceImageUrl,
    prompt: prepared.prompt,
    durationSeconds: prepared.durationSeconds,
    aspectRatio: prepared.aspectRatio,
    nativeGenerationResolution: prepared.nativeGenerationResolution,
    requestHash: prepared.requestHash,
  };
}

/** Only a timeout is named: `null` is always truthful, and the set is closed. */
function diagnosticFor(error: ProviderError): SubmissionDiagnosticCode | null {
  return error.kind === "TIMEOUT" ? "TIMEOUT" : null;
}

/** What the provider answered, in the vocabulary the submission outcome records. */
export function submissionObservationFor(outcome: ProviderSubmissionOutcome): ProviderSubmissionObservation {
  switch (outcome.kind) {
    case "ACCEPTED":
      return { kind: "ACCEPTED", providerPredictionId: outcome.ref.predictionId };
    case "DEFINITIVELY_REJECTED":
      return {
        kind: "DEFINITIVELY_REJECTED",
        retryable: outcome.error.retryable,
        normalizedErrorCode: diagnosticFor(outcome.error),
      };
    case "SUBMISSION_UNKNOWN":
      return { kind: "SUBMISSION_UNKNOWN", normalizedErrorCode: diagnosticFor(outcome.error) };
  }
}

/**
 * Not sent: the attempt was admitted for another provider. The runner checks
 * this before the gate; reached here, the request provably never left.
 */
const NOT_THIS_PROVIDER: ProviderSubmissionObservation = Object.freeze({
  kind: "DEFINITIVELY_REJECTED",
  retryable: false,
  normalizedErrorCode: "LOCAL_CONFIGURATION",
});

export function createPreparedGenerationSender(
  provider: VideoGenerationSubmissionProvider,
): PreparedGenerationSender {
  return {
    providerName: provider.name,
    async send(prepared: PreparedGeneration): Promise<ProviderSubmissionObservation> {
      if (prepared.providerName !== provider.name) return NOT_THIS_PROVIDER;
      // One call. The adapter makes at most one POST per call (ADR-0035).
      return submissionObservationFor(await provider.createGeneration(providerGenerationInputFor(prepared)));
    },
  };
}
