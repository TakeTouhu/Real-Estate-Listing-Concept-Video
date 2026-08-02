/**
 * Reviewer-facing messages for a failed decision request.
 *
 * Deliberately a standalone module with **no imports**: the review panel is a
 * Client Component, and anything it imports is bundled for the browser. Living
 * in `review-view.ts` would have dragged `@app/domain` — and the server-only
 * code behind it — into client code, which the production build refuses.
 */

export const DECISION_ERRORS = {
  signIn: "Your session has ended. Sign in again to record this decision.",
  permission: "Your role cannot approve or reject photos.",
  reload: "This photo is no longer available here. Reload the page.",
  generic: "The decision could not be recorded. Try again.",
} as const;

/**
 * Turn a failed decision request into one reviewer-facing sentence.
 *
 * Transport-level outcomes are decided by status. A `422` renders the API's own
 * message, which is already written for a human — and **is not parsed**. The
 * refusals behind a `422` (duplicate conflict, already reviewed, blocking
 * finding, missing primary, blank reason) all share one code today, so telling
 * them apart would mean matching message text and turning a human-readable
 * string into an implicit API contract. If the UI ever needs to distinguish
 * them, the API must expose a machine-readable reason first
 * (`docs/decisions/TODO.md`).
 *
 * @param status HTTP status, or null when the request never produced one.
 * @param message `error.message` from the envelope, or null when absent or unparseable.
 */
export function mapDecisionError(status: number | null, message: string | null): string {
  if (status === 401) return DECISION_ERRORS.signIn;
  if (status === 403) return DECISION_ERRORS.permission;
  if (status === 404) return DECISION_ERRORS.reload;
  if (status === 422 && message) return message;
  return DECISION_ERRORS.generic;
}
