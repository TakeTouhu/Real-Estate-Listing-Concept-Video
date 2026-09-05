import { AppError } from "@app/shared";

/**
 * What may be written into a transition event's metadata, enforced rather than
 * documented.
 *
 * Machine transition history is the most widely read table in an incident: it
 * is dumped into tickets, pasted into chat, and exported to whoever is
 * debugging. That makes it exactly the wrong place for a customer's prompt or a
 * provider's raw error body — and "we agreed not to put those there" is not a
 * control, because the value that leaks is always the one someone added in a
 * hurry.
 *
 * So metadata is an **allowlist**. A key that is not named here does not reach
 * the database, whatever it contains.
 */

/**
 * Keys a transition event may carry.
 *
 * Every one is an opaque identifier, a closed vocabulary value or a number.
 * None of them is customer-authored text, and none of them is provider-authored
 * text either.
 */
export const ALLOWED_TRANSITION_METADATA_KEYS: readonly string[] = [
  "attemptId",
  "attemptKind",
  "attemptOrdinal",
  "billingCycleKey",
  "correlationId",
  "generationJobId",
  "generationSceneId",
  "highQualityUnits",
  "pricingSnapshotId",
  "providerName",
  "providerModelKey",
  "qualityTier",
  "reasonCode",
  "reasonSource",
  "reconciliationDeadlineAt",
  "requestKind",
  "requestOrdinal",
  "sceneGenerationRequestId",
  "stateVersion",
  "totalVideoUnits",
];

/**
 * Keys that must never appear, named explicitly.
 *
 * Redundant against the allowlist — nothing outside it gets through — and kept
 * anyway, because a future contributor widening the allowlist will read this
 * list and see what the widening must not include. The allowlist says what is
 * permitted; this says what the permission exists to keep out.
 */
export const FORBIDDEN_TRANSITION_METADATA_KEYS: readonly string[] = [
  "apiKey",
  "authorization",
  "compiledPrompt",
  "credentials",
  "negativePrompt",
  "outputUrl",
  "prompt",
  "providerOutputUrl",
  "providerRequest",
  "providerResponse",
  "rawErrorBody",
  "renderedPrompt",
  "requestCompiledPrompt",
  "requestRenderedPrompt",
  "secret",
  "signedUrl",
];

/** A metadata value that is safe by type: no free-form object graphs. */
export type SafeMetadataValue = string | number | boolean | null;

export type SafeTransitionMetadata = Readonly<Record<string, SafeMetadataValue>>;

function isSafeValue(value: unknown): value is SafeMetadataValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Keep only what is allowed, and refuse outright when something forbidden was
 * offered.
 *
 * The asymmetry is deliberate. An *unknown* key is probably a caller being
 * imprecise, and dropping it silently is proportionate. A *forbidden* key is a
 * caller about to leak a prompt or a credential, and silently dropping that
 * would hide a bug that needs fixing at its source — so it throws, loudly,
 * before anything is written.
 *
 * `INTERNAL_ERROR` rather than a validation failure: no customer input reaches
 * this function, so a forbidden key is always a programming defect.
 */
export function sanitizeTransitionMetadata(
  metadata: Readonly<Record<string, unknown>>,
): SafeTransitionMetadata {
  const offending = Object.keys(metadata).filter((key) =>
    FORBIDDEN_TRANSITION_METADATA_KEYS.includes(key),
  );
  if (offending.length > 0) {
    // The offending *keys* are named; their values never are. Echoing a value
    // here would put the leak into the exception that reports the leak.
    throw new AppError(
      "INTERNAL_ERROR",
      "Transition metadata contained forbidden keys",
      { details: { keys: offending.slice().sort() } },
    );
  }

  const safe: Record<string, SafeMetadataValue> = {};
  for (const key of Object.keys(metadata)) {
    if (!ALLOWED_TRANSITION_METADATA_KEYS.includes(key)) continue;
    const value = metadata[key];
    if (isSafeValue(value)) safe[key] = value;
  }
  return Object.freeze(safe);
}
