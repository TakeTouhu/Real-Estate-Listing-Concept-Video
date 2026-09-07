import type { EpochMillis } from "../pricing/units";

/**
 * What a caller reports having learned about one submission, normalized.
 *
 * Provider-neutral by construction. There is no HTTP status here, no provider
 * error body, no vendor enum — an adapter translates its own vocabulary into
 * one of these three shapes and this layer never learns which provider it was
 * talking to. That is what lets the persistence rules be written once and
 * exercised without a provider.
 *
 * Three arms, and the set is closed because the question has exactly three
 * answers:
 *
 * ```text
 * ACCEPTED               the provider took it, and named it
 * DEFINITIVELY_REJECTED  the provider refused it, and will not bill for it
 * SUBMISSION_UNKNOWN     nobody can say, and the provider may already be paid
 * ```
 *
 * The third is not a failure mode of the other two — it is the honest answer
 * whenever the platform cannot *prove* which of them happened. A timeout, a
 * dropped connection, a response that cannot be parsed: all of them establish
 * nothing, and all of them belong here rather than being rounded to the
 * convenient answer.
 */
export type ProviderSubmissionObservation =
  | {
      readonly kind: "ACCEPTED";
      /**
       * The provider's own reference for the work it took.
       *
       * Required, and required to be non-empty. An acceptance that cannot name
       * what was accepted has not established acceptance; it is uncertainty,
       * and it belongs on the third arm.
       */
      readonly providerPredictionId: string;
      readonly providerAcceptedAt: EpochMillis;
    }
  | {
      readonly kind: "DEFINITIVELY_REJECTED";
      /**
       * Whether a *new* attempt may be admitted for the same request.
       *
       * `true` becomes `FAILED_RETRYABLE`, `false` becomes `FAILED_TERMINAL`.
       * Both are definitive rejections — the provider did not take the work and
       * will not bill for it — and the flag says only whether trying again is
       * permitted. A rate limit is retryable; a malformed request is not.
       *
       * Retryable does **not** mean this row may be re-POSTed. Nothing ever
       * re-POSTs a row; a retry is a new attempt row, admitted separately.
       */
      readonly retryable: boolean;
      readonly normalizedErrorCode: string | null;
    }
  | {
      readonly kind: "SUBMISSION_UNKNOWN";
      readonly normalizedErrorCode: string | null;
    };

/** Whether an observation is structurally usable at all. */
export function isWellFormedObservation(
  observation: ProviderSubmissionObservation,
): boolean {
  if (observation.kind !== "ACCEPTED") return true;
  // A blank reference is worse than a missing one: it satisfies every "is it
  // present" check while naming nothing the provider could be asked about.
  return observation.providerPredictionId.trim().length > 0;
}
