import type { SubmissionDiagnosticCode } from "../submission/diagnostic-code";
import {
  isBoolean,
  isDiagnosticCodeOrNull,
  isPlainRecord,
} from "../submission/untrusted";

/**
 * What a caller reports about a provider job the platform already knows was
 * accepted.
 *
 * The distinction this whole module exists to keep is between *acceptance* and
 * *completion*. Phase 2G-1 and 2G-2 established whether the provider took the
 * work at all; that question is closed by the time anything here is called, and
 * its answer lives on the `submissionCertainty` axis. This observation is about
 * something else entirely: whether the work the provider admitted to taking then
 * ran to completion.
 *
 * They are separate facts because they cost differently. A provider that refused
 * a submission bills nothing. A provider that accepted a submission and *then*
 * failed to render it has already run a paid GPU job, and the platform owes for
 * it regardless of what came out. Collapsing the two would let an execution
 * failure erase a real charge from the Safety Guard.
 *
 * ```text
 * SUCCEEDED  the provider finished; something exists to fetch
 * FAILED     the provider gave up; it still took the money
 * ```
 *
 * There is no "still running" arm, deliberately: the row already says
 * `PROCESSING`, and re-recording that would be a write that changes nothing
 * while claiming progress. A poll that finds the job unfinished simply does not
 * call.
 *
 * Provider-neutral, exactly as at the submission boundary. No HTTP status, no
 * provider body, no vendor status string, no output URL, no credential, no
 * prompt, no stack trace. Whatever future layer polls, receives a webhook, or
 * takes an operator's determination normalizes its findings into one of these
 * two shapes, and this layer never learns which provider produced them.
 *
 * **This phase contains no way to obtain one of these.** There is no HTTP client
 * in its dependency graph and no polling loop anywhere; the evidence arrives as
 * an argument.
 */
export type ProviderCompletionObservation =
  | {
      readonly kind: "SUCCEEDED";
      /**
       * Nothing else. In particular, no output location.
       *
       * A provider's temporary URL is never persisted and never travels through
       * this contract — the managed storage key is *derived* from
       * application-owned identifiers when the output is verified, so a caller
       * cannot name where the platform's copy lives. See ADR-0038.
       */
    }
  | {
      readonly kind: "FAILED";
      /**
       * Whether a *new* attempt row may be admitted for the same request.
       *
       * It decides `FAILED_RETRYABLE` versus `FAILED_TERMINAL`. It never means
       * this row may be re-POSTed — nothing re-POSTs a row — and it does not
       * itself create a recovery attempt; that is a later phase's decision.
       */
      readonly retryable: boolean;
      /**
       * A closed application-owned classification, or nothing.
       *
       * The Phase 2G-1 vocabulary, unchanged and unexpanded. Recorded in safe
       * transition metadata only: the attempt's own `normalizedErrorCode`
       * belongs to the *submission* observation, and an execution failure is a
       * later, separate fact. Overwriting one with the other would destroy the
       * record of why the attempt reached the provider in the state it did.
       */
      readonly diagnosticCode: SubmissionDiagnosticCode | null;
    };

/**
 * Whether an arbitrary value is a usable completion observation.
 *
 * Takes `unknown`, for the reason Phases 2G-1 and 2G-2 both learned the hard
 * way: the union above is a compile-time promise about a value this layer did
 * not construct. What will arrive is decoded JSON from a poller, a queue
 * payload, or a value someone asserted on the way in.
 *
 * Both arms are matched by name and every field is proved. An unrecognised
 * `kind` returns `false` rather than falling into the failure branch — treating
 * "something I do not recognise" as "the provider failed" would move a paid,
 * accepted attempt to a terminal state on a value nobody wrote a meaning for.
 *
 * Never throws. Malformed evidence is an answer — `OBSERVATION_MALFORMED`, with
 * nothing written — not an exception for a caller to wrap.
 */
export function isWellFormedCompletionObservation(
  value: unknown,
): value is ProviderCompletionObservation {
  if (!isPlainRecord(value)) return false;

  switch (value.kind) {
    case "SUCCEEDED":
      // No required fields, and deliberately no optional ones either: a success
      // arm that could carry an output location is an output location that will
      // eventually be persisted.
      return true;
    case "FAILED":
      // Checked as a boolean, not for truthiness. `retryable: "false"` is
      // truthy, and the difference between believing it and proving it is
      // whether the request may be attempted again at all.
      return isBoolean(value.retryable) && isDiagnosticCodeOrNull(value.diagnosticCode);
    default:
      return false;
  }
}
