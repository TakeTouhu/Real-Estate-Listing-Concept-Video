import { sanitizeTransitionMetadata } from "../orchestration/transition-metadata";
import type { TransitionContext } from "../orchestration/ports";
import {
  decideBeginOutputIngestion,
  decideFinalizeOutputVerification,
  decideProviderCompletion,
} from "./decide";
import type {
  BeginOutputIngestionInput,
  BeginOutputIngestionResult,
  CompletionDeps,
  FinalizeOutputVerificationInput,
  FinalizeOutputVerificationResult,
  ProviderCompletionResult,
  RecordProviderCompletionInput,
} from "./ports";

/**
 * Write down what a provider did with work it had already accepted, and what
 * the platform found when it looked at the result.
 *
 * Three operations, and the boundaries between them are the point:
 *
 * ```text
 * recordProviderCompletion     the provider finished, or gave up
 * beginOutputIngestion         the platform started copying the result
 * finalizeOutputVerification   the platform proved which bytes it now holds
 * ```
 *
 * **Nothing here contacts a provider or object storage.** Evidence and receipts
 * arrive as arguments; the dependency set is a repository and a clock. There is
 * no way to add a transport without editing the port module.
 *
 * **Nothing here touches customer entitlement.** No reservation is read, moved,
 * released or consumed on any path. A provider execution failure is not a reason
 * to hand a unit back — whether the customer's request can still be satisfied is
 * a question about the *request*, decided by a later phase with the whole Job in
 * view — and a verified output is not a delivery.
 */

/** Attempt-side event types. Service-owned; never caller-supplied. */
export const PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE = "PROVIDER_COMPLETION_SUCCEEDED";
export const PROVIDER_COMPLETION_FAILED_EVENT_TYPE = "PROVIDER_COMPLETION_FAILED";
export const OUTPUT_INGESTION_STARTED_EVENT_TYPE = "OUTPUT_INGESTION_STARTED";
export const OUTPUT_VERIFIED_EVENT_TYPE = "OUTPUT_VERIFIED";

/**
 * Attach this phase's facts to the caller's context.
 *
 * Actor, correlation and causation stay as supplied; the event type does not.
 *
 * The metadata carries no storage key. That is a deliberate refusal rather than
 * an oversight: storage keys are not on the transition-metadata allowlist, the
 * database row is authoritative for where the object lives, and broadening the
 * audit surface for convenience is how a location ends up somewhere it can be
 * read by a query nobody scoped.
 */
function withCompletionRecord(
  context: TransitionContext,
  eventType: string,
  facts: Record<string, unknown>,
): TransitionContext {
  return {
    ...context,
    eventType,
    metadata: sanitizeTransitionMetadata({ ...context.metadata, ...facts }),
  };
}

export function createProviderCompletionService(deps: CompletionDeps) {
  return {
    /**
     * Record that an accepted provider job finished, or failed while running.
     *
     * The certainty axis is not written on either path. A provider that accepted
     * work and then failed to render it has still run a paid job; calling that
     * `DEFINITIVELY_REJECTED` would tell the Safety Guard the money came back.
     */
    async recordProviderCompletion(
      input: RecordProviderCompletionInput,
    ): Promise<ProviderCompletionResult> {
      return deps.completion.withCompletingAttempt(
        { organizationId: input.organizationId, attemptId: input.attemptId },
        async (session): Promise<ProviderCompletionResult> => {
          const facts = await session.loadFacts();
          // Missing, cross-tenant and legacy-unorchestrated are one answer. A
          // distinguishable denial would confirm another tenant's row exists.
          if (facts === null) return { kind: "ATTEMPT_NOT_FOUND" };

          const decision = decideProviderCompletion({
            facts: facts.attempt,
            observation: input.observation,
          });

          switch (decision.kind) {
            case "REPLAY":
              return { kind: "REPLAYED", attemptId: facts.attempt.attemptId };
            case "CONFLICT":
              return { kind: "CONFLICTING_COMPLETION", reason: decision.reason };
            case "NOT_PROCESSING":
              return { kind: "ATTEMPT_NOT_PROCESSING", reason: decision.reason };
            case "MALFORMED_OBSERVATION":
              return { kind: "OBSERVATION_MALFORMED" };
            case "APPLY":
              break;
          }

          const succeeded = input.observation.kind === "SUCCEEDED";
          const applied = await session.applyCompletion({
            expectedVersion: facts.attempt.stateVersion,
            write: decision.write,
            context: withCompletionRecord(
              input.context,
              succeeded
                ? PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE
                : PROVIDER_COMPLETION_FAILED_EVENT_TYPE,
              {
                attemptId: facts.attempt.attemptId,
                // Unchanged, and recorded precisely so an auditor can see it did
                // not move when the execution failed.
                submissionCertainty: facts.attempt.submissionCertainty,
                retryable: succeeded ? null : input.observation.retryable,
                // The execution diagnostic, kept out of the attempt row so it
                // cannot overwrite the original submission diagnostic. The two
                // are different facts about different moments.
                diagnosticCode: succeeded ? null : input.observation.diagnosticCode,
              },
            ),
          });
          if (applied.kind === "LOST") return { kind: "LOST_CONCURRENCY" };

          return {
            kind: "APPLIED",
            attemptId: facts.attempt.attemptId,
            stateVersion: applied.stateVersion,
          };
        },
      );
    },

    /**
     * Record that the platform has started copying a finished output.
     *
     * Nothing is downloaded or written to storage here. The state exists so an
     * interrupted copy is *resumable*: a crashed worker leaves the attempt in
     * `OUTPUT_INGESTING`, and a later one finds it there and tries again against
     * the same deterministic key rather than treating a platform-side I/O
     * problem as a provider failure.
     */
    async beginOutputIngestion(
      input: BeginOutputIngestionInput,
    ): Promise<BeginOutputIngestionResult> {
      return deps.completion.withCompletingAttempt(
        { organizationId: input.organizationId, attemptId: input.attemptId },
        async (session): Promise<BeginOutputIngestionResult> => {
          const facts = await session.loadFacts();
          if (facts === null) return { kind: "ATTEMPT_NOT_FOUND" };

          const decision = decideBeginOutputIngestion({ facts: facts.attempt });

          switch (decision.kind) {
            case "ALREADY_INGESTING":
              return { kind: "ALREADY_INGESTING", attemptId: facts.attempt.attemptId };
            case "ALREADY_VERIFIED":
              return { kind: "ALREADY_VERIFIED", attemptId: facts.attempt.attemptId };
            case "NOT_INGESTIBLE":
              return { kind: "NOT_INGESTIBLE", reason: decision.reason };
            case "APPLY":
              break;
          }

          const applied = await session.applyBeginIngestion({
            expectedVersion: facts.attempt.stateVersion,
            context: withCompletionRecord(
              input.context,
              OUTPUT_INGESTION_STARTED_EVENT_TYPE,
              {
                attemptId: facts.attempt.attemptId,
                submissionCertainty: facts.attempt.submissionCertainty,
              },
            ),
          });
          if (applied.kind === "LOST") return { kind: "LOST_CONCURRENCY" };

          return {
            kind: "APPLIED",
            attemptId: facts.attempt.attemptId,
            stateVersion: applied.stateVersion,
          };
        },
      );
    },

    /**
     * Close a managed output against an integrity receipt.
     *
     * The storage key is derived from the organization and attempt, never taken
     * from the caller, and `outputVerifiedAt` comes from one post-lock clock
     * read. Together those mean a caller cannot point a verification record at
     * an object this attempt does not own, nor backdate when the platform proved
     * the bytes.
     *
     * Verified output is immutable. A later receipt describing different bytes
     * is a discrepancy to surface, never a correction to apply.
     */
    async finalizeOutputVerification(
      input: FinalizeOutputVerificationInput,
    ): Promise<FinalizeOutputVerificationResult> {
      return deps.completion.withCompletingAttempt(
        { organizationId: input.organizationId, attemptId: input.attemptId },
        async (session): Promise<FinalizeOutputVerificationResult> => {
          const facts = await session.loadFacts();
          if (facts === null) return { kind: "ATTEMPT_NOT_FOUND" };

          // Read once, after the lock and after the authoritative facts. A
          // verification instant taken before queueing behind the lock would
          // claim the platform proved the bytes at a moment it had not yet
          // looked at the row.
          const now = deps.clock.now();

          const decision = decideFinalizeOutputVerification({
            facts: facts.attempt,
            organizationId: input.organizationId,
            receipt: input.receipt,
            now,
          });

          switch (decision.kind) {
            case "REPLAY":
              return { kind: "REPLAYED", attemptId: facts.attempt.attemptId };
            case "CONFLICTING_OUTPUT":
              return { kind: "CONFLICTING_OUTPUT", reason: decision.reason };
            case "NOT_INGESTING":
              return { kind: "NOT_INGESTING", reason: decision.reason };
            case "MALFORMED_RECEIPT":
              return { kind: "RECEIPT_MALFORMED" };
            case "APPLY":
              break;
          }

          const applied = await session.applyOutputVerification({
            expectedVersion: facts.attempt.stateVersion,
            write: decision.write,
            context: withCompletionRecord(input.context, OUTPUT_VERIFIED_EVENT_TYPE, {
              attemptId: facts.attempt.attemptId,
              submissionCertainty: facts.attempt.submissionCertainty,
              // The integrity facts, minus the location. A digest and a byte
              // count are neither customer content nor a credential, and they
              // are what lets the append-only log prove *which* bytes were
              // verified even if the row is later corrupted.
              outputSha256: decision.write.outputSha256,
              outputSizeBytes: decision.write.outputSizeBytes,
              outputVerifiedAt: decision.write.outputVerifiedAt,
            }),
          });
          if (applied.kind === "LOST") return { kind: "LOST_CONCURRENCY" };

          return {
            kind: "APPLIED",
            attemptId: facts.attempt.attemptId,
            stateVersion: applied.stateVersion,
            outputStorageKey: decision.write.outputStorageKey,
            outputVerifiedAt: decision.write.outputVerifiedAt,
          };
        },
      );
    },
  };
}

export type ProviderCompletionService = ReturnType<typeof createProviderCompletionService>;
