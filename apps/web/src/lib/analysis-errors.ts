/**
 * Member-facing messages for a photo the review page could not analyze
 * (GS-13b, ADR-0122).
 *
 * A standalone module with **no imports**, as `decision-errors.ts` is: the
 * button that shows these is a Client Component, and anything it imports is
 * bundled for the browser.
 */

export const ANALYSIS_ERRORS = {
  signIn: "Your session has ended. Sign in again to analyze photos.",
  permission: "Your role cannot analyze photos.",
  reload: "This photo is no longer available here. Reload the page.",
  generic: "The photo could not be analyzed. Try again.",
} as const;

/**
 * Turn a failed analysis request into one sentence, as `mapDecisionError`
 * does: transport outcomes by status, and a `422`'s own message, written for a
 * person, shown as it is.
 *
 * @param status HTTP status, or null when the request never produced one.
 * @param message `error.message` from the envelope, or null when absent or unparseable.
 */
export function mapAnalysisError(status: number | null, message: string | null): string {
  if (status === 401) return ANALYSIS_ERRORS.signIn;
  if (status === 403) return ANALYSIS_ERRORS.permission;
  if (status === 404) return ANALYSIS_ERRORS.reload;
  if (status === 422 && message) return message;
  return ANALYSIS_ERRORS.generic;
}

/** The envelope's `error.message`, or null when the body is missing or not JSON. */
export async function envelopeMessage(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const message = (body as { error?: { message?: unknown } }).error?.message;
    return typeof message === "string" && message.length > 0 ? message : null;
  } catch {
    return null;
  }
}
