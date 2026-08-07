/**
 * Reviewer-facing messages for a failed correction request.
 *
 * A standalone module with **no imports**, for the reason `decision-errors.ts`
 * has none: the correction panel is a Client Component, and anything it imports
 * is bundled for the browser. Reaching for the domain's room vocabulary or
 * `effectiveRoomType` from here would drag `@app/domain` — and the server-only
 * code behind it — into client code, which the production build refuses.
 */

export const CORRECTION_ERRORS = {
  signIn: "Your session has ended. Sign in again to save this correction.",
  permission: "Your role cannot correct photo analyses.",
  reload: "This photo is no longer available here. Reload the page.",
  generic: "The correction could not be saved. Try again.",
} as const;

/**
 * Turn a failed correction request into one reviewer-facing sentence.
 *
 * Transport-level outcomes are decided by status. A `422` renders the API's own
 * message, which is already written for a human — and **is not parsed**. The
 * refusals behind a `422` (unknown room, an order priority that is not a whole
 * number above zero, an empty correction, a revision that has already been
 * decided) share one code today, so telling them apart would mean matching
 * message text and turning a display string into an implicit API contract.
 *
 * Anything unexpected becomes the generic message rather than surfacing raw
 * server detail to the reviewer.
 *
 * @param status HTTP status, or null when the request never produced one.
 * @param message `error.message` from the envelope, or null when absent or unparseable.
 */
export function mapCorrectionError(status: number | null, message: string | null): string {
  if (status === 401) return CORRECTION_ERRORS.signIn;
  if (status === 403) return CORRECTION_ERRORS.permission;
  if (status === 404) return CORRECTION_ERRORS.reload;
  if (status === 422 && message) return message;
  return CORRECTION_ERRORS.generic;
}
