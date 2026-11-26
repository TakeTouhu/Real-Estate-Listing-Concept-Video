import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { mailpitApiPort } from "../../email/smtp";
import { emulatorEndpoint } from "../../storage/emulator";

/**
 * The runner's side of the production-mode job (ADR-0178): the app's address
 * behind the TLS front, and what the job's settings step wrote to
 * `runner.env` for the operator command and the reads of Mailpit and the
 * emulator, all on this machine. None is printed; one missing fails first.
 * Each value the browser uses is listed in the job's own private folder, so
 * the job can check the server's log for it.
 */
export const APP_BASE_URL = "https://app.rd11.test:8443";

export interface ProductionRun {
  readonly databaseUrl: string;
  readonly bucket: string;
  readonly storageEndpoint: string;
  readonly mailpitApiPort: number;
  /** `browser-values` in the job's folder, which only the runner's user reads. */
  readonly valuesFile: string;
}

export function productionRun(source: NodeJS.ProcessEnv = process.env): ProductionRun {
  const { DATABASE_URL: databaseUrl, BUCKET: bucket, RUNNER_TEMP: folder } = source;
  if (databaseUrl === undefined || bucket === undefined || folder === undefined) {
    throw new Error("Run in the production-mode job with runner.env: DATABASE_URL, BUCKET or RUNNER_TEMP is unset");
  }
  // The database the job publishes on loopback; the address is checked, never printed.
  if (new URL(databaseUrl).hostname !== "127.0.0.1") throw new Error("DATABASE_URL must name 127.0.0.1");
  const valuesFile = join(folder, "rd11", "browser-values");
  return { databaseUrl, bucket, storageEndpoint: emulatorEndpoint(), mailpitApiPort: mailpitApiPort(), valuesFile };
}

/** Lists a value the browser uses, one per line and never printed, for the job's check of the server's log. */
export function listValue(run: ProductionRun, value: string | null | undefined): void {
  if (value) appendFileSync(run.valuesFile, `${value}\n`, { mode: 0o600 });
}

/** An object's bytes, read straight from the emulator's http port. */
export async function emulatorBytes(run: ProductionRun, name: string): Promise<Buffer> {
  const path = `/storage/v1/b/${run.bucket}/o/${encodeURIComponent(name)}?alt=media`;
  const response = await fetch(`${run.storageEndpoint}${path}`);
  if (response.status !== 200) throw new Error(`The emulator did not read an object (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}
