/** The value of `NEXT_PHASE` while `next build` runs: Next.js's `PHASE_PRODUCTION_BUILD` (`next/constants`). */
const BUILD_PHASE = "phase-production-build";

/**
 * Run once as the web app's server starts. A production start whose adapters
 * or settings cannot serve production ends here, rather than at the first
 * request that needs them (RD-2a, ADR-0151).
 *
 * Only a server is checked: not the edge runtime, and not a build, which
 * serves nothing and is given no production settings.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === BUILD_PHASE) return;
  const { checkWebStart } = await import("./lib/startup");
  checkWebStart();
}
