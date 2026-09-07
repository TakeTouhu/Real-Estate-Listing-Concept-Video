import {
  isSubmissionDiagnosticCode,
  type SubmissionDiagnosticCode,
} from "./diagnostic-code";

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
 *
 * **What a caller may not supply:** a timestamp, and a diagnostic value of its
 * own choosing. A caller able to name the acceptance instant could backdate or
 * future-date paid submission history. A caller able to supply the diagnostic
 * text — even text shaped like a code — could put a credential or a customer
 * identifier into the most widely read table in an incident, so it may only
 * *select* from a closed application-owned vocabulary.
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
       *
       * This is the *only* field on this arm. The instant at which acceptance
       * became durable is read from the service's own post-lock clock — see
       * ADR-0036 — because no currently frozen provider submission contract
       * establishes an authoritative provider-side acceptance timestamp, and a
       * caller-supplied one would be an unverified claim about when money
       * started being spent.
       */
      readonly providerPredictionId: string;
    }
  | {
      readonly kind: "DEFINITIVELY_REJECTED";
      /**
       * Whether a *new* attempt may be admitted for the same request.
       *
       * `true` becomes `FAILED_RETRYABLE`, `false` becomes `FAILED_TERMINAL`.
       * Both are definitive rejections — the provider did not take the work and
       * will not bill for it — and the flag says only whether trying again is
       * permitted.
       *
       * Retryable does **not** mean this row may be re-POSTed. Nothing ever
       * re-POSTs a row; a retry is a new attempt row, admitted separately.
       *
       * No adapter in the repository currently reaches this arm for a remote
       * rate limit: WaveSpeed maps 429 to `SUBMISSION_UNKNOWN`, and so does a
       * fal HTTP status with no provider reference, because neither establishes
       * that the provider did not begin billable work. The arm exists for a
       * future contract that can prove non-acceptance, not as a description of
       * what today's adapters do.
       */
      readonly retryable: boolean;
      readonly normalizedErrorCode: SubmissionDiagnosticCode | null;
    }
  | {
      readonly kind: "SUBMISSION_UNKNOWN";
      readonly normalizedErrorCode: SubmissionDiagnosticCode | null;
    };

/** Whether an observation is structurally usable at all. */
export function isWellFormedObservation(
  observation: ProviderSubmissionObservation,
): boolean {
  if (observation.kind === "ACCEPTED") {
    // A blank reference is worse than a missing one: it satisfies every "is it
    // present" check while naming nothing the provider could be asked about.
    return observation.providerPredictionId.trim().length > 0;
  }
  // Defence in depth over the union type. It stops a bare string being
  // *assigned* here, which a caller inside this repository cannot bypass without
  // an explicit cast — but a cast is exactly what a caller in a hurry writes, and
  // the value ends up in an audit table either way. The re-check is membership
  // in the closed catalog, not a shape test: `SECRET_TOKEN_ABC123` is spelled
  // like a code and is still not one.
  return (
    observation.normalizedErrorCode === null ||
    isSubmissionDiagnosticCode(observation.normalizedErrorCode)
  );
}
