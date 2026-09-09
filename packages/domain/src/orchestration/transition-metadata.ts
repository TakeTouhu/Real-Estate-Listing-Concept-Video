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
  /**
   * How the customer's entitlement bookkeeping looked when a provider outcome
   * landed after the paid boundary. A closed vocabulary value — `NONE`,
   * `RESERVATION_MISSING`, `INITIAL_RESERVATION_ALREADY_CONSUMED` and the rest —
   * written so that an anomaly survives the process that noticed it.
   */
  "entitlementAnomaly",
  /**
   * How an uncertain submission ended, recorded with the transition that ended
   * it. `reconciliationResolvedAt` is absent on exhaustion by design — the
   * event's own timestamp is when the platform stopped waiting, and a resolved
   * instant would claim a certainty that was never regained. `retryable` and
   * `diagnosticCode` are a boolean and a closed-vocabulary member; the code is
   * the reconciliation evidence's classification, kept out of the attempt row so
   * it cannot overwrite the original submission diagnostic.
   */
  "reconciliationResolvedAt",
  "retryable",
  /**
   * How many *other* attempts in the same `GenerationJob` were still durably
   * unknown when this conclusion landed.
   *
   * A plain count, and deliberately not a list: sibling identifiers would put
   * unrelated rows into an audit record, and the sanitizer refuses arrays
   * anyway. It exists because a Job-scoped hold that stays suspended produces no
   * reservation transition event — nothing moved — so this is the only durable
   * record of *why* the customer's unit was not handed back yet.
   */
  "remainingPendingUnknownAttempts",
  /**
   * What a verified managed output is, and when the platform proved it.
   *
   * A content digest and a byte count: neither is customer content, a
   * credential, or a location. They let the append-only log say *which* bytes
   * were verified even if the row is later corrupted, which is the whole point
   * of recording an integrity fact twice.
   *
   * `outputStorageKey` is deliberately absent. Where the object lives is
   * answered by the row, and putting a location into the most widely read table
   * in an incident is exactly the broadening this allowlist exists to prevent.
   */
  "outputSha256",
  "outputSizeBytes",
  "outputVerifiedAt",
  "diagnosticCode",
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
  /**
   * The provider-reality axis, recorded with the outcome that established it.
   * A closed vocabulary value — `ACCEPTED`, `DEFINITIVELY_REJECTED`,
   * `SUBMISSION_UNKNOWN` — never provider text.
   */
  "submissionCertainty",
  "totalVideoUnits",

  /**
   * The paid submission authorization record.
   *
   * Every one is a yen integer, a closed-vocabulary value or a version string —
   * no customer or provider text — and together they are the whole financial
   * basis of one decision to cross the provider boundary. They are written with
   * the `QUEUED → SUBMITTING` event so that the conditions under which money was
   * authorized are reconstructable from persistence alone, without the process
   * that made the call still being alive to report them.
   */
  "authorizationPolicyVersion",
  "routingPolicyVersion",
  "safetyGuardState",
  "billingCycleRevenueYen",
  "knownActualCostYen",
  "settledEstimatedCostYen",
  "uncertainCostYen",
  "inFlightCostYen",
  "nextProjectedCostYen",
  "projectedContributionProfitYen",
  "warningFloorYen",
  "hardPauseFloorYen",
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
