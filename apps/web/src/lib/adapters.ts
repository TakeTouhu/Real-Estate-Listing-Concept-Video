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
import { AppError, GOOGLE_CLOUD_STORAGE_ORIGIN, type ServerEnv } from "@app/shared";
import { createGoogleCloudStorage } from "@app/storage/google-cloud-storage";
import {
  assertNotProduction,
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
    storage: once(() => {
      const bucket = env.GOOGLE_CLOUD_STORAGE_BUCKET;
      const endpoint = env.GOOGLE_CLOUD_STORAGE_ENDPOINT;
      if (bucket !== undefined && endpoint === undefined) {
        // Google's own store, with the process's token, is a production build's alone. The schema allows a
        // bucket with no endpoint only where the configured value says production, and the ambient value must
        // too: neither vouches for the other (ADR-0150 Decision 2), so development never asks Google (ADR-0159).
        if (env.NODE_ENV !== "production" || process.env.NODE_ENV !== "production") {
          throw new AppError("CONFIGURATION_ERROR", "Google's own Cloud Storage is used only by a production build");
        }
        return createGoogleCloudStorage({ bucket, endpoint: GOOGLE_CLOUD_STORAGE_ORIGIN, secret });
      }
      if (bucket !== undefined && endpoint !== undefined) {
        // An emulator refuses production by either value, as each development adapter does (ADR-0085).
        assertNotProduction(
          "GoogleCloudStorageEmulator",
          "objects are kept by the emulator the endpoint names, for development and CI",
          "set GOOGLE_CLOUD_STORAGE_BUCKET alone, for Google's own Cloud Storage",
          { nodeEnv: nodeEnv() },
        );
        // The schema refuses Google's domain here; the adapter would send Google's origin the process's token.
        if (URL.canParse(endpoint) && new URL(endpoint).origin === GOOGLE_CLOUD_STORAGE_ORIGIN) {
          throw new AppError("CONFIGURATION_ERROR", "A Cloud Storage emulator cannot be Google's own store");
        }
        return createGoogleCloudStorage({ bucket, endpoint, secret });
      }
      return env.SHARED_STORAGE_DIR !== undefined
        ? createSharedFolderStorage({ root: env.SHARED_STORAGE_DIR, secret, nodeEnv: nodeEnv() }).objectStorage
        : new LocalObjectStorage({ secret, nodeEnv: nodeEnv() });
    }),
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
