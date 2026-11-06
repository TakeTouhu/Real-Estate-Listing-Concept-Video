import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the browser test runs, and with what (GS-13a, ADR-0121).
 *
 * The web app runs under `next dev` with the test provider and a shared
 * folder: the start of a video, and the folder the photos are kept in, exist
 * only outside production (ADR-0085, ADR-0111), and a production build refuses
 * both. Every value here is a throwaway one for a disposable database on this
 * machine; none is a secret, and none is ever production's.
 */

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const E2E_PORT = 3210;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

/** The folder the web app keeps photos and videos in, shared with the commands the test runs. */
export const E2E_SHARED_STORAGE_DIR = join(REPO_ROOT, ".e2e", "shared");

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The database the test writes to: `DATABASE_URL`, which must name a database
 * on this machine, as the development pipeline requires (ADR-0108 Decision 6).
 * Its address is checked and never printed.
 */
export function e2eDatabaseUrl(source: NodeJS.ProcessEnv = process.env): string {
  const value = source.DATABASE_URL;
  if (value === undefined || value.trim() === "") {
    throw new Error("The browser test needs DATABASE_URL: a disposable, migrated PostgreSQL database on this machine");
  }
  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    throw new Error("The browser test's DATABASE_URL is not an address");
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error("The browser test's DATABASE_URL must name a database on this machine");
  }
  return value;
}

/**
 * The environment of the web app and of every command the test runs: one
 * database, one shared folder and one signing secret, so a photo the web app
 * stored is the one a command reads. Refused under `NODE_ENV=production`.
 */
export function e2eEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (source.NODE_ENV === "production") {
    throw new Error("The browser test never runs with NODE_ENV=production");
  }
  return {
    DATABASE_URL: e2eDatabaseUrl(source),
    SESSION_SECRET: "e2e-session-secret-not-a-secret-0000",
    HEALTHCHECK_API_TOKEN: "e2e-healthcheck-token-not-a-secret-0",
    STORAGE_SIGNING_SECRET: "e2e-storage-signing-secret-not-a-secret",
    // 32 bytes as 64 hex characters, as the schema asks.
    MFA_SECRET_KEY: "e2e0".repeat(16),
    VIDEO_PROVIDER: "fake",
    SHARED_STORAGE_DIR: E2E_SHARED_STORAGE_DIR,
    NEXT_TELEMETRY_DISABLED: "1",
    LOG_LEVEL: "warn",
  };
}
