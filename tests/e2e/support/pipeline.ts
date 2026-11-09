import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { E2E_PROVIDER_DIR, REPO_ROOT, e2eEnvironment } from "./environment";

/**
 * The development pipeline, run by the browser test as a person runs it after
 * a start (GS-13c-2, ADR-0124; ADR-0108): once, against the web app's own
 * database and shared folder, with the test provider and its kept folder.
 * Nothing runs it by itself; the test starts it at the step where the video
 * is to be made.
 */

/** Longer than a run of a few videos takes, and well inside a test's five minutes. */
export const PIPELINE_TIMEOUT_MS = 3 * 60_000;

/**
 * Runs the pipeline command once. Rejects unless it exits 0, that is unless
 * it ended with nothing more to do now and no step reported a failure
 * (ADR-0108 Decision 1), with its exit status and what it printed: its
 * counts and why it stopped (Decision 7), and pnpm's own lines. The
 * environment is passed to it, never printed.
 *
 * A run that outlasts `timeoutMs` is stopped with everything it started, as
 * one process group, so none of it writes to the database after the test has
 * failed.
 */
export async function runPipeline(timeoutMs: number = PIPELINE_TIMEOUT_MS): Promise<void> {
  await mkdir(E2E_PROVIDER_DIR, { recursive: true });
  const child = spawn("pnpm", ["--filter", "@app/worker", "pipeline", "--provider-folder", E2E_PROVIDER_DIR], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...e2eEnvironment() },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  }, timeoutMs);
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  }).finally(() => clearTimeout(timer));
  if (timedOut) throw new Error(`The pipeline did not end within ${timeoutMs} ms:\n${output}`);
  if (status !== 0) throw new Error(`The pipeline exited ${String(status)}:\n${output}`);
}
