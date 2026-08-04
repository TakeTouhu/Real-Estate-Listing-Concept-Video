/**
 * Customer-facing messages for a failed video-project request.
 *
 * Deliberately a standalone module with **no imports**: the create panel is a
 * Client Component, and anything it imports is bundled for the browser. Putting
 * these next to the project DTOs in `storyboard.ts` would drag `@app/domain`
 * and `@app/database` into client code, which the production build refuses —
 * the defect Phase 3B-3b hit and `decision-errors.ts` exists to avoid.
 */

export const PROJECT_ERRORS = {
  signIn: "Your session has ended. Sign in again to create this project.",
  permission: "Your role cannot create video projects.",
  reload: "This property is no longer available here. Reload the page.",
  generic: "The project could not be created. Try again.",
} as const;

/**
 * Turn a failed project request into one customer-facing sentence.
 *
 * Transport-level outcomes are decided by status. A `422` renders the API's own
 * message — which is already written for a human — and **is not parsed**. The
 * refusals behind a `422` (blank name, non-positive duration, missing format)
 * share one code today, so telling them apart would mean matching message text
 * and turning a human-readable string into an implicit API contract. If the UI
 * ever needs to distinguish them, the API must expose a machine-readable reason
 * first (`docs/decisions/TODO.md`).
 *
 * @param status HTTP status, or null when the request never produced one.
 * @param message `error.message` from the envelope, or null when absent or unparseable.
 */
export function mapProjectError(status: number | null, message: string | null): string {
  if (status === 401) return PROJECT_ERRORS.signIn;
  if (status === 403) return PROJECT_ERRORS.permission;
  if (status === 404) return PROJECT_ERRORS.reload;
  if (status === 422 && message) return message;
  return PROJECT_ERRORS.generic;
}
