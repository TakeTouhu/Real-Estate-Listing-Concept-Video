import type { SubmissionDiagnosticCode } from "../submission/diagnostic-code";
import {
  hasExactlyOwnKeys,
  isBoolean,
  isDiagnosticCodeOrNull,
  isPlainRecord,
} from "../submission/untrusted";
import { TransientProviderOutputLocator } from "./locator";

/**
 * What a status lookup found out about a provider job the platform already knows
 * was accepted.
 *
 * Three arms, and the third's absence from Phase 2H-1 is the reason this type
 * exists at all. `ProviderCompletionObservation` has no "still running" arm,
 * deliberately — recording that would be a write that changes nothing. But a
 * *poller* absolutely needs to say it, because "the provider has not finished"
 * is the most common answer it will ever get and it must be distinguishable from
 * "the provider finished" and from "I could not find out".
 *
 * ```text
 * IN_PROGRESS  the provider is still working; nothing to record
 * SUCCEEDED    the provider finished; a location may or may not be obtainable
 * FAILED       the provider gave up; it still ran a paid job
 * ```
 *
 * This is about provider *execution*, never about submission certainty. By the
 * time anything here is consulted the attempt is already `ACCEPTED`; that
 * question was closed by Phases 2G-1 and 2G-2 and nothing in this phase revises
 * it.
 */
export type ProviderPollObservation =
  | {
      readonly kind: "IN_PROGRESS";
      /**
       * Nothing else. In particular no progress percentage, no ETA and no queue
       * position: none of them is a fact this phase persists, and a field that
       * exists is a field something will eventually try to store.
       */
    }
  | {
      readonly kind: "SUCCEEDED";
      /**
       * Where the output can be fetched from, or `null` when the source could
       * not produce a usable location.
       *
       * Nullable on purpose. A provider can be conclusively finished while the
       * platform cannot currently obtain a download location — an expired URL,
       * a vendor endpoint that returns the status but not the artifact, a
       * response shape the adapter could not read. That is a fact about *output
       * acquisition*, and it must not be allowed to suppress the separate,
       * durable, money-relevant fact that the provider succeeded.
       */
      readonly outputLocator: TransientProviderOutputLocator | null;
    }
  | {
      readonly kind: "FAILED";
      /** Whether a *new* attempt row may be admitted for the same request. */
      readonly retryable: boolean;
      /** The Phase 2G-1 closed catalog, unchanged and unexpanded. */
      readonly diagnosticCode: SubmissionDiagnosticCode | null;
    };

/** The complete own-property set of each arm. Exhaustive, not a minimum. */
export const IN_PROGRESS_POLL_KEYS: readonly string[] = ["kind"];
export const SUCCEEDED_POLL_KEYS: readonly string[] = ["kind", "outputLocator"];
export const FAILED_POLL_KEYS: readonly string[] = ["kind", "retryable", "diagnosticCode"];

/**
 * Whether an arbitrary value is a usable poll observation.
 *
 * Takes `unknown`, because what arrives here is whatever a future adapter
 * returns after reading a vendor's JSON — and the union above is a compile-time
 * promise about a value this layer did not construct.
 *
 * The rule that does the most work is the locator one. `outputLocator` must be
 * `null` or a locator **this process constructed**; a raw string URL is refused.
 * Accepting a string would mean a provider's response text could travel through
 * the orchestrator as an ordinary value — spreadable, loggable, serializable —
 * and every guarantee about locator secrecy would rest on nobody ever doing any
 * of those things by accident. Making the adapter build the opaque type moves
 * that guarantee from a convention to a type.
 *
 * Exact own keys throughout, for the reason Phase 2H-1 settled: a value carrying
 * `providerOutputUrl` next to a valid discriminant is not this contract, it is a
 * provider payload with a discriminant in it. Never throws.
 */
export function isWellFormedPollObservation(value: unknown): value is ProviderPollObservation {
  if (!isPlainRecord(value)) return false;

  switch (value.kind) {
    case "IN_PROGRESS":
      return hasExactlyOwnKeys(value, IN_PROGRESS_POLL_KEYS);
    case "SUCCEEDED":
      return (
        hasExactlyOwnKeys(value, SUCCEEDED_POLL_KEYS) &&
        (value.outputLocator === null ||
          TransientProviderOutputLocator.isLocator(value.outputLocator))
      );
    case "FAILED":
      // `typeof === "boolean"`, not truthiness: `"false"` is truthy, and this
      // flag decides whether the customer's request may be attempted again.
      return (
        hasExactlyOwnKeys(value, FAILED_POLL_KEYS) &&
        isBoolean(value.retryable) &&
        isDiagnosticCodeOrNull(value.diagnosticCode)
      );
    default:
      // An unrecognised discriminant is refused, never swept into FAILED.
      // Treating "I do not recognise this" as "the provider failed" would move a
      // paid, accepted attempt to a terminal state on a value nobody defined.
      return false;
  }
}
