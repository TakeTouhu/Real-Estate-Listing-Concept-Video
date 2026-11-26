import type { UncaughtRequestContext } from "./lib/failure-log";

/**
 * Run once as the web app's server starts. A production start whose adapters
 * or settings cannot serve production ends here, rather than at the first
 * request that needs them (RD-2a, ADR-0151).
 *
 * Only the Node.js server is checked. `next dev` builds this file for the edge
 * runtime too, which cannot bundle the check: the import sits inside the test
 * of the runtime, as Next.js documents, so only the Node.js build carries it.
 * `next build` does not run this hook: Next.js skips it in its build phase.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { checkWebStart } = await import("./lib/startup");
    checkWebStart();
  }
}

/**
 * Next.js's `onRequestError`, called for each error no catch took, after its
 * own print: one JSON line, by the method and the route's pattern (ADR-0185).
 * Next.js awaits it for a route handler's error; for a server component's, it
 * calls it without waiting, so the line can follow the answer, which is 500, or
 * 200 for a payload or a page whose shell was already streamed. The request's
 * path, which holds its query, and its headers are never passed on. Only the
 * Node.js server logs; the edge runtime, which runs only the middleware,
 * returns at once, so its build does not carry the logger. The test holds this
 * to Next.js's own type, and the logger to the import inside the runtime test.
 */
export async function onRequestError(
  error: unknown,
  request: Readonly<{ method: string }>,
  context: UncaughtRequestContext,
): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { logUncaughtRequestFailure } = await import("./lib/failure-log");
    logUncaughtRequestFailure(error, request.method, context);
  }
}
