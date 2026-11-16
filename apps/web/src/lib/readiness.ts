import { getPrismaClient } from "@app/database";
import { createLogger, type Logger } from "@app/observability";
import { createVideoProvider } from "@app/video-providers";
import { getWebAdapters } from "./adapters";
import { getServerEnv } from "./env";
import { computeReadiness, type Readiness } from "./health";

/** A key nothing writes, asked about only to see the storage answer. */
export const READINESS_STORAGE_KEY = "readiness/probe";

let logger: Logger | undefined;

/**
 * A short code for why a probe did not answer: the error's own code when it
 * is one plain word, as Prisma's and Node.js's are, and never its message,
 * which can name a host, a user or a path.
 */
export function probeFailureCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "UNEXPECTED";
  const { code, errorCode } = error as { readonly code?: unknown; readonly errorCode?: unknown };
  const named = [code, errorCode].find((value) => typeof value === "string" && /^[A-Z0-9][A-Z0-9_]{0,39}$/.test(value));
  return typeof named === "string" ? named : "UNEXPECTED";
}

/**
 * Readiness of the running web app, from its configured environment, provider,
 * database and storage (RD-2b, ADR-0152). Kept apart from `health.ts`, so the
 * liveness route loads none of them.
 */
export async function buildReadiness(): Promise<Readiness> {
  const env = getServerEnv();
  const adapters = getWebAdapters();
  return computeReadiness(env, createVideoProvider(env), {
    database: async () => {
      const client = getPrismaClient();
      // Prisma gives a first connection that fails a code (`P1000`, `P1001`, `P1003`) only when
      // it is asked to connect, which does nothing once it has.
      await client.$connect();
      await client.$queryRaw`SELECT 1`;
    },
    // Building the adapter is part of the question: one that refuses to be built does not answer.
    storage: async () => {
      await adapters.storage().exists(READINESS_STORAGE_KEY);
    },
    storageAdapter: adapters.choice.storage,
    failed: (probe, error) => {
      logger ??= createLogger({ base: { component: "readiness" } });
      logger.warn("A readiness probe did not answer", { probe, code: probeFailureCode(error) });
    },
  });
}
