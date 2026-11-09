import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { REPO_ROOT, e2eEnvironment } from "./environment";

/**
 * The development pipeline, run by the browser test as a person runs it after
 * a start (GS-13c-2; ADR-0108): once, against the web app's own database and
 * shared folder, with the test provider. Nothing runs it by itself; the test
 * starts it at the step where the video is to be made.
 */

const run = promisify(execFile);

/**
 * Runs the pipeline command once, with `providerFolder` (absolute) as the test
 * provider's own folder for its clips, and returns its report. The report
 * holds counts only. Rejects when the command exits other than 0, that is
 * when it stopped or something failed (ADR-0108 Decision 5).
 */
export async function runPipeline(providerFolder: string): Promise<string> {
  await mkdir(providerFolder, { recursive: true });
  const { stdout } = await run("pnpm", ["--filter", "@app/worker", "pipeline", "--provider-folder", providerFolder], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...e2eEnvironment() },
  });
  return stdout;
}
