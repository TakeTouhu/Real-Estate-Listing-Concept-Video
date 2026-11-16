import {
  createOfflinePromptModerator,
  type EmailSender,
  type ImageAnalysisProvider,
  type ImageProcessor,
  type MalwareScanner,
  type ObjectStorage,
  type PromptModerator,
} from "@app/domain";
import { createImageAnalysisProvider } from "@app/ai-providers";
import type { ServerEnv } from "@app/shared";
import {
  LocalObjectStorage,
  PassthroughMalwareScanner,
  SharpImageProcessor,
  createDevelopmentEmailOutbox,
  createSharedFolderStorage,
} from "@app/storage";
import { getServerEnv } from "./env";

/**
 * Every adapter the web app runs with, chosen in this one place from its
 * environment (RD-1, ADR-0150). A production adapter is one more choice here,
 * with no change to the services, routes or pages that use the port.
 */
export interface WebAdapterChoice {
  /** The folder shared with the worker (ADR-0085), or this process's own memory (ADR-0008). */
  readonly storage: "shared-folder" | "memory";
  /** The test scanner, which knows only the EICAR test file (ADR-0008). */
  readonly malwareScanner: "passthrough";
  /** The development outbox (ADR-0126), or none: then no email is sent (ADR-0129). */
  readonly email: "outbox" | "none";
  /** The offline analysis (ADR-0009). */
  readonly imageAnalysis: "deterministic";
  /** The offline check of a prompt against the preservation rules (ADR-0014). */
  readonly promptModeration: "offline";
}

/** Which adapter serves each port, from the environment alone. Constructs nothing. */
export function chooseWebAdapters(env: ServerEnv): WebAdapterChoice {
  return {
    storage: env.SHARED_STORAGE_DIR !== undefined ? "shared-folder" : "memory",
    malwareScanner: "passthrough",
    email: env.EMAIL_OUTBOX_DIR !== undefined ? "outbox" : "none",
    imageAnalysis: env.ANALYSIS_PROVIDER,
    promptModeration: "offline",
  };
}

/** The web app's adapters. Each is built when first asked for, then kept. */
export interface WebAdapters {
  readonly choice: WebAdapterChoice;
  readonly storage: () => ObjectStorage;
  readonly malwareScanner: () => MalwareScanner;
  readonly images: () => ImageProcessor;
  readonly imageAnalysis: () => ImageAnalysisProvider;
  readonly promptModerator: () => PromptModerator;
  /**
   * The email sender for one message, opened only to send it, or `null` when
   * no email is configured.
   */
  readonly email: () => EmailSender | null;
}

function once<T>(build: () => T): () => T {
  let built: { readonly value: T } | undefined;
  return () => (built ??= { value: build() }).value;
}

/** The adapters `env` chooses (`chooseWebAdapters`). */
export function createWebAdapters(env: ServerEnv): WebAdapters {
  const choice = chooseWebAdapters(env);
  const secret = env.STORAGE_SIGNING_SECRET;
  const folder = env.EMAIL_OUTBOX_DIR;
  // A development adapter refuses production by the configured value or the
  // ambient one when it is built: neither can vouch for the other (ADR-0085).
  const nodeEnv = () => (process.env.NODE_ENV === "production" ? "production" : env.NODE_ENV);
  return {
    choice,
    storage: once(() =>
      env.SHARED_STORAGE_DIR !== undefined
        ? createSharedFolderStorage({ root: env.SHARED_STORAGE_DIR, secret, nodeEnv: nodeEnv() }).objectStorage
        : new LocalObjectStorage({ secret, nodeEnv: nodeEnv() }),
    ),
    malwareScanner: once(() => new PassthroughMalwareScanner({ nodeEnv: nodeEnv() })),
    images: once(() => new SharpImageProcessor()),
    imageAnalysis: once(() => createImageAnalysisProvider(env)),
    promptModerator: once(() => createOfflinePromptModerator()),
    email: () => (folder !== undefined ? createDevelopmentEmailOutbox({ folder, nodeEnv: nodeEnv() }) : null),
  };
}

let adapters: WebAdapters | undefined;

/** The web app's adapters, from its configured environment. Server-only. */
export function getWebAdapters(): WebAdapters {
  return (adapters ??= createWebAdapters(getServerEnv()));
}
