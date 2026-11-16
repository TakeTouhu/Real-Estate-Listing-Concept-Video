import { getPrismaClient } from "@app/database";
import type { ServerEnv } from "@app/shared";
import {
  createVideoProvider,
  type ProviderGenerationInput,
  type VideoGenerationProvider,
} from "@app/video-providers";
import { getWebAdapters } from "./adapters";
import { getServerEnv } from "./env";

export const SERVICE_NAME = "real-estate-virtual-tour-ai-web";
export const SERVICE_VERSION = process.env.npm_package_version ?? "0.0.0";

export interface Liveness {
  readonly status: "ok";
  readonly service: string;
  readonly version: string;
  readonly time: string;
}

export interface ReadinessCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface Readiness {
  readonly status: "ready" | "degraded";
  readonly service: string;
  readonly version: string;
  readonly time: string;
  readonly provider: string;
  readonly checks: readonly ReadinessCheck[];
}

/**
 * What readiness asks of the services the web app depends on (RD-2,
 * ADR-0151). Each resolves when its service answers and throws when it does
 * not; neither changes anything.
 */
export interface ReadinessProbes {
  /** The database answers a query. */
  readonly database: () => Promise<void>;
  /** The object storage answers whether a key holds an object. */
  readonly storage: () => Promise<void>;
  /** The storage adapter the web app chose (ADR-0150), reported beside it. */
  readonly storageAdapter: string;
}

/** A key no one writes, asked about only to see the storage answer. */
export const READINESS_STORAGE_KEY = "readiness/probe";

export function buildLiveness(now: () => Date = () => new Date()): Liveness {
  return { status: "ok", service: SERVICE_NAME, version: SERVICE_VERSION, time: now().toISOString() };
}

/** Whether a probe answers, never what it threw: an error can name a host or a path. */
async function answers(probe: () => Promise<void>): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure readiness computation. Runs an offline provider self-check (a cost
 * estimate — no network) to confirm the adapter boundary is wired correctly,
 * checks that MFA is configured, and asks the database and the object storage
 * to answer (ADR-0151).
 */
export async function computeReadiness(
  env: ServerEnv,
  provider: VideoGenerationProvider,
  probes: ReadinessProbes,
  now: () => Date = () => new Date(),
): Promise<Readiness> {
  const checks: ReadinessCheck[] = [];

  const selfCheckInput: ProviderGenerationInput = {
    modelId: env.WAVESPEED_VIDEO_MODEL_ID,
    sourceImageUrl: "https://internal.placeholder/self-check",
    prompt: "readiness self-check",
    // Inside the configured model's documented 3–20s range. A self-check that
    // describes a request the model would reject is not a check of the wiring.
    durationSeconds: 5,
    aspectRatio: "16:9",
    // A native OpenVideo token, which for this model coincides with a product
    // target. Written as the native field it is, so the self-check keeps
    // describing a request the model would actually accept.
    nativeGenerationResolution: "720p",
    requestHash: "readiness-self-check",
  };

  try {
    await provider.estimateCost(selfCheckInput);
    checks.push({ name: "video-provider-adapter", ok: true, detail: `adapter=${provider.name}` });
  } catch {
    checks.push({ name: "video-provider-adapter", ok: false, detail: `adapter=${provider.name}` });
  }

  // Without the key no one who must use MFA can sign in (ADR-0065 Decision 17).
  // Only whether it is set is reported.
  const mfaKeySet = env.MFA_SECRET_KEY !== undefined;
  checks.push({ name: "mfa", ok: mfaKeySet, detail: mfaKeySet ? "key set" : "MFA_SECRET_KEY not set" });

  const [database, storage] = await Promise.all([answers(probes.database), answers(probes.storage)]);
  checks.push({ name: "database", ok: database, detail: database ? "answers" : "does not answer" });
  const storageDetail = `adapter=${probes.storageAdapter}`;
  checks.push({ name: "storage", ok: storage, detail: `${storageDetail}, ${storage ? "answers" : "does not answer"}` });

  const ok = checks.every((c) => c.ok);
  return {
    status: ok ? "ready" : "degraded",
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    time: now().toISOString(),
    provider: provider.name,
    checks,
  };
}

/** Wire the real configured environment, provider, database and storage for the readiness check. */
export async function buildReadiness(): Promise<Readiness> {
  const env = getServerEnv();
  const provider = createVideoProvider(env);
  const adapters = getWebAdapters();
  return computeReadiness(env, provider, {
    database: async () => {
      await getPrismaClient().$queryRaw`SELECT 1`;
    },
    // Building the adapter is part of the check: a development adapter refuses production.
    storage: async () => {
      await adapters.storage().exists(READINESS_STORAGE_KEY);
    },
    storageAdapter: adapters.choice.storage,
  });
}
