import {
  isSubmissionDiagnosticCode,
  type SubmissionDiagnosticCode,
} from "../submission/diagnostic-code";

/**
 * What a caller reports having *finally established* about a submission whose
 * acceptance was unknown.
 *
 * Two arms, not three, and the missing one is the point. Phase 4C-3B-2G-1's
 * observation has a `SUBMISSION_UNKNOWN` arm because "nobody can say" is a
 * conclusion worth writing down the first time. Here it is not: the attempt is
 * *already* recorded as unknown, with a deadline, and re-recording that fact
 * would be a write that changes nothing while pretending progress was made. A
 * reconciliation lookup that still cannot decide simply does not call this
 * service — see ADR-0037 §4.
 *
 * Provider-neutral, exactly as at the submission boundary. No HTTP status, no
 * provider body, no vendor enum, no free text. Whatever future layer polls a
 * provider, reads a webhook, or takes an operator's manual determination
 * normalizes its findings into one of these two shapes, and this layer never
 * learns which provider — or which mechanism — produced them.
 *
 * **This phase contains no way to obtain one of these.** There is no HTTP
 * client in its dependency graph and no polling loop anywhere; the evidence
 * arrives as an argument. Acquiring it belongs to the later polling and
 * output-ingestion phase.
 */
export type ReconciliationResolutionObservation =
  | {
      readonly kind: "ACCEPTED";
      /**
       * The provider's own reference for the work it turned out to have taken.
       *
       * Required and non-blank. This is the *only* thing that may introduce a
       * provider reference onto a reconciling attempt: it is never inferred
       * from the request hash, the attempt id, the provider name, or anything
       * read off a response. A reference that names nothing is uncertainty, and
       * uncertainty is already what the row says.
       */
      readonly providerPredictionId: string;
    }
  | {
      readonly kind: "DEFINITIVELY_REJECTED";
      /**
       * Whether a *new* attempt row may be admitted for the same request.
       *
       * It decides the terminal destination — `FAILED_RETRYABLE` versus
       * `FAILED_TERMINAL` — and, with it, whether the customer's reserved unit
       * is restored for a future recovery attempt or released. Two observers
       * disagreeing about this have disagreed about the customer's remaining
       * entitlement, which is why it is a conflict rather than a detail.
       *
       * It never means this row may be re-POSTed. Nothing re-POSTs a row.
       */
      readonly retryable: boolean;
      /**
       * A closed application-owned classification, or nothing.
       *
       * The Phase 2G-1 vocabulary, unchanged and unexpanded. It is recorded in
       * safe transition metadata only: the attempt's own `normalizedErrorCode`
       * belongs to the *original* submission observation, and overwriting it
       * with a later finding would erase why the attempt became uncertain in
       * the first place.
       */
      readonly diagnosticCode: SubmissionDiagnosticCode | null;
    };

/** Whether a resolution observation is structurally usable at all. */
export function isWellFormedResolutionObservation(
  observation: ReconciliationResolutionObservation,
): boolean {
  if (observation.kind === "ACCEPTED") {
    return observation.providerPredictionId.trim().length > 0;
  }
  // Membership in the closed catalog, re-checked at the boundary because a cast
  // is what a caller in a hurry writes. A value spelled like a code is not one.
  return (
    observation.diagnosticCode === null ||
    isSubmissionDiagnosticCode(observation.diagnosticCode)
  );
}
