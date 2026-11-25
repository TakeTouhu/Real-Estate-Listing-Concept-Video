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
import { createLogger, type Logger } from "@app/observability";
import { AppError, GOOGLE_CLOUD_STORAGE_ORIGIN, type ServerEnv } from "@app/shared";
import { createGoogleCloudStorage } from "@app/storage/google-cloud-storage";
import { createSmtpEmailSender, type SmtpEmailSenderOptions } from "@app/storage/smtp";
import {
  assertNotProduction,
  LocalObjectStorage,
  PassthroughMalwareScanner,
  SharpImageProcessor,
  createClamAvScanner,
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

/** One plain word: capitals, digits and underscores, 40 at most (ADR-0164). */
const PLAIN_CODE = /^[A-Z0-9][A-Z0-9_]{0,39}$/;

let logger: Logger | undefined;
const log = (): Logger => (logger ??= createLogger({ base: { component: "malware-scan" } }));
let emailLogger: Logger | undefined;
const emailLog = (): Logger => (emailLogger ??= createLogger({ base: { component: "email" } }));

/**
 * A short code for why a scan did not end in a verdict: its `detail` when that
 * is one plain word, as the ClamAV adapter's codes are, and `UNEXPECTED`
 * otherwise, so no message, host or signature's name is logged (ADR-0164).
 */
export function scanFailureCode(detail: string | undefined): string {
  return detail !== undefined && PLAIN_CODE.test(detail) ? detail : "UNEXPECTED";
}

/**
 * The scanner, with each scan that ended `SCAN_FAILED` logged by its code: the
 * photo fails, and its owner sees only that the scan could not be completed.
 */
export function loggingScanFailures(scanner: MalwareScanner): MalwareScanner {
  return {
    async scan(data) {
      const result = await scanner.scan(data);
      if (result.verdict === "SCAN_FAILED") {
        try {
          log().warn("A malware scan could not be completed", { code: scanFailureCode(result.detail) });
        } catch {
          // The verdict stands whether or not the log could be written.
        }
      }
      return result;
    },
  };
}

/**
 * Why a send failed, as one word: the SMTP sender's code (`details.smtpCode`, from its allow-list or `UNKNOWN`,
 * ADR-0166 Decision 4) when it is one plain word, and `UNEXPECTED` otherwise, so no server reply, address or
 * message is logged (ADR-0168).
 */
export function emailFailureCode(error: unknown): string {
  const code = error instanceof AppError ? error.details?.smtpCode : undefined;
  return typeof code === "string" && PLAIN_CODE.test(code) ? code : "UNEXPECTED";
}

/** The sender, with each send that rejects logged by its code alone; the flow gets the same rejection. */
export function loggingEmailFailures(sender: EmailSender): EmailSender {
  return {
    async send(email) {
      try {
        await sender.send(email);
      } catch (error) {
        try {
          emailLog().warn("An email was not accepted for delivery", { code: emailFailureCode(error) });
        } catch {
          // The flow sees the send's own rejection whether or not the log could be written.
        }
        throw error;
      }
    },
  };
}

/**
 * The SMTP sender's settings, which the schema requires together with `SMTP_HOST` (ADR-0167). Kept in this file:
 * only it, `adapter-choice.ts` and the mailer may name an email sender (ADR-0150).
 */
function smtpOptions(env: ServerEnv): SmtpEmailSenderOptions {
  const { SMTP_HOST: host, SMTP_PORT: port, SMTP_TLS: tls, SMTP_USER: user, SMTP_PASSWORD: password } = env;
  const { SMTP_EHLO_NAME: ehloName, EMAIL_FROM: from } = env;
  if (
    host === undefined ||
    port === undefined ||
    tls === undefined ||
    user === undefined ||
    password === undefined ||
    ehloName === undefined ||
    from === undefined
  ) {
    // Only an environment the schema did not parse gets here; it is refused, never filled in.
    throw new AppError("CONFIGURATION_ERROR", "SMTP is chosen without each of its settings");
  }
  return { host, port: Number(port), tls, user, password, from, ehloName };
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
        // too: neither vouches for the other (ADR-0150 Decision 2), so development never asks Google's store
        // (ADR-0159).
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
    malwareScanner: once(() => {
      // The daemon is a production adapter, used wherever it is named; the test scanner refuses production.
      const host = env.CLAMAV_HOST;
      return loggingScanFailures(
        host !== undefined
          ? createClamAvScanner({ host, port: env.CLAMAV_PORT === undefined ? undefined : Number(env.CLAMAV_PORT) })
          : new PassthroughMalwareScanner({ nodeEnv: nodeEnv() }),
      );
    }),
    images: once(() => new SharpImageProcessor()),
    imageAnalysis: once(() => createImageAnalysisProvider(env)),
    promptModerator: once(() => createOfflinePromptModerator()),
    // Built for each email, opened only to send it. The SMTP sender is a production adapter, used wherever
    // SMTP_HOST names a server; the outbox refuses production when built.
    email: () => {
      if (choice.email === "smtp") return loggingEmailFailures(createSmtpEmailSender(smtpOptions(env)));
      return folder !== undefined ? createDevelopmentEmailOutbox({ folder, nodeEnv: nodeEnv() }) : null;
    },
  };
}

let adapters: WebAdapters | undefined;

/** The web app's adapters, from its configured environment. Server-only. */
export function getWebAdapters(): WebAdapters {
  return (adapters ??= createWebAdapters(getServerEnv()));
}
