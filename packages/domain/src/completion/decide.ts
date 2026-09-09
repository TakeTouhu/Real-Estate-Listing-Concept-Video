import type { EpochMillis } from "../pricing/units";
import type { GenerationAttemptState, SubmissionCertainty } from "../orchestration/types";
import {
  isWellFormedCompletionObservation,
  type ProviderCompletionObservation,
} from "./observation";
import {
  isWellFormedVerificationReceipt,
  managedGenerationOutputKey,
  type ManagedOutputVerificationReceipt,
  type SafePositiveByteCount,
  type Sha256Digest,
} from "./output";

/**
 * What an accepted, processing attempt's record should say once the provider
 * finishes with it — and what a managed output's record should say once the
 * platform has looked at the bytes.
 *
 * Pure. No database handle, no clock, no provider, no storage. The instant
 * arrives as a value, so every branch is reachable from a plain object.
 *
 * ```text
 * provider finished    → PROVIDER_SUCCEEDED, certainty unchanged
 * provider gave up     → FAILED_RETRYABLE | FAILED_TERMINAL, certainty unchanged
 * copy started         → OUTPUT_INGESTING
 * bytes proven         → OUTPUT_VERIFIED + the four integrity facts
 * ```
 *
 * The recurring negative in all four: **`submissionCertainty` is never
 * written.** It answers "did the provider take this work", which was settled
 * before any of this ran and cannot be revised by what happened afterwards.
 */

/** The attempt row, as much of it as any decision here needs. */
export interface CompletingAttemptFacts {
  readonly attemptId: string;
  readonly orchestrationState: GenerationAttemptState;
  readonly submissionCertainty: SubmissionCertainty;
  readonly stateVersion: number;
  readonly providerPredictionId: string | null;
  readonly providerAcceptedAt: EpochMillis | null;
  readonly outputStorageKey: string | null;
  readonly outputSha256: Sha256Digest | null;
  readonly outputSizeBytes: SafePositiveByteCount | null;
  readonly outputVerifiedAt: EpochMillis | null;
}

/**
 * The three states a provider completion may land on, and no others.
 *
 * Narrower than `GenerationAttemptState` on purpose. The wide type made
 * `CompletionWrite` a general-purpose state-setter: a caller holding a session
 * could construct `{ orchestrationState: "OUTPUT_INGESTING" }` and move a
 * `PROCESSING` attempt straight past `PROVIDER_SUCCEEDED`, skipping the state
 * that says a provider actually finished. A closed type makes that write
 * unspellable rather than merely wrong.
 */
export type ProviderCompletionLandingState =
  | "PROVIDER_SUCCEEDED"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL";

/**
 * The durable shape a provider completion produces.
 *
 * Only the execution state moves, and only onto a landing this phase owns.
 * Certainty, the provider reference and the acceptance instant are absent from
 * this type, which is the permission set: no branch can write what it cannot
 * name.
 */
export interface CompletionWrite {
  readonly orchestrationState: ProviderCompletionLandingState;
}

/** The durable shape a verified managed output produces. */
export interface OutputVerificationWrite {
  readonly orchestrationState: "OUTPUT_VERIFIED";
  readonly outputStorageKey: string;
  readonly outputSha256: Sha256Digest;
  readonly outputSizeBytes: SafePositiveByteCount;
  /** The single post-lock instant. Never caller-supplied. */
  readonly outputVerifiedAt: EpochMillis;
}

export type CompletionConflictReason =
  /** Recorded success, observed failure — or the reverse. */
  | "COMPLETION_OUTCOME_MISMATCH"
  /** Same failure, different terminal state: retryable versus terminal. */
  | "RETRYABLE_MISMATCH";

export type NotProcessingReason =
  /** The attempt is not `PROCESSING`, and not a state a completion replays at. */
  | "ATTEMPT_NOT_PROCESSING"
  /**
   * The attempt is `PROCESSING` but its certainty is not `ACCEPTED`.
   *
   * A completion observation is about work a provider admitted to taking. An
   * attempt that never crossed, or whose crossing is unknown, or which was
   * definitively refused, has no execution to have completed.
   */
  | "PROVIDER_NEVER_ACCEPTED"
  /**
   * `PROCESSING + ACCEPTED` with no provider reference or acceptance instant.
   *
   * Phase 2G-1 and 2G-2 both guarantee they write those together with the
   * certainty. A row missing them is incoherent rather than merely incomplete,
   * and this fails closed instead of guessing a substitute.
   */
  | "ACCEPTANCE_METADATA_MISSING";

export type CompletionDecision =
  | { readonly kind: "APPLY"; readonly write: CompletionWrite }
  | { readonly kind: "REPLAY" }
  | { readonly kind: "CONFLICT"; readonly reason: CompletionConflictReason }
  | { readonly kind: "NOT_PROCESSING"; readonly reason: NotProcessingReason }
  | { readonly kind: "MALFORMED_OBSERVATION" };

export type BeginIngestionDecision =
  | { readonly kind: "APPLY" }
  | { readonly kind: "ALREADY_INGESTING" }
  | { readonly kind: "ALREADY_VERIFIED" }
  | { readonly kind: "NOT_INGESTIBLE"; readonly reason: NotIngestibleReason };

export type NotIngestibleReason =
  /** Not `PROVIDER_SUCCEEDED`: the provider has not finished, or it failed. */
  | "PROVIDER_NOT_SUCCEEDED"
  /** The certainty axis says the provider never accepted this work. */
  | "PROVIDER_NEVER_ACCEPTED";

export type FinalizeOutputDecision =
  | { readonly kind: "APPLY"; readonly write: OutputVerificationWrite }
  | { readonly kind: "REPLAY" }
  | { readonly kind: "CONFLICTING_OUTPUT"; readonly reason: OutputConflictReason }
  | { readonly kind: "NOT_INGESTING"; readonly reason: NotFinalizableReason }
  | { readonly kind: "MALFORMED_RECEIPT" };

export type OutputConflictReason = "SHA256_MISMATCH" | "SIZE_MISMATCH" | "STORAGE_KEY_MISMATCH";

export type NotFinalizableReason =
  /** Not `OUTPUT_INGESTING`, and not already verified. */
  | "ATTEMPT_NOT_INGESTING"
  | "PROVIDER_NEVER_ACCEPTED"
  /** Verified state with one of the four integrity facts missing. */
  | "VERIFIED_OUTPUT_INCOHERENT";

/**
 * States at which an already-applied *success* remains true.
 *
 * A provider that finished has finished; the attempt moving on to ingestion and
 * verification does not un-finish it. Replaying at these states is what stops a
 * duplicate webhook, a re-delivered queue message or a re-run poll from
 * appearing to fail — or worse, from dragging a verified attempt backwards.
 */
const SUCCESS_REPLAY_STATES: readonly GenerationAttemptState[] = [
  "PROVIDER_SUCCEEDED",
  "OUTPUT_INGESTING",
  "OUTPUT_VERIFIED",
];

/** Is this attempt an accepted provider job that is still running? */
function processingPrecondition(facts: CompletingAttemptFacts): NotProcessingReason | null {
  if (facts.submissionCertainty !== "ACCEPTED") return "PROVIDER_NEVER_ACCEPTED";
  if (facts.orchestrationState !== "PROCESSING") return "ATTEMPT_NOT_PROCESSING";
  if (facts.providerPredictionId === null || facts.providerAcceptedAt === null) {
    return "ACCEPTANCE_METADATA_MISSING";
  }
  return null;
}

/**
 * Decide what to do with evidence about a provider job's completion.
 *
 * Check order matters. A malformed observation is refused before the row is
 * inspected, so a caller cannot learn from the answer whether its unusable
 * evidence would have replayed or conflicted. Then success replay, then failure
 * replay, then the precondition — because a replay is a true statement about a
 * row that has legitimately moved past `PROCESSING`, and consulting the
 * precondition first would report every duplicate delivery as a state error.
 */
export function decideProviderCompletion(input: {
  readonly facts: CompletingAttemptFacts;
  readonly observation: ProviderCompletionObservation;
}): CompletionDecision {
  const { facts, observation } = input;

  if (!isWellFormedCompletionObservation(observation)) {
    return { kind: "MALFORMED_OBSERVATION" };
  }

  // Certainty first, and for every branch including the replays: an attempt the
  // provider never accepted has no execution whose completion could be replayed.
  if (facts.submissionCertainty !== "ACCEPTED") {
    return { kind: "NOT_PROCESSING", reason: "PROVIDER_NEVER_ACCEPTED" };
  }

  const recordedSuccess = SUCCESS_REPLAY_STATES.includes(facts.orchestrationState);
  const recordedFailure =
    facts.orchestrationState === "FAILED_RETRYABLE" ||
    facts.orchestrationState === "FAILED_TERMINAL";

  if (observation.kind === "SUCCEEDED") {
    if (recordedSuccess) return { kind: "REPLAY" };
    // A provider that already failed did not also succeed. Overwriting the
    // failure would erase provider reality on the strength of a later message.
    if (recordedFailure) {
      return { kind: "CONFLICT", reason: "COMPLETION_OUTCOME_MISMATCH" };
    }
  } else {
    if (recordedSuccess) {
      return { kind: "CONFLICT", reason: "COMPLETION_OUTCOME_MISMATCH" };
    }
    if (recordedFailure) {
      const expected = observation.retryable ? "FAILED_RETRYABLE" : "FAILED_TERMINAL";
      // Two observers disagreeing about retryability have disagreed about
      // whether the customer's request may be attempted again at all.
      return facts.orchestrationState === expected
        ? { kind: "REPLAY" }
        : { kind: "CONFLICT", reason: "RETRYABLE_MISMATCH" };
    }
  }

  const missing = processingPrecondition(facts);
  if (missing !== null) return { kind: "NOT_PROCESSING", reason: missing };

  return {
    kind: "APPLY",
    write: {
      orchestrationState:
        observation.kind === "SUCCEEDED"
          ? "PROVIDER_SUCCEEDED"
          : observation.retryable
            ? "FAILED_RETRYABLE"
            : "FAILED_TERMINAL",
    },
  };
}

/**
 * Decide whether this attempt may begin copying its output into managed storage.
 *
 * Nothing is downloaded or written here; this records that the copy is under
 * way, so a crashed worker can be told the attempt is resumable rather than
 * lost.
 */
export function decideBeginOutputIngestion(input: {
  readonly facts: CompletingAttemptFacts;
}): BeginIngestionDecision {
  const { facts } = input;

  if (facts.submissionCertainty !== "ACCEPTED") {
    return { kind: "NOT_INGESTIBLE", reason: "PROVIDER_NEVER_ACCEPTED" };
  }
  // Both are successes about the past, not errors: a second worker finding the
  // copy already under way, or already finished, has learned something true.
  if (facts.orchestrationState === "OUTPUT_INGESTING") return { kind: "ALREADY_INGESTING" };
  if (facts.orchestrationState === "OUTPUT_VERIFIED") return { kind: "ALREADY_VERIFIED" };
  if (facts.orchestrationState !== "PROVIDER_SUCCEEDED") {
    // A provider-failed attempt has no output to ingest, and a still-processing
    // one has none yet.
    return { kind: "NOT_INGESTIBLE", reason: "PROVIDER_NOT_SUCCEEDED" };
  }
  return { kind: "APPLY" };
}

/** Does the row already record exactly this verified output? */
function matchesVerifiedOutput(
  facts: CompletingAttemptFacts,
  write: OutputVerificationWrite,
): FinalizeOutputDecision {
  if (
    facts.outputStorageKey === null ||
    facts.outputSha256 === null ||
    facts.outputSizeBytes === null ||
    facts.outputVerifiedAt === null
  ) {
    // Verified with a missing integrity fact. The database CHECK forbids this
    // for orchestrated rows, so reaching it means something wrote around the
    // service — fail closed rather than "completing" the record from a receipt
    // that may describe different bytes.
    return { kind: "NOT_INGESTING", reason: "VERIFIED_OUTPUT_INCOHERENT" };
  }
  if (facts.outputSha256 !== write.outputSha256) {
    return { kind: "CONFLICTING_OUTPUT", reason: "SHA256_MISMATCH" };
  }
  if (facts.outputSizeBytes !== write.outputSizeBytes) {
    return { kind: "CONFLICTING_OUTPUT", reason: "SIZE_MISMATCH" };
  }
  if (facts.outputStorageKey !== write.outputStorageKey) {
    // The key is derived from the attempt, so a mismatch means the stored row
    // points somewhere this attempt would never have chosen.
    return { kind: "CONFLICTING_OUTPUT", reason: "STORAGE_KEY_MISMATCH" };
  }
  // `outputVerifiedAt` is deliberately not compared: it records when *this
  // platform* verified, and requiring a replaying caller's fresh instant to
  // equal the stored one would make every replay after the first millisecond a
  // conflict.
  return { kind: "REPLAY" };
}

/**
 * Decide whether a receipt may close this attempt's managed output.
 *
 * The storage key is derived here rather than accepted, so no caller can point
 * a verification record at an object this attempt does not own.
 */
export function decideFinalizeOutputVerification(input: {
  readonly facts: CompletingAttemptFacts;
  readonly organizationId: string;
  readonly receipt: ManagedOutputVerificationReceipt;
  readonly now: EpochMillis;
}): FinalizeOutputDecision {
  const { facts, organizationId, receipt, now } = input;

  if (!isWellFormedVerificationReceipt(receipt)) {
    return { kind: "MALFORMED_RECEIPT" };
  }

  if (facts.submissionCertainty !== "ACCEPTED") {
    return { kind: "NOT_INGESTING", reason: "PROVIDER_NEVER_ACCEPTED" };
  }

  const write: OutputVerificationWrite = {
    orchestrationState: "OUTPUT_VERIFIED",
    outputStorageKey: managedGenerationOutputKey({
      organizationId,
      attemptId: facts.attemptId,
    }),
    outputSha256: receipt.sha256,
    outputSizeBytes: receipt.sizeBytes,
    outputVerifiedAt: now,
  };

  // Already verified: replay or conflict, never a second application. Verified
  // output metadata is immutable — a later receipt describing different bytes
  // is a discrepancy to surface, not a correction to accept.
  if (facts.orchestrationState === "OUTPUT_VERIFIED") {
    return matchesVerifiedOutput(facts, write);
  }

  if (facts.orchestrationState !== "OUTPUT_INGESTING") {
    return { kind: "NOT_INGESTING", reason: "ATTEMPT_NOT_INGESTING" };
  }

  return { kind: "APPLY", write };
}
