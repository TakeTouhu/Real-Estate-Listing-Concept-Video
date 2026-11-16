/**
 * Run once as the web app's server starts. A production start whose adapters
 * or settings cannot serve production ends here, rather than at the first
 * request that needs them (RD-2, ADR-0151).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkWebStart } = await import("./lib/startup");
  checkWebStart();
}
