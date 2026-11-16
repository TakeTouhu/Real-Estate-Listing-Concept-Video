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
import { chooseWebAdapters, type WebAdapterChoice } from "./adapter-choice";
import { getServerEnv } from "./env";

/**
 * The web app's adapters, as its environment chooses them (`adapter-choice.ts`;
 * RD-1, ADR-0150). Each is built when first asked for, then kept.
 */
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
