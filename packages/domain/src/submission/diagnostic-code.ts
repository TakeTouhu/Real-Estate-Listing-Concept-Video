/**
 * A submission diagnostic code that is safe to persist, by construction.
 *
 * The field it guards, `normalizedErrorCode`, is read far more widely than the
 * row it lives on: it is dumped into tickets, pasted into chat, and exported to
 * whoever is debugging. Accepting a bare `string` there re-opened the channel
 * ADR-0031 closed — a caller could have written a signed URL, an `Authorization`
 * header, a customer's prompt or a raw provider body into it, and every one of
 * those has been observed in provider error text in the wild.
 *
 * The rule ADR-0031 settled is that external input may influence only *which*
 * closed classification the application picks; it may never supply the text. A
 * fully closed enum would be the strictest reading, but the vocabulary of
 * submission diagnostics is still being discovered across adapters, and freezing
 * it now would push adapters toward reusing an ill-fitting member rather than
 * naming what happened. So the boundary here is a **shape** narrow enough that no
 * secret, URL or sentence can fit through it:
 *
 * ```text
 * SCREAMING_SNAKE_CASE, ASCII only
 * starts with an uppercase letter
 * at most 48 characters
 * ```
 *
 * A signed URL has `:` and `/`. A bearer token has a space and lowercase. A
 * prompt has spaces. A stack trace has newlines. A raw provider body has
 * punctuation. None of them survive, and none of them can be smuggled through by
 * being long, because length is bounded too.
 *
 * This is a narrowing of what may be *written down*, not an assertion that the
 * value is meaningful. An adapter that cannot name a failure in this vocabulary
 * passes `null`, which is always allowed and always honest.
 */

/** Codes are short application identifiers, never text. */
export const MAX_SUBMISSION_DIAGNOSTIC_CODE_LENGTH = 48;

/**
 * Anchored, and deliberately without `\s` or `.` anywhere in it.
 *
 * `[A-Z]` first so a code can never be empty, start with an underscore, or be a
 * bare number that reads as an HTTP status — which would invite adapters to
 * write `429` and call it a classification.
 */
const SUBMISSION_DIAGNOSTIC_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * A code the application owns, validated at the boundary.
 *
 * Branded so a bare `string` cannot be assigned where one of these is required:
 * the only way to obtain the type is to pass through the validator, which is the
 * whole point of having it.
 */
export type SubmissionDiagnosticCode = string & {
  readonly __brand: "SubmissionDiagnosticCode";
};

/** Whether this value may be persisted as a diagnostic code. */
export function isSubmissionDiagnosticCode(
  value: unknown,
): value is SubmissionDiagnosticCode {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_SUBMISSION_DIAGNOSTIC_CODE_LENGTH) {
    return false;
  }
  return SUBMISSION_DIAGNOSTIC_CODE_PATTERN.test(value);
}

/**
 * Narrow a caller-supplied value, or refuse.
 *
 * `null` in, `null` out: an absent diagnosis is always acceptable. Anything else
 * that is not a valid code returns `null` *as a refusal signal* only through
 * `parseSubmissionDiagnosticCode`'s result type — this function is the total
 * predicate-backed narrowing used where the caller has already validated.
 */
export type SubmissionDiagnosticCodeResult =
  | { readonly ok: true; readonly code: SubmissionDiagnosticCode | null }
  | { readonly ok: false };

/**
 * The one entry point callers use.
 *
 * Distinguishes "no diagnosis offered" (`ok`, `code: null`) from "a diagnosis was
 * offered and it is not something we are willing to write down" (`!ok`). Those
 * must not collapse into one answer: silently dropping a malformed code would
 * persist an outcome while discarding the evidence that a caller tried to put a
 * secret in the audit trail.
 */
export function parseSubmissionDiagnosticCode(
  value: string | null | undefined,
): SubmissionDiagnosticCodeResult {
  if (value === null || value === undefined) return { ok: true, code: null };
  if (!isSubmissionDiagnosticCode(value)) return { ok: false };
  return { ok: true, code: value };
}
