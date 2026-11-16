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
