import { isSubmissionDiagnosticCode, type SubmissionDiagnosticCode } from "./diagnostic-code";

/**
 * Predicates for values that arrive from outside the type system.
 *
 * A `ProviderSubmissionObservation` or a `ReconciliationResolutionObservation`
 * is a compile-time promise, and a promise is all it is. The values that will
 * actually reach these boundaries come from decoded JSON, a queue payload, an
 * operator's manual determination, a cast written by someone in a hurry, or a
 * provider adapter written after this code — and none of those are checked by
 * `tsc`.
 *
 * So the validators take `unknown` and prove the shape rather than assuming it.
 * The failure they exist to prevent is not a crash: it is
 * `{ retryable: "false" }` being truthy, landing a rejection in
 * `FAILED_RETRYABLE`, and handing a customer's reserved unit back on the
 * strength of a string.
 *
 * These helpers live in the submission module because that is where the closed
 * diagnostic catalog lives, and both phases share it deliberately — two
 * definitions of "a valid diagnostic field" would drift.
 */

/**
 * A non-null, non-array object.
 *
 * Arrays are excluded on purpose: `[]` is an object, indexes into cleanly, and
 * would otherwise reach the discriminant check as a value with no `kind`.
 *
 * Total, because this is the first question every boundary validator asks of
 * a value it did not build, and it is asked *before* the validator's own guard
 * opens. `typeof` and the `null` comparison cannot throw, but `Array.isArray`
 * can: a revoked `Proxy` still answers `"object"` to `typeof` and then throws a
 * `TypeError` from the `IsArray` operation. Left unguarded, that exception would
 * escape from every parser and predicate built on this helper — ahead of the
 * `try` each of them wraps around its property reads — and replace the closed
 * malformed result with a raw runtime error. So the one question that can throw
 * is answered under a guard here, once, and a value that cannot even be asked
 * whether it is an array is not a record. The thrown value is not inspected,
 * kept or reported: nothing about it is the answer.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * Exactly these own properties, no more and no fewer.
 *
 * The closed contracts at these boundaries say what a value *is*, and a value
 * carrying `providerOutputUrl` alongside a valid `kind` is not one of them —
 * it is a different value that happens to contain one. Accepting it and
 * ignoring the extra makes the runtime trust boundary wider than the documented
 * contract, and every subsequent spread, log line or serialization inherits the
 * wider one. So an unknown key makes the value malformed rather than being
 * dropped: refusing it fails at the sender, which is where the bug is.
 *
 * `getOwnPropertyNames` rather than `Object.keys`, so a non-enumerable
 * smuggled field is caught too. Own properties only, so an inherited
 * `Object.prototype` method is not mistaken for a smuggled field — and, in the
 * other direction, a discriminant that exists only on a prototype does not
 * count as present.
 *
 * Every field in every contract these guard is required, so "exactly these" is
 * the whole rule; there is no optional-key case to get wrong.
 */
export function hasExactlyOwnKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const own = Object.getOwnPropertyNames(value);
  return own.length === allowed.length && own.every((key) => allowed.includes(key));
}

/**
 * A string with something in it.
 *
 * Blank is worse than missing: it satisfies every "is it present" check while
 * naming nothing anyone could be asked about.
 */
export function isNonBlankString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Exactly `true` or `false` — not truthy, not `"false"`, not `1`. */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Absent-by-`null`, or a member of the closed catalog.
 *
 * Membership, never a shape test. `SECRET_TOKEN_ABC123` is spelled like a code
 * and is still not one, and `undefined` is not `null` — a field the sender
 * simply omitted has not been stated to be absent.
 */
export function isDiagnosticCodeOrNull(value: unknown): value is SubmissionDiagnosticCode | null {
  return value === null || isSubmissionDiagnosticCode(value);
}
