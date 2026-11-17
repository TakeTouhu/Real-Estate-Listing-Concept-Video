// Types only: the liveness route loads this module, and must load no database,
// storage or provider code with it (ADR-0152 Decision 4). `readiness.ts` wires
// the real ones.
import type { ServerEnv } from "@app/shared";
import type { ProviderGenerationInput, VideoGenerationProvider } from "@app/video-providers";
import type { WebAdapterChoice } from "./adapter-choice";

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

/** The two services readiness asks to answer. */
export type ReadinessProbe = "database" | "storage";

/**
 * What readiness asks of the web app's surroundings (RD-2b, ADR-0152). Each
 * probe resolves when its service answers and throws when it does not;
 * neither writes a row or an object. The database probe throws too when the
 * database answers and the web app's own client cannot connect (ADR-0155).
 */
export interface ReadinessInputs {
  /** The database answers a query, and the web app's own client connects (ADR-0155). */
  readonly database: () => Promise<void>;
  /** The object storage answers whether a key holds an object. It writes none. */
  readonly storage: () => Promise<void>;
  /** The storage adapter the web app chose (ADR-0150), reported beside its answer. */
  readonly storageAdapter: WebAdapterChoice["storage"];
  /** What the start check refuses this start for (ADR-0151), one line each: none when it refuses nothing. */
  readonly startProblems: readonly string[];
  /**
   * Told of a probe that did not answer. What it threw can name a host or a
   * path, so readiness itself reports only that it did not answer.
   */
  readonly failed?: (probe: ReadinessProbe, error: unknown) => void;
}

export function buildLiveness(now: () => Date = () => new Date()): Liveness {
  return { status: "ok", service: SERVICE_NAME, version: SERVICE_VERSION, time: now().toISOString() };
}

/**
 * Whether a probe answers. Never what it threw. Readiness sets no limit of its
 * own: a probe ends when its client answers or gives up (ADR-0152 Decision 2),
 * and each client is to end its own question (ADR-0153, ADR-0155 Decision 3).
 */
async function answers(probe: ReadinessProbe, inputs: ReadinessInputs): Promise<boolean> {
  try {
    await inputs[probe]();
    return true;
  } catch (error) {
    try {
      inputs.failed?.(probe, error);
    } catch {
      // Readiness answers whether or not anyone could be told of the failure.
    }
    return false;
  }
}

/**
 * Pure readiness computation. Runs an offline provider self-check (a cost
 * estimate — no network) to confirm the adapter boundary is wired correctly,
 * checks that MFA is configured, asks the database and the object storage to
 * answer (ADR-0152), and says what the start check refuses this start for
 * (ADR-0154).
 */
export async function computeReadiness(
  env: ServerEnv,
  provider: VideoGenerationProvider,
  inputs: ReadinessInputs,
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

  const [database, storage] = await Promise.all([answers("database", inputs), answers("storage", inputs)]);
  const answer = (did: boolean) => (did ? "answers" : "does not answer");
  checks.push({ name: "database", ok: database, detail: answer(database) });
  checks.push({ name: "storage", ok: storage, detail: `adapter=${inputs.storageAdapter}, ${answer(storage)}` });

  // The start check ends a start it refuses (ADR-0151). One it did not see serves, and is not ready
  // for the same reasons (ADR-0154). The lines name ports, adapters and settings, and no value.
  const refused = inputs.startProblems;
  checks.push({ name: "start", ok: refused.length === 0, detail: refused.join("; ") || "nothing refused" });

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
