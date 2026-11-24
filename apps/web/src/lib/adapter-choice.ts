import type { ServerEnv } from "@app/shared";

/**
 * Which adapter serves each of the web app's ports, chosen in this one place
 * from its environment (RD-1, ADR-0150). A production adapter is one more
 * choice here, one more adapter built in `adapters.ts` and one more entry in
 * what a production start allows (`startup.ts`), with no change to the
 * services, routes or pages that use the port.
 *
 * Kept apart from the adapters, so the production start check reads the choice
 * without loading one (ADR-0151 Decision 5): this module imports no adapter.
 */
export interface WebAdapterChoice {
  /**
   * Google's own Cloud Storage, a Cloud Storage emulator in development and CI
   * (ADR-0159), the folder shared with the worker (ADR-0085), or this
   * process's own memory (ADR-0008).
   */
  readonly storage: "gcs" | "gcs-emulator" | "shared-folder" | "memory";
  /**
   * The ClamAV daemon `CLAMAV_HOST` names (ADR-0163, ADR-0164), or the test
   * scanner, which knows only the EICAR test file (ADR-0008).
   */
  readonly malwareScanner: "clamav" | "passthrough";
  /** The development outbox (ADR-0126), or none: then no email is sent (ADR-0129). */
  readonly email: "outbox" | "none";
  /** The offline analysis (ADR-0009). */
  readonly imageAnalysis: "deterministic";
  /** The offline check of a prompt against the preservation rules (ADR-0014). */
  readonly promptModeration: "offline";
}

/** A bucket is Google's, or with an endpoint an emulator's; the schema keeps an endpoint out of production. */
function storageOf(env: ServerEnv): WebAdapterChoice["storage"] {
  if (env.GOOGLE_CLOUD_STORAGE_BUCKET !== undefined) {
    return env.GOOGLE_CLOUD_STORAGE_ENDPOINT !== undefined ? "gcs-emulator" : "gcs";
  }
  return env.SHARED_STORAGE_DIR !== undefined ? "shared-folder" : "memory";
}

/** Which adapter serves each port, from the environment alone. Constructs nothing. */
export function chooseWebAdapters(env: ServerEnv): WebAdapterChoice {
  return {
    storage: storageOf(env),
    malwareScanner: env.CLAMAV_HOST !== undefined ? "clamav" : "passthrough",
    email: env.EMAIL_OUTBOX_DIR !== undefined ? "outbox" : "none",
    imageAnalysis: env.ANALYSIS_PROVIDER,
    promptModeration: "offline",
  };
}
