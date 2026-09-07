import { deepFreeze } from "@app/shared";

/**
 * The closed set of things this phase is willing to write down about *why* a
 * submission ended the way it did.
 *
 * The field this guards, `normalizedErrorCode`, is read far more widely than the
 * row it lives on: it is dumped into tickets, pasted into chat, and exported to
 * whoever is debugging. Two earlier attempts at guarding it were both wrong, and
 * the second failure is the interesting one.
 *
 * The first accepted a bare `string`, which was plainly a raw-text channel.
 *
 * The second narrowed the *syntax* — SCREAMING_SNAKE, bounded length — and that
 * looked like a boundary while not being one. Every one of these satisfies it:
 *
 * ```text
 * SECRET_TOKEN_ABC123
 * APIKEY1234567890
 * ACCESS_KEY_123456789
 * CUSTOMER_PRIVATE_ID_98765
 * ```
 *
 * **Safe syntax is not trusted provenance.** A shape predicate proves how a value
 * is spelled; it can say nothing about where the value came from, and a secret
 * that happens to be spelled in capitals is still a secret. This is the same
 * lesson ADR-0031 §4 recorded when structural validation of `ProviderError` let a
 * hostile object choose both public diagnostic strings outright.
 *
 * So the rule is the one ADR-0031 settled, applied literally: external input may
 * influence **which** application-owned classification is chosen, and may never
 * supply the value. The vocabulary below is that set of classifications. It is
 * small on purpose — an adapter that cannot honestly place a failure in it
 * passes `null`, which is always allowed and always truthful.
 */

/**
 * Every code this phase may persist.
 *
 * Deliberately three, and deliberately not a taxonomy of provider errors. Each
 * member exists because *this phase's own persistence rules* need to distinguish
 * it, not because some vendor emits it:
 *
 * - `TIMEOUT` — the submission was in flight and no answer arrived in time. This
 *   is the canonical route into `SUBMISSION_UNKNOWN`: the provider may hold the
 *   request, may be executing it, may already have billed it.
 * - `CONNECTION_RESET` — the connection died mid-exchange. Distinguished from a
 *   timeout because it says the transport failed rather than that nobody
 *   answered, and an operator triaging a spike wants to know which. It
 *   establishes just as little about what the provider did.
 * - `LOCAL_CONFIGURATION` — the platform could not even attempt the call: a
 *   missing credential, an unroutable base URL, a disabled provider. The only
 *   member that describes *this system* rather than the exchange, and the only
 *   one that is actionable without asking the provider anything.
 *
 * No HTTP status is a member, and no vendor string is. A status is external data
 * about one exchange, not an application classification, and copying `429` in
 * here would smuggle the provider's vocabulary through the boundary that exists
 * to keep it out. Adding a member is a deliberate act with a reason, which is
 * the property a closed set has and a regex does not.
 */
export const SUBMISSION_DIAGNOSTIC_CODES = deepFreeze([
  "TIMEOUT",
  "CONNECTION_RESET",
  "LOCAL_CONFIGURATION",
] as const);

export type SubmissionDiagnosticCode = (typeof SUBMISSION_DIAGNOSTIC_CODES)[number];

/**
 * Membership in the catalog, checked at runtime.
 *
 * The union type stops a bare string being *assigned*, which a caller inside
 * this repository cannot bypass without an explicit cast — and a cast is exactly
 * what a caller in a hurry writes. So the boundary re-checks, and it checks
 * membership rather than shape: `UNKNOWN_CODE_NOT_IN_CATALOG` is well-formed by
 * any syntactic measure and is still refused, because being well-spelled is not
 * evidence of being application-owned.
 */
export function isSubmissionDiagnosticCode(
  value: unknown,
): value is SubmissionDiagnosticCode {
  return (
    typeof value === "string" &&
    (SUBMISSION_DIAGNOSTIC_CODES as readonly string[]).includes(value)
  );
}

export type SubmissionDiagnosticCodeResult =
  | { readonly ok: true; readonly code: SubmissionDiagnosticCode | null }
  | { readonly ok: false };

/**
 * The one entry point callers use.
 *
 * Distinguishes "no diagnosis offered" (`ok`, `code: null`) from "a diagnosis was
 * offered and it is not one this application owns" (`!ok`). Those must not
 * collapse into one answer: silently dropping an unrecognized code would persist
 * the outcome while discarding the evidence that a caller tried to write
 * something of its own choosing into the audit trail.
 */
export function parseSubmissionDiagnosticCode(
  value: string | null | undefined,
): SubmissionDiagnosticCodeResult {
  if (value === null || value === undefined) return { ok: true, code: null };
  if (!isSubmissionDiagnosticCode(value)) return { ok: false };
  return { ok: true, code: value };
}
