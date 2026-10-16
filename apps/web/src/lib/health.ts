import type { ServerEnv } from "@app/shared";
import {
  createVideoProvider,
  type ProviderGenerationInput,
  type VideoGenerationProvider,
} from "@app/video-providers";
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

export function buildLiveness(now: () => Date = () => new Date()): Liveness {
  return { status: "ok", service: SERVICE_NAME, version: SERVICE_VERSION, time: now().toISOString() };
}

/**
 * Pure readiness computation. Runs an offline provider self-check (a cost
 * estimate — no network) to confirm the adapter boundary is wired correctly,
 * and checks that MFA is configured.
 */
export async function computeReadiness(
  env: ServerEnv,
  provider: VideoGenerationProvider,
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

/** Wire the real configured environment and provider for the readiness check. */
export async function buildReadiness(): Promise<Readiness> {
  const env = getServerEnv();
  const provider = createVideoProvider(env);
  return computeReadiness(env, provider);
}
