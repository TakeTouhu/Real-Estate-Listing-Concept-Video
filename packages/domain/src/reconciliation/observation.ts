import type { SubmissionDiagnosticCode } from "../submission/diagnostic-code";
import {
  isBoolean,
  isDiagnosticCodeOrNull,
  isNonBlankString,
  isPlainRecord,
} from "../submission/untrusted";

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

/**
 * Whether an arbitrary value is usable resolution evidence.
 *
 * Takes `unknown`, for the same reason Phase 2G-1's validator does: the union
 * above is a compile-time promise about a value this layer did not construct.
 * The producers that will eventually call this — a polling loop, a webhook
 * handler, an operator tool — will hand over decoded JSON or a queue payload,
 * and a type assertion on the way in proves nothing about what arrived.
 *
 * Both arms are matched by name and every field is proved. An unrecognised
 * `kind` is `false` rather than being swept into the rejection branch: treating
 * "something I do not recognise" as "the provider refused it" would resolve an
 * uncertain attempt, move a customer's entitlement, and close a paid submission
 * on the strength of a value nobody wrote a meaning for.
 *
 * Never throws. Malformed evidence is an answer — `OBSERVATION_MALFORMED`, with
 * nothing written — not an exception for a caller to handle.
 */
export function isWellFormedResolutionObservation(
  value: unknown,
): value is ReconciliationResolutionObservation {
  if (!isPlainRecord(value)) return false;

  switch (value.kind) {
    case "ACCEPTED":
      return isNonBlankString(value.providerPredictionId);
    case "DEFINITIVELY_REJECTED":
      // Checked as a boolean, not for truthiness. `retryable: "false"` is
      // truthy, and the difference between believing it and proving it is
      // whether a customer's unit is restored for a retry or released.
      return isBoolean(value.retryable) && isDiagnosticCodeOrNull(value.diagnosticCode);
    default:
      return false;
  }
}
