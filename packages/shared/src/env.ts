import { z } from "zod";

/**
 * Server-side environment schema. This module must only ever be imported by
 * server-side code (route handlers, workers). Secrets defined here must never
 * be bundled into client code or exposed to the browser.
 */
const booleanish = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

/**
 * The single authoritative id of the configured WaveSpeedAI video model.
 *
 * It lives here, beside the environment schema, because that is the one place
 * both sides of the boundary can reach: `@app/video-providers` depends on
 * `@app/shared`, not the reverse, so a constant in the adapter package could
 * not supply this schema's default. Previously the id was a bare literal here
 * *and* an unused `WaveSpeedConfig.modelId` field, which let the capability
 * descriptor and the configured default drift apart silently (ADR-0019).
 *
 * This is the **default model for new admissions only**. It is emphatically not
 * the model an existing generation executes against: a persisted
 * `providerModelId` is frozen at admission and stays authoritative, so changing
 * this constant can never retarget work already admitted.
 */
export const WAVESPEED_OPEN_VIDEO_MODEL_ID = "wavespeed-ai/open-video/image-to-video";

export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    // PostgreSQL connection string for Prisma (Phase 1). Optional at build/test
    // time; required at runtime for database-backed features.
    DATABASE_URL: z.string().url().optional(),

    // Session signing secret for the web session cookie.
    SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),
    HEALTHCHECK_API_TOKEN: z
      .string()
      .min(16, "HEALTHCHECK_API_TOKEN must be at least 16 characters"),
    SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    // Session lifetime for authenticated user sessions (Phase 1).
    USER_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604800),

    // HMAC secret for short-lived, single-purpose storage URLs (Phase 2).
    STORAGE_SIGNING_SECRET: z
      .string()
      .min(16, "STORAGE_SIGNING_SECRET must be at least 16 characters"),

    // Image-analysis provider selection. Phase 3 ships the deterministic
    // offline adapter only; no real vision vendor is integrated (ADR-0009).
    ANALYSIS_PROVIDER: z.enum(["deterministic"]).default("deterministic"),

    // Video provider selection. Phase 0 defaults to the fake adapter and must
    // never call the real WaveSpeedAI API.
    VIDEO_PROVIDER: z.enum(["fake", "wavespeed"]).default("fake"),

    // WaveSpeedAI configuration (server-side only; optional while provider=fake).
    WAVESPEED_API_KEY: z.string().min(1).optional(),
    WAVESPEED_API_BASE_URL: z.string().url().default("https://api.wavespeed.ai/api/v3"),
    WAVESPEED_VIDEO_MODEL_ID: z.string().min(1).default(WAVESPEED_OPEN_VIDEO_MODEL_ID),
    WAVESPEED_WEBHOOK_SECRET: z.string().min(1).optional(),
    WAVESPEED_POLL_INITIAL_MS: z.coerce.number().int().positive().default(2000),
    WAVESPEED_POLL_MAX_MS: z.coerce.number().int().positive().default(15000),
    WAVESPEED_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),

    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    LOG_PRETTY: booleanish.default("false"),
  })
  .superRefine((env, ctx) => {
    if (env.VIDEO_PROVIDER === "wavespeed" && !env.WAVESPEED_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WAVESPEED_API_KEY"],
        message: "WAVESPEED_API_KEY is required when VIDEO_PROVIDER=wavespeed",
      });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

/**
 * Parse and validate server environment. Throws a readable error listing all
 * invalid/missing variables. The parsed result is cached per process.
 */
export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  if (cached) return cached;
  const parsed = serverEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid server environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: clear the cached environment so it can be re-parsed. */
export function resetServerEnvCache(): void {
  cached = undefined;
}
